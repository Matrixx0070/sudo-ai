/**
 * F103 loop-helpers decomposition — context compaction: verbatim tail,
 * pinned goal, tool_use/tool_result pairing repair, runCompaction, the memory
 * flush reminder, and TIER 2/3 compaction escalation.
 *
 * Moved verbatim from the former monolithic src/core/agent/loop-helpers.ts.
 * See ../loop-helpers.ts (barrel) for the full submodule map.
 */

import { createLogger } from '../../shared/logger.js';
import { compact, autoCompact, fullCompact, type AutoCompactFailureCounter } from '../compaction.js';
import { shouldCompact, estimateContextSize, MAX_CONTEXT_TOKENS } from '../context.js';
import { PRE_COMPACTION_FLUSH } from '../../shared/constants.js';
import type { AgentState } from '../types.js';
import type { BrainMessage, BrainLike, SessionLike, Emitter, HookEmitterLike } from './types.js';
import { _safeEmit as safeEmit } from './tool-exec.js';

const log = createLogger('agent:loop');

// ---------------------------------------------------------------------------
// Compaction helper
// ---------------------------------------------------------------------------

/**
 * Run context compaction on a session and replace its message history.
 *
 * @param brain   - Brain-like object used to produce the summary.
 * @param session - Session whose messages will be compacted.
 * @param state   - Agent state (isCompacting flag updated in place).
 * @param emit    - Event emitter for compaction event.
 * @param hooks   - Optional hook emitter for lifecycle events.
 * @returns The compaction summary string, or '' on failure.
 */
/** Default count of recent non-system messages kept verbatim through compaction. */
const COMPACT_TAIL_DEFAULT = 6;

/**
 * Select the trailing non-system messages to keep verbatim across a compaction.
 *
 * Historically `runCompaction` replaced the ENTIRE history with a single
 * summary system message, so the current in-flight user ask and recent turns
 * survived only as summary prose — a bad/incomplete summary could erase the
 * request the user is waiting on. This keeps the last `k` non-system messages
 * intact alongside the summary (OpenClaw's splitPreservedRecentTurns model).
 *
 * Two invariants, mirroring the LAYER-3 sliding window:
 *  - never start the tail on an orphan `tool` result (its declaring assistant
 *    would be gone → AI_MissingToolResultsError on the next brain.call);
 *  - always retain the most recent `user` message, so the in-flight ask
 *    survives even when the tail is small or orphan-trimmed.
 */
export function selectVerbatimTail(messages: BrainMessage[], k: number): BrainMessage[] {
  const nonSystem = messages.filter((m) => m.role !== 'system');
  // k<=0 must yield an EMPTY slice: slice(-0) === slice(0) returns the FULL
  // history, silently defeating summary-only compaction. The last-user
  // invariant below still re-adds the in-flight ask.
  let tail = k > 0 ? nonSystem.slice(-k) : [];
  let firstNonOrphan = 0;
  while (firstNonOrphan < tail.length && tail[firstNonOrphan]!.role === 'tool') {
    firstNonOrphan++;
  }
  if (firstNonOrphan > 0) tail = tail.slice(firstNonOrphan);
  const lastUser = [...nonSystem].reverse().find((m) => m.role === 'user');
  if (lastUser && !tail.includes(lastUser)) tail = [lastUser, ...tail];
  return tail;
}

/** Max chars of the pinned goal (keep it small — it's kept verbatim forever). */
const PINNED_GOAL_MAX_CHARS = 2000;

/** Marker for the pinned-goal system message so it survives repeated folds. */
export const PINNED_GOAL_PREFIX = '[Pinned goal — original user request]';

/**
 * Pin the FIRST user message (the original goal) verbatim across compaction
 * (Spec 7 acceptance #2 — "first user task still reflected"). Returns it as a
 * pinned system message so a bad/incomplete summary can NEVER erase the goal —
 * the compacted history becomes [pinnedGoal, summary, …recentTail].
 *
 * MULTI-COMPACT: after the first fold the original user turn is gone — only the
 * pinned-goal SYSTEM message remains. On every subsequent compaction we carry
 * that existing pin FORWARD (rather than re-searching for a user turn, which
 * would latch onto a recent tail message), so the verbatim guarantee holds
 * across the repeated folds of acceptance #5, not just the first one.
 *
 * Returns [] when there's no user message, or when the first user message is
 * already in the verbatim tail (short session — avoid duplicating it).
 */
export function selectPinnedGoal(messages: BrainMessage[], tail: BrainMessage[]): BrainMessage[] {
  // Carry an already-pinned goal forward (system messages never appear in the
  // non-system tail, so this can't duplicate).
  const existing = messages.find(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(PINNED_GOAL_PREFIX),
  );
  if (existing) return [existing];

  const firstUser = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0);
  if (!firstUser || tail.includes(firstUser)) return [];
  const goal = String(firstUser.content).slice(0, PINNED_GOAL_MAX_CHARS);
  return [{ role: 'system', content: `${PINNED_GOAL_PREFIX}\n${goal}` }];
}
/** Placeholder inserted for a tool call whose result was truncated away. */
export const TRUNCATED_TOOL_RESULT_PLACEHOLDER =
  '[tool result unavailable — dropped by context truncation]';

/**
 * Enforce tool_use/tool_result pairing by ID after any history truncation.
 *
 * The sliding window and the compaction tail keep the message array valid with
 * POSITIONAL heuristics (trim a leading `role:'tool'` orphan). That assumes tool
 * results always sit contiguously right after their declaring assistant — true
 * today, but fragile: an interior orphan, a reordering nudge, or a parallel/async
 * tool whose result never landed would still ship an unpaired array, and the
 * provider throws mid-turn (Vercel AI SDK `AI_MissingToolResultsError`; Anthropic
 * "tool_use ids were found without tool_result blocks"). This is the ID-based
 * final pass OpenClaw runs after truncation — it catches BOTH directions:
 *
 *  - orphan tool_result (no earlier assistant declared its `toolCallId`) → dropped;
 *  - orphan tool_use (an assistant `toolCalls[].id` with no matching result kept
 *    anywhere in the window) → a synthetic placeholder result is inserted right
 *    after the assistant so every declared call is answered exactly once.
 *
 * Pure and order-preserving; never throws. Cheap enough to run every turn.
 */
export function sanitizeToolPairing(messages: BrainMessage[]): BrainMessage[] {
  // Ids that have a result somewhere in the input — so we only synthesize a
  // placeholder for calls whose result is genuinely absent, not merely later.
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) resultIds.add(m.toolCallId);
  }

  const out: BrainMessage[] = [];
  const declaredIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      // Drop a tool result whose declaring assistant is not in the kept window.
      if (m.toolCallId && declaredIds.has(m.toolCallId)) out.push(m);
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      out.push(m);
      for (const tc of m.toolCalls) {
        declaredIds.add(tc.id);
        if (!resultIds.has(tc.id)) {
          out.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: TRUNCATED_TOOL_RESULT_PLACEHOLDER,
          });
          // Guard against a second synthetic if the same id is declared again.
          resultIds.add(tc.id);
        }
      }
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Persist salient facts from the conversation before it is compacted away.
 * Injected into the loop (setPreCompactionFlush) and invoked by runCompaction.
 * Must be fail-open — it never blocks compaction.
 */
export type PreCompactionFlush = (messages: BrainMessage[]) => Promise<void>;

/**
 * Whether the history holds any REAL conversation turn (a non-empty user,
 * assistant, or tool message) — as opposed to only system scaffolding (briefs,
 * routing, flush reminders). Compacting a scaffolding-only history burns a
 * high-stakes summariser call and destroys what little structure exists into a
 * lossy stub, so runCompaction skips it.
 */
function hasRealConversation(messages: BrainMessage[]): boolean {
  return messages.some(
    (m) =>
      (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0,
  );
}

/** Approx char size of a message array — a cheap proxy for context size. */
function approxContextChars(messages: BrainMessage[]): number {
  return messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
}

export async function runCompaction(
  brain: BrainLike,
  session: SessionLike,
  state: AgentState,
  emit: Emitter,
  hooks?: HookEmitterLike,
  preFlush?: PreCompactionFlush,
): Promise<string> {
  state.isCompacting = true;

  log.info({ sessionId: state.sessionId, messageCount: session.messages.length }, 'Compacting context');

  // SKIP GUARD — nothing worth a high-stakes summariser call: a history of only
  // system scaffolding with no real user/assistant/tool turn. Bail cleanly rather
  // than pay for an LLM call that would replace structured context with a stub.
  if (!hasRealConversation(session.messages as BrainMessage[])) {
    log.info(
      { sessionId: state.sessionId, messageCount: session.messages.length },
      'Compaction skipped — no real conversation messages to compact',
    );
    state.isCompacting = false;
    return '';
  }

  // PROGRAMMATIC PRE-COMPACTION FLUSH — persist salient facts to memory BEFORE
  // compact() replaces the history, so state survives regardless of whether the
  // model acted on the flush *reminder* below. Fail-open AND time-bounded: the
  // flush can do embed/judge LLM calls (when SUDO_CHUNK_CONTRADICT=1) on this hot
  // path, so a hang must degrade to a skipped flush, not a stalled turn. The
  // flush keeps running in the background; only our wait is bounded.
  if (preFlush) {
    const flushTimeoutMs = (() => {
      const raw = parseInt(process.env['SUDO_PRECOMPACTION_FLUSH_TIMEOUT_MS'] ?? '', 10);
      return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('pre-compaction flush timed out')), flushTimeoutMs);
    });
    try {
      await Promise.race([preFlush(session.messages as BrainMessage[]), timeout]);
    } catch (err) {
      log.warn({ sessionId: state.sessionId, err: String(err) }, 'Pre-compaction flush failed/timed out — continuing');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // PRE-COMPACTION FLUSH (covers the finishReason === 'length' path that skips prepareMessages).
  // The flush message is appended to the history that compact() summarises, so the summary
  // produced by the LLM will include "save important facts" as an action item — prompting the
  // agent to persist context on the very next turn after compaction.
  if (PRE_COMPACTION_FLUSH && !hasFlushReminder(session.messages as BrainMessage[])) {
    session.messages.push({ role: 'system', content: MEMORY_FLUSH_MESSAGE });
    log.info(
      { sessionId: state.sessionId },
      'Pre-compaction flush reminder appended before compact() call',
    );
  }

  const hookBase = { sessionId: state.sessionId };
  await safeEmit(hooks, 'before_compaction', hookBase);
  await safeEmit(hooks, 'session:compact:before', hookBase);

  const beforeChars = approxContextChars(session.messages as BrainMessage[]);
  let compactionSucceeded = false;
  try {
    // SAFETY TIMEOUT — the summariser is one brain.call to a possibly-slow/hung
    // provider on the hot turn path. Bound it so a stall degrades to "continue
    // without compaction" (the catch below) instead of freezing the whole turn.
    const compactTimeoutMs = (() => {
      const raw = parseInt(process.env['SUDO_COMPACTION_TIMEOUT_MS'] ?? '', 10);
      return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
    })();
    let cTimer: ReturnType<typeof setTimeout> | undefined;
    const cTimeout = new Promise<never>((_, reject) => {
      cTimer = setTimeout(
        () => reject(new Error(`compaction summariser timed out after ${compactTimeoutMs}ms`)),
        compactTimeoutMs,
      );
    });
    let summary: string;
    try {
      summary = await Promise.race([compact(brain, session.messages), cTimeout]);
    } finally {
      if (cTimer) clearTimeout(cTimer);
    }
    compactionSucceeded = true;

    const summaryMsg: BrainMessage = { role: 'system', content: `[Context compacted]\n\n${summary}` };
    // Preserve the recent conversation verbatim alongside the summary so a
    // bad/incomplete summary can't erase the in-flight ask (default ON;
    // SUDO_COMPACT_PRESERVE_TAIL=0 restores the legacy summary-only replace).
    if (process.env['SUDO_COMPACT_PRESERVE_TAIL'] !== '0') {
      const k = (() => {
        const raw = parseInt(process.env['SUDO_COMPACT_TAIL_COUNT'] ?? '', 10);
        return Number.isFinite(raw) && raw >= 2 && raw <= 40 ? raw : COMPACT_TAIL_DEFAULT;
      })();
      const tail = selectVerbatimTail(session.messages as BrainMessage[], k);
      // Pin the original user goal verbatim so a bad summary can't drop it.
      const pinned = selectPinnedGoal(session.messages as BrainMessage[], tail);
      // ID-based pairing repair on the summary+tail: the verbatim tail can keep an
      // assistant tool_call whose result fell outside the tail window (or drop a
      // result whose declaring assistant did), which the positional trim in
      // selectVerbatimTail cannot fully catch. Guarantees a provider-valid array.
      session.messages = sanitizeToolPairing([...pinned, summaryMsg, ...tail]);
      log.info(
        { sessionId: state.sessionId, summaryLen: summary.length, tailKept: tail.length, goalPinned: pinned.length > 0 },
        'Compaction complete (verbatim tail preserved)',
      );
    } else {
      // Legacy summary-only mode (kill-switch) stays literally summary-only.
      session.messages = [summaryMsg];
      log.info({ sessionId: state.sessionId, summaryLen: summary.length }, 'Compaction complete');
    }

    // TOKEN-AFTER SANITY — flag the false-success case where the summary+tail is
    // NOT smaller than what it replaced (a pathologically long summary). Left
    // undetected, the loop believes it freed context and can re-enter compaction
    // at the same fill. Observability-only; the reduction still applies.
    const afterChars = approxContextChars(session.messages as BrainMessage[]);
    if (afterChars >= beforeChars) {
      log.warn(
        { sessionId: state.sessionId, beforeChars, afterChars },
        'Compaction did not reduce context size (summary+tail >= original) — check summariser output',
      );
    }

    emit({ type: 'compaction', summary });

    await safeEmit(hooks, 'after_compaction', hookBase);
    await safeEmit(hooks, 'session:compact:after', hookBase);
    await safeEmit(hooks, 'session:compact:patch', { ...hookBase, patch: summary });

    return summary;
  } catch (err) {
    log.error({ sessionId: state.sessionId, err }, 'Compaction failed — continuing without compaction');
    emit({ type: 'error', error: `Compaction failed: ${String(err)}` });
    if (!compactionSucceeded) {
      await safeEmit(hooks, 'after_compaction', { ...hookBase, meta: { status: 'failed' } });
      await safeEmit(hooks, 'session:compact:after', { ...hookBase, meta: { status: 'failed' } });
    }
    return '';
  } finally {
    state.isCompacting = false;
  }
}

/**
 * System message text injected as a reminder for the agent to flush important
 * context to workspace/memory/ files before compaction replaces the history.
 */
const MEMORY_FLUSH_MESSAGE =
  'MEMORY FLUSH: Your context is about to be compacted. Save any important ' +
  'information from this conversation to workspace/memory/ files NOW using ' +
  'the write tool. Focus on: decisions made, problems solved, key facts ' +
  'learned, and any pending work.';

/**
 * Return true when a MEMORY FLUSH reminder is already present in the session.
 * Prevents re-injection on every iteration within the same outer loop turn.
 */
function hasFlushReminder(messages: BrainMessage[]): boolean {
  return messages.some((m) => typeof m.content === 'string' && m.content.startsWith('MEMORY FLUSH:'));
}

/**
 * Per-session autoCompact circuit-breaker counter. Keyed by the SessionLike
 * object reference so entries are GC'd automatically when the session goes
 * away — no manual cleanup, no leak in long-running PM2 processes.
 * Replaces the original module-level counter inside compaction.ts so a
 * misbehaving brain on session A can't disable autoCompact on session B.
 */
const autoCompactFailuresBySession: WeakMap<SessionLike, AutoCompactFailureCounter> = new WeakMap();

function getSessionFailureCounter(session: SessionLike): AutoCompactFailureCounter {
  let counter = autoCompactFailuresBySession.get(session);
  if (!counter) {
    counter = { count: 0 };
    autoCompactFailuresBySession.set(session, counter);
  }
  return counter;
}

/**
 * TIER 2 / TIER 3 compaction escalation (gap #14 deferred follow-up).
 *
 * Runs AFTER LAYER 1's brain-driven `compact()` summary. If the resulting
 * history is still over the `shouldCompact` threshold, escalates:
 *   TIER 2 → `autoCompact` (circuit-breaker-aware brain summary of the middle)
 *   TIER 3 → `fullCompact` (nuclear collapse: 1 system summary + last user)
 *
 * Mutates `session.messages` in place on success; fail-open on any throw so a
 * misbehaving brain never breaks the agent loop. Caller is expected to gate on
 * the `SUDO_COMPACT_ESCALATE=1` opt-in env flag before invoking.
 *
 * The autoCompact circuit-breaker counter is held PER-SESSION (WeakMap-backed)
 * so failure on one session never disables autoCompact for others.
 *
 * @internal exported for unit testing.
 */
export async function escalateCompaction(
  brain: BrainLike,
  session: SessionLike,
  state: AgentState,
): Promise<void> {
  if (!shouldCompact(session.messages as Array<{ content: string }>)) {
    return;
  }
  const beforeTokens = estimateContextSize(session.messages as Array<{ content: string }>);
  const failureCounter = getSessionFailureCounter(session);

  // TIER 2 — autoCompact. brain.call shape is structurally compatible; cast
  // through unknown to satisfy TS's bivariant function-parameter check.
  try {
    const autoResult = await autoCompact(
      session.messages as Array<{ role: string; content: string }>,
      brain as unknown as Parameters<typeof autoCompact>[1],
      beforeTokens,
      MAX_CONTEXT_TOKENS,
      { failureCounter },
    );
    if (autoResult.compacted) {
      session.messages = autoResult.history as typeof session.messages;
      log.info(
        {
          sessionId: state.sessionId,
          beforeTokens,
          afterTokens: autoResult.tokensAfter,
        },
        'TIER 2: autoCompact applied (gap #14 deferred)',
      );
    }
  } catch (err) {
    log.warn(
      { sessionId: state.sessionId, err: String(err) },
      'TIER 2 autoCompact threw — falling through to TIER 3',
    );
  }

  // TIER 3 — fullCompact nuclear reset. Only if shouldCompact still true
  // after TIER 2 (autoCompact's circuit breaker can leave history untouched).
  if (!shouldCompact(session.messages as Array<{ content: string }>)) {
    return;
  }
  try {
    const fullResult = await fullCompact(
      session.messages as Array<{ role: string; content: string }>,
      brain as unknown as Parameters<typeof fullCompact>[1],
    );
    session.messages = fullResult as typeof session.messages;
    log.warn(
      {
        sessionId: state.sessionId,
        beforeTokens,
        afterMessages: fullResult.length,
      },
      'TIER 3: fullCompact nuclear reset applied (gap #14 deferred)',
    );
  } catch (err) {
    log.warn(
      { sessionId: state.sessionId, err: String(err) },
      'TIER 3 fullCompact threw — leaving history for LAYER 2/3 to handle',
    );
  }
}

// F103: shared with sibling loop-helpers/ modules — internal, do not import
// from outside the loop-helpers/ directory.
export { hasFlushReminder as _hasFlushReminder, MEMORY_FLUSH_MESSAGE as _MEMORY_FLUSH_MESSAGE };
