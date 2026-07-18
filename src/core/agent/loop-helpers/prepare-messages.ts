/**
 * F103 loop-helpers decomposition — pre-call message preparation (LAYER 0-5:
 * flush reminder, two-tier compaction trigger, snip, sliding window, context
 * collapse, pairing repair) plus the turn-mutation digests.
 *
 * Moved verbatim from the former monolithic src/core/agent/loop-helpers.ts.
 * See ../loop-helpers.ts (barrel) for the full submodule map.
 */

import { createLogger } from '../../shared/logger.js';
import { microCompact } from '../compaction.js';
import { microCompactMessages, type MicroCompactMessage } from '../microcompact.js';
import { shouldCompact, estimateContextSize, MAX_CONTEXT_TOKENS } from '../context.js';
import { PRE_COMPACTION_FLUSH, PRE_COMPACTION_FLUSH_THRESHOLD } from '../../shared/constants.js';
import type { AgentState } from '../types.js';
import type { BrainMessage, BrainLike, SessionLike, Emitter, HookEmitterLike } from './types.js';
import {
  runCompaction,
  sanitizeToolPairing,
  escalateCompaction,
  _hasFlushReminder as hasFlushReminder,
  _MEMORY_FLUSH_MESSAGE as MEMORY_FLUSH_MESSAGE,
  type PreCompactionFlush,
} from './context-fold.js';

const log = createLogger('agent:loop');

// ---------------------------------------------------------------------------
// Layer 4 — Context collapse: intelligent tool result compression
// ---------------------------------------------------------------------------

/**
 * Intelligently compress verbose tool results instead of dumb truncation.
 * Recognises high-noise patterns (tsc errors, file listings, search results)
 * and replaces them with compact summaries that preserve the signal.
 */
function collapseToolResults(messages: BrainMessage[]): BrainMessage[] {
  return messages.map((msg): BrainMessage => {
    if (msg.role !== 'tool') return msg;

    const content = msg.content;
    if (typeof content !== 'string' || content.length <= 2000) return msg;

    const collapsed = collapseContent(content, msg.toolName ?? '');
    if (collapsed !== content) {
      log.debug({ tool: msg.toolName, before: content.length, after: collapsed.length }, 'Layer 4: tool result collapsed');
    }
    return { ...msg, content: collapsed };
  });
}

export function collapseContent(content: string, toolName: string): string {
  const MAX = 3000;
  // Reading source whole is a first-class need (self-edit, review), so file
  // reads keep far more than other tool output before paging — a typical
  // module (~400 lines) arrives intact in one read; beyond this the agent
  // pages with offset/limit.
  const MAX_READ = 16000;
  if (content.length <= MAX) return content;

  // Pattern 1: TypeScript error lists (tsc output)
  if (toolName.includes('typecheck') || content.includes('error TS')) {
    const errorLines = content.split('\n').filter(l => l.includes('error TS'));
    if (errorLines.length > 0) {
      const summary = `[TypeScript: ${errorLines.length} error(s)]\n${errorLines.slice(0, 10).join('\n')}${errorLines.length > 10 ? `\n... +${errorLines.length - 10} more` : ''}`;
      return summary;
    }
  }

  // Pattern 2: File listings / directory trees
  if (toolName.includes('glob') || toolName.includes('list') || toolName.includes('map')) {
    const lines = content.split('\n');
    if (lines.length > 40) {
      return `[${lines.length} items]\n${lines.slice(0, 30).join('\n')}\n... +${lines.length - 30} more`;
    }
  }

  // Pattern 3: Search results (grep)
  if (toolName.includes('grep') || toolName.includes('search')) {
    const lines = content.split('\n');
    if (lines.length > 50) {
      return `[${lines.length} matches]\n${lines.slice(0, 25).join('\n')}\n... +${lines.length - 25} more`;
    }
  }

  // Pattern 4: Large file read contents. meta.self-modify is the self-edit
  // reader (read-file action), so it counts as a read tool here too.
  if (toolName.includes('read') || toolName.includes('multi') || toolName.includes('self-modify')) {
    if (content.length > MAX_READ) {
      return content.slice(0, MAX_READ) + `\n\n[...${content.length - MAX_READ} chars collapsed — read the rest with a targeted offset/limit range]`;
    }
    return content;
  }

  // Default: hard cap at MAX
  return content.slice(0, MAX) + `\n\n[...${content.length - MAX} chars truncated]`;
}

// ---------------------------------------------------------------------------
// Pre-call preparation helper
// ---------------------------------------------------------------------------

/**
 * Optionally compact the session if context is approaching limits, then
 * trim oversized tool results. Returns the trimmed message array to send.
 *
 * @param brain    - Brain-like for compaction if needed.
 * @param session  - Session whose messages will be prepared.
 * @param state    - Agent state.
 * @param emit     - Event emitter.
 * @returns Trimmed copy of session messages ready for the LLM call.
 */

/**
 * Digest the file-mutating tool calls made so far in the current turn, so a long
 * turn whose early edits were evicted by the sliding window can still see what
 * it already did. Returns a deduped list of human-readable "path (tool action)"
 * labels, newest occurrence kept once. Empty when the turn changed no files.
 */
export function extractTurnMutations(
  turnMsgs: Array<{ role: string; toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }> }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of turnMsgs) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      const name = tc.name ?? '';
      const args = tc.arguments ?? {};
      const action = typeof args['action'] === 'string' ? (args['action'] as string) : '';
      const isMutation =
        /write-file|smart-edit|apply-patch|create-file|edit-file/.test(name) ||
        (name === 'meta.self-modify' && /edit-file|write-file|edit-config|full-cycle/.test(action)) ||
        (/github/.test(name) && /commit|push|open_pr/.test(name));
      if (!isMutation) continue;
      const rawPath = args['path'] ?? args['filePath'] ?? args['file'];
      const label = typeof rawPath === 'string' && rawPath ? rawPath : (action || name);
      const key = `${name}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${label} (${name}${action ? ` ${action}` : ''})`);
    }
  }
  return out;
}

/**
 * Ship-signal classification for the completion guard (trigger B: edit-without-ship).
 * Scans this turn's assistant tool CALLS — where the arguments (path + action) live,
 * unlike tool results — to decide two things:
 *
 *  - `editedSrcOrTest`: a code change landed under `src/` or `tests/` (the kind of
 *    edit that normally ships as a PR). Counts `coder.*` write/edit tools and
 *    `meta.self-modify` write-file/edit-file. Deliberately scoped to src/tests so
 *    workspace/memory scratch edits and config tweaks do NOT trip the guard.
 *  - `deployed`: the turn ran `meta.self-modify` restart/full-cycle — a self-deploy
 *    to the live daemon, which legitimately needs no PR. This excludes the edit from
 *    the ship nudge (build/test are NOT deploy signals: they are shared with the
 *    pre-PR verify path, so a turn that edits + tests but forgets to commit still
 *    gets nudged).
 *
 * Commit/PR detection stays on tool RESULTS in the guard itself, because a PR's
 * success is only knowable from the result string ("Opened PR #N").
 */
export function classifyShipEditSignals(
  turnMsgs: Array<{ role: string; toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }> }>,
): { editedSrcOrTest: boolean; deployed: boolean } {
  let editedSrcOrTest = false;
  let deployed = false;
  for (const m of turnMsgs) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      const name = tc.name ?? '';
      const args = tc.arguments ?? {};
      const action = typeof args['action'] === 'string' ? (args['action'] as string) : '';
      // Tool names appear in live history BOTH bare ("write-file", "self-modify")
      // AND category-prefixed ("coder.write-file", "meta.self-modify"), so match by
      // substring — the proven style of extractTurnMutations above. An anchored
      // /^coder\.…$/ silently missed the live bare names (caught in a live drill:
      // the model emitted "write-file", the guard never fired).
      const isSelfModify = /self-modify/.test(name);
      if (isSelfModify && /^(restart|full-cycle)$/.test(action)) {
        deployed = true;
      }
      const isCodeEdit =
        /write-file|edit-file|smart-edit|multi-edit|apply-patch|create-file|notebook-edit/.test(name) ||
        (isSelfModify && /^(write-file|edit-file)$/.test(action));
      if (!isCodeEdit) continue;
      const rawPath = args['path'] ?? args['filePath'] ?? args['file'];
      const p = typeof rawPath === 'string' ? rawPath : '';
      if (/(^|\/)(src|tests)\//.test(p)) editedSrcOrTest = true;
    }
  }
  return { editedSrcOrTest, deployed };
}

/**
 * Remove, in place, any prior `[AlignmentAggregator]` advisory system messages.
 * The owner-loyalty check runs every loop iteration and pushes a near-identical
 * YELLOW/RED advisory each time; left to accumulate, those most-recent
 * duplicates fill the system-message window (keptSystem = first + last two),
 * evicting the turn's actual task guidance. Call this right before pushing a
 * fresh advisory so at most one is ever in context — always the latest.
 */
export function dropPriorAlignmentAdvisories(
  messages: Array<{ role: string; content?: unknown }>,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[AlignmentAggregator]')) {
      messages.splice(i, 1);
    }
  }
}

export async function prepareMessages(
  brain: BrainLike,
  session: SessionLike,
  state: AgentState,
  emit: Emitter,
  hooks?: HookEmitterLike,
  preFlush?: PreCompactionFlush,
): Promise<BrainMessage[]> {
  // LAYER 0 — PRE-COMPACTION FLUSH REMINDER
  // At 40 % of MAX_CONTEXT_TOKENS (below the 50 % shouldCompact threshold), inject a
  // system reminder so the agent has one full turn to write important context to
  // workspace/memory/ files before the history is replaced by a compaction summary.
  if (PRE_COMPACTION_FLUSH && !hasFlushReminder(session.messages as BrainMessage[])) {
    const estimatedTokens = estimateContextSize(session.messages as Array<{ content: string }>);
    const flushThreshold = MAX_CONTEXT_TOKENS * PRE_COMPACTION_FLUSH_THRESHOLD;
    if (estimatedTokens >= flushThreshold) {
      session.messages.push({ role: 'system', content: MEMORY_FLUSH_MESSAGE });
      log.info(
        { sessionId: state.sessionId, estimatedTokens, flushThreshold },
        'LAYER 0: Pre-compaction memory flush reminder injected',
      );
    }
  }

  // TIER 1 — Two-tier compaction (gap #14, default ON; SUDO_TWO_TIER_COMPACT=0 disables):
  // zero-cost, role-aware microcompact runs BEFORE the LLM-based LAYER 1 so
  // we skip the paid round-trip when shrinking middle tool outputs is enough
  // to fall back below shouldCompact's threshold. Default ON (matches the prod
  // ecosystem config); SUDO_TWO_TIER_COMPACT=0 disables. Fail-open.
  // LAYER 1's existing shouldCompact() check re-runs against the trimmed
  // history, so a sufficient TIER 1 pass naturally suppresses LAYER 1.
  if (
    process.env['SUDO_TWO_TIER_COMPACT'] !== '0' &&
    shouldCompact(session.messages as Array<{ content: string }>)
  ) {
    try {
      const result = microCompactMessages(
        session.messages as MicroCompactMessage[],
      );
      if (result.charsAfter < result.charsBefore) {
        session.messages = result.messages as typeof session.messages;
        log.info(
          {
            sessionId: state.sessionId,
            charsBefore: result.charsBefore,
            charsAfter: result.charsAfter,
            recoveredChars: result.charsBefore - result.charsAfter,
            clamped: result.clamped,
          },
          'TIER 1: zero-cost microcompact applied (gap #14)',
        );
      }
    } catch (err) {
      log.warn(
        { sessionId: state.sessionId, err: String(err) },
        'TIER 1 microcompact threw — falling through to LAYER 1',
      );
    }
  }

  // LAYER 1 — PROACTIVE compaction: summarise BEFORE hitting the limit (at 50% capacity)
  // This prevents the model from ever seeing a truncated context.
  if (shouldCompact(session.messages as Array<{ content: string }>)) {
    log.info({ sessionId: state.sessionId }, 'LAYER 1: Proactive compaction triggered');
    await runCompaction(brain, session, state, emit, hooks, preFlush);
  }

  // TIER 2 / TIER 3 — compaction escalation (gap #14 deferred). Opt-in
  // SUDO_COMPACT_ESCALATE=1. Default OFF, fail-open. Only fires when LAYER 1's
  // summary (or LAYER 1 itself being off) leaves the history above
  // shouldCompact's threshold — wiring the latent autoCompact/fullCompact paths
  // so heavy sessions escalate instead of relying on LAYER 2/3 to clip alone.
  if (process.env['SUDO_COMPACT_ESCALATE'] === '1') {
    await escalateCompaction(brain, session, state);
  }

  // LAYER 2 — SNIP: micro-compact the in-memory history (zero API cost, pure JS)
  // Keeps head (first 2) and tail (last 8), trims middle to 200 chars each.
  const MAX_SNIP_CHARS = 200_000;
  const totalChars = session.messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  if (totalChars > MAX_SNIP_CHARS && session.messages.length > 10) {
    log.info({ sessionId: state.sessionId, totalChars }, 'LAYER 2: Snip compaction applied');
    const snipped = microCompact(
      session.messages.map(m => m.content ?? ''),
      MAX_SNIP_CHARS,
    );
    // Re-attach roles after micro-compact
    session.messages = session.messages.map((m, i) => ({
      ...m,
      content: snipped[i] ?? m.content,
    }));
  }

  // LAYER 3 — SLIDING WINDOW: keep system messages + last WINDOW_SIZE non-system
  // messages. Default 12 suits ~200k-context models (Opus navigates it fine). A
  // large-context model (e.g. glm-5.2 at 1M tokens) instead re-reads files the
  // window evicted and thrashes into the LoopGuard / iteration cap ("stuck in a
  // loop") — give it more memory via SUDO_AGENT_WINDOW_SIZE. Clamped [4,200];
  // fail-open to 12 on a malformed value so default behaviour is byte-identical.
  const WINDOW_SIZE = (() => {
    const raw = parseInt(process.env['SUDO_AGENT_WINDOW_SIZE'] ?? '', 10);
    return Number.isFinite(raw) && raw >= 4 && raw <= 200 ? raw : 12;
  })();
  const systemMsgs = session.messages.filter(m => m.role === 'system');
  const nonSystemMsgs = session.messages.filter(m => m.role !== 'system');
  let windowedNonSystem = nonSystemMsgs.slice(-WINDOW_SIZE);
  // Never start the window on an orphaned tool result: a role:'tool' message's
  // declaring assistant (with toolCalls) is the message immediately before it.
  // If the slice boundary fell inside a tool-call group, the leading tool-result
  // messages have no matching assistant tool_call, and the Vercel AI SDK's
  // convertToLanguageModelPrompt throws AI_MissingToolResultsError on the next
  // brain.call(). Advance the start past any leading orphan tool results.
  let firstNonOrphan = 0;
  while (firstNonOrphan < windowedNonSystem.length && windowedNonSystem[firstNonOrphan]!.role === 'tool') {
    firstNonOrphan++;
  }
  if (firstNonOrphan > 0) {
    windowedNonSystem = windowedNonSystem.slice(firstNonOrphan);
  }
  // Always retain the CURRENT turn's user instruction. A turn with many tool
  // calls produces more than WINDOW_SIZE assistant/tool messages, so the
  // slice(-WINDOW_SIZE) above evicts the user message that STARTED the turn —
  // leaving the model with no instruction. It then concludes "no instruction
  // came through" and stops (observed on a real web turn: 16 non-system
  // messages, user message dropped). If the most recent user message fell
  // outside the window, prepend it so the instruction always survives.
  const currentUserMsg = [...nonSystemMsgs].reverse().find(m => m.role === 'user');
  if (currentUserMsg && !windowedNonSystem.includes(currentUserMsg)) {
    windowedNonSystem = [currentUserMsg, ...windowedNonSystem];
  }
  // LONG-TURN WORK ANCHOR: a turn with many tool calls evicts the agent's OWN
  // earlier file edits from the window, so it can lose track of work it already
  // did and disown it ("none of those files exist / no change was made") then
  // stop. When the window actually dropped messages, surface a compact digest
  // of the file-mutating actions taken THIS turn so the agent continues from
  // its work (verify/test/commit) instead of restarting or abandoning it.
  if (nonSystemMsgs.length > WINDOW_SIZE) {
    const turnStart = currentUserMsg ? nonSystemMsgs.indexOf(currentUserMsg) : -1;
    const turnMsgs = turnStart >= 0 ? nonSystemMsgs.slice(turnStart + 1) : nonSystemMsgs;
    const mutations = extractTurnMutations(turnMsgs);
    if (mutations.length > 0) {
      const digest: BrainMessage = {
        role: 'system',
        content:
          '[Work you have ALREADY done earlier in THIS turn — continue from it, do not repeat or disown it]\n'
          + 'Files you have changed this turn (real edits, on disk):\n'
          + mutations.map(m => `- ${m}`).join('\n')
          + '\nVerify/test/commit these as the next step; do NOT conclude the task is unstarted.',
      };
      // Insert right after the retained user instruction so it reads as turn context.
      const insertAt = windowedNonSystem[0] === currentUserMsg ? 1 : 0;
      windowedNonSystem.splice(insertAt, 0, digest);
    }
  }
  // Keep the FIRST system message (any durable session-level header) PLUS the
  // most RECENT system guidance. The old `slice(0, 2)` kept the OLDEST two: in a
  // multi-turn session, ephemeral per-turn guidance (auto-plan's PLAN, the
  // negative router's AUTO-ROUTING) accumulates as system messages, so the
  // current turn's fresh guidance was shadowed by stale turn-1 copies — the
  // agent saw a plan for a PREVIOUS request. Retaining index 0 + the last two
  // preserves any persistent header while letting current guidance through.
  // (When length > 3, index 0 never overlaps the last two, so no dedup needed.)
  const keptSystem = systemMsgs.length <= 3
    ? systemMsgs
    : [systemMsgs[0]!, ...systemMsgs.slice(-2)];
  const windowed: BrainMessage[] = [
    ...keptSystem,
    ...windowedNonSystem,
  ];

  if (nonSystemMsgs.length > WINDOW_SIZE) {
    log.info(
      {
        sessionId: state.sessionId,
        totalMessages: session.messages.length,
        windowedMessages: windowed.length,
        droppedMessages: nonSystemMsgs.length - windowedNonSystem.length,
      },
      'LAYER 3: Sliding window applied',
    );
  }

  // LAYER 4 — CONTEXT COLLAPSE: intelligently compress verbose tool results
  // Instead of dumb truncation, identify high-noise patterns and summarise them.
  // LAYER 5 — TOOL PAIRING: authoritative ID-based repair after all truncation,
  // so no orphaned tool_use/tool_result can reach the provider (belt-and-suspenders
  // over the positional trim above).
  return sanitizeToolPairing(collapseToolResults(windowed) as BrainMessage[]);
}
