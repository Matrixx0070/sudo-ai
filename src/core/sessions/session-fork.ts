/**
 * @file session-fork.ts
 * @description Auto-fork: when a session fills up, compact it into a summary,
 * archive the old session, and start a fresh one for the same peer injected
 * with that summary. Works identically across web, Telegram, and all channels.
 *
 * The fork is transparent — the user never notices. SUDO continues in the new
 * session carrying full memory of the old one via the compact summary.
 *
 * Fork trigger: total message chars > FORK_THRESHOLD_CHARS (default 160 000,
 * ~40 000 tokens) OR message count > FORK_MESSAGE_COUNT (default 80).
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/index.js';
import type { Session, BrainMessage } from './types.js';
import type { ChannelType } from '../channels/types.js';
import type { SessionLineageTracker } from './session-lineage.js';

const log = createLogger('sessions:fork');

// ---------------------------------------------------------------------------
// Thresholds — tuned to trigger well before the model's context window fills.
// ---------------------------------------------------------------------------

/**
 * Total character count across all messages that triggers a fork. Default
 * 160K (~40K tokens). Raise via SUDO_FORK_THRESHOLD_CHARS to keep a longer
 * single session before rotating (Claude-Code-style) — at higher token cost.
 */
export const FORK_THRESHOLD_CHARS: number = (() => {
  const raw = Number(process.env['SUDO_FORK_THRESHOLD_CHARS']);
  return Number.isInteger(raw) && raw >= 10_000 ? raw : 160_000;
})();

/** Non-system message count that triggers a fork. Default 80; raise via
 *  SUDO_FORK_MESSAGE_COUNT to keep more conversation before rotating. */
export const FORK_MESSAGE_COUNT: number = (() => {
  const raw = Number(process.env['SUDO_FORK_MESSAGE_COUNT']);
  return Number.isInteger(raw) && raw >= 10 ? raw : 80;
})();

/**
 * Max characters for the fork handoff brief. The old hard cap of 2000 was too
 * thin to preserve a long conversation's thread (Claude Code's handoff briefs
 * run ~14K chars across 9 sections and survive dozens of compactions). Default
 * 8000 — a balance between continuity and the per-turn token cost of folding the
 * brief into every subsequent turn. Tunable via SUDO_FORK_SUMMARY_CHARS.
 */
export const FORK_SUMMARY_MAX_CHARS: number = (() => {
  const raw = Number(process.env['SUDO_FORK_SUMMARY_CHARS']);
  return Number.isInteger(raw) && raw >= 2000 ? raw : 8000;
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal brain interface needed to produce the fork summary. */
interface ForkBrain {
  call(opts: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
    source?: string;
  }): Promise<{ content: string }>;
}

/** Minimal SessionManager interface needed to create and archive sessions. */
export interface ForkSessionManager {
  getOrCreate(channel: ChannelType, peerId: string): Promise<Session>;
  archive(sessionId: string): Promise<void>;
  save(session: Session): Promise<void>;
}

export interface ForkResult {
  /** The newly created session. The agent should continue using this. */
  newSession: Session;
  /** The archived session's ID (for audit). */
  archivedSessionId: string;
  /** The compact summary injected into the new session. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalChars(messages: BrainMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
}

/**
 * Returns true if the session should be forked.
 * Checked before each agent LLM call.
 */
export function shouldFork(session: Session): boolean {
  const chars = totalChars(session.messages);
  const count = session.messages.filter(m => m.role !== 'system').length;
  return chars > FORK_THRESHOLD_CHARS || count > FORK_MESSAGE_COUNT;
}

/**
 * Pull the `## Key Facts` section out of the most recent prior fork bridge in
 * the history, if any. Forking is a telephone game: each fork re-summarises the
 * previous summary, so specific identifiers (IDs, names, codewords, paths) erode
 * across repeated forks. Carrying the prior facts forward verbatim pins them so
 * they survive. Pure + exported for tests.
 */
export function extractPriorKeyFacts(messages: BrainMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const c = m?.content;
    if (m?.role === 'system' && typeof c === 'string' && c.includes('[SESSION FORK') && c.includes('## Key Facts')) {
      const rest = c.slice(c.indexOf('## Key Facts'));
      const nextHeading = rest.indexOf('\n## ', 1); // start of the following section
      return (nextHeading > 0 ? rest.slice(0, nextHeading) : rest).trim();
    }
  }
  return '';
}

/**
 * Deterministically extract concrete identifiers from the RAW user/assistant
 * content (full text, NOT the truncated serialisation) — URLs, emails, UUIDs,
 * codewords (FOO-BAR-123), file paths, long hashes. These are force-fed into the
 * summary's Key Facts so the LLM's lossy summarisation can't silently drop a
 * specific token on the FIRST fork (carry-forward only helps a fact already
 * captured). System content is skipped to avoid noise like AUTO-ROUTING /
 * SESSION-FORK. Bounded by `cap`; each token length-capped. Pure + exported.
 */
export function extractIdentifiers(messages: BrainMessage[], cap = 40): string[] {
  const text = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => m.content ?? '')
    .join('\n');
  const patterns: RegExp[] = [
    /https?:\/\/[^\s<>"')\]]+/g,                                                          // URLs
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,                                // emails
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,   // UUIDs
    /\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)+\b/g,                                              // FOO-BAR-123, ZEBRA-QUASAR-7731
    /(?:[A-Za-z]:\\|\/)[A-Za-z0-9._/\\-]{3,}/g,                                           // unix/windows file paths
    /\b[0-9a-f]{16,}\b/g,                                                                 // long hex / hashes
  ];
  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const tok = m[0].slice(0, 120);
      if (tok.length >= 4) found.add(tok);
      if (found.size >= cap) return [...found];
    }
  }
  return [...found];
}

async function buildForkSummary(brain: ForkBrain, messages: BrainMessage[]): Promise<string> {
  const serialised = messages
    .filter(m => m.role !== 'system' || !m.content.startsWith('[AutoCompact'))
    .map(m => `[${m.role.toUpperCase()}]\n${(m.content ?? '').slice(0, 2000)}`)
    .join('\n\n---\n\n');

  // Anti-telephone-game: pin facts carried from a prior fork so repeated forks
  // don't erode them. Bounded — they compete within the same char budget, so
  // the bridge (and the per-turn tokens it folds into) does not grow unbounded.
  const priorFacts = extractPriorKeyFacts(messages);
  const factCarry = priorFacts
    ? [
        '',
        'CARRIED KEY FACTS — this conversation has been forked before. You MUST reproduce every item below VERBATIM in your "## Key Facts" section (identifiers, names, codewords, paths, URLs must NEVER be lost across session forks), then add any new ones:',
        priorFacts,
        '',
      ].join('\n')
    : '';

  // First-capture guarantee: deterministically extracted identifiers the LLM
  // must not drop. Bounded (cap) and competes within the same char budget, so
  // the bridge — and the per-turn tokens the fold injects — stays bounded.
  const identifiers = extractIdentifiers(messages);
  const idBlock = identifiers.length > 0
    ? [
        '',
        'EXTRACTED IDENTIFIERS — these exact tokens appear in the conversation and MUST each be reproduced VERBATIM in your "## Key Facts" section (highest priority — drop prose before dropping any of these):',
        identifiers.map(s => `- ${s}`).join('\n'),
        '',
      ].join('\n')
    : '';

  const prompt = [
    'You are a conversation memory system. Produce a DENSE, COMPLETE handoff brief',
    'so a NEW session can continue this conversation with ZERO loss of thread or intent.',
    '',
    'Output EXACTLY these sections, in this order, with these headings:',
    '## 1. Primary Request & Intent — what the user is ultimately trying to achieve, in detail.',
    '## 2. Key Technical Concepts — technologies, systems, tools, and domain terms in play.',
    '## 3. Files & Artifacts — files, URLs, IDs, and resources touched or referenced.',
    '## 4. Errors & Fixes — problems encountered and how each was (or was not) resolved.',
    '## 5. Problem Solving & Decisions — what was figured out, decisions made, and the reasoning.',
    '## 6. All User Messages — EVERY user message so far, verbatim and in order. This is the',
    '      HIGHEST priority: never paraphrase, summarise, or drop a user message.',
    '## 7. Pending Tasks — what is still to be done.',
    '## 8. Current Work — exactly what was happening at the moment of handoff.',
    '## 9. Next Step — the single most likely next action.',
    '',
    `Rules: be specific; use bullet points where natural; max ${FORK_SUMMARY_MAX_CHARS} chars.`,
    'Capture EVERY concrete identifier verbatim (IDs, file paths, URLs, names, codewords,',
    'numbers, credential-references) — drop prose before dropping a fact.',
    factCarry,
    idBlock,
    'Conversation to summarise:',
    '',
    serialised,
  ].join('\n');

  try {
    const resp = await brain.call({
      source: 'session-fork',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: Math.min(8192, Math.round(FORK_SUMMARY_MAX_CHARS / 3) + 512),
      temperature: 0.1,
    });
    return resp.content?.trim() ?? '[Fork summary unavailable]';
  } catch (err) {
    log.error({ err }, 'Fork summary LLM call failed — using fallback');
    // Deterministic fallback under the same structure: never lose user intent —
    // preserve recent user messages verbatim plus the extracted identifiers.
    const lastUsers = messages
      .filter(m => m.role === 'user')
      .slice(-8)
      .map(m => `- ${(m.content ?? '').slice(0, 600)}`)
      .join('\n');
    return [
      '## 6. All User Messages (recent — LLM summary unavailable)',
      lastUsers || '(none captured)',
      '',
      '## 3. Files & Artifacts',
      identifiers.length > 0 ? identifiers.map(s => `- ${s}`).join('\n') : '(none captured)',
      '',
      '## 8. Current Work',
      '[Fork summary generation failed; recent user messages + identifiers above are preserved verbatim.]',
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fork a full session into a fresh one for the same peer.
 *
 * Steps:
 * 1. Compact old session into a structured handoff summary.
 * 2. Archive the old session (state → 'archived', evicted from cache).
 * 3. Create a new session for the same (channel, peerId).
 * 4. Inject summary + fork notice as the first system message.
 * 5. Return the new session.
 *
 * Never throws — on any failure it returns the original session unchanged.
 */
export async function forkSession(
  session: Session,
  brain: ForkBrain,
  sessionManager: ForkSessionManager,
  lineageTracker?: SessionLineageTracker,
): Promise<ForkResult | null> {
  const { id: oldId, channel, peerId } = session;
  log.info(
    { oldId, channel, peerId, messages: session.messages.length, chars: totalChars(session.messages) },
    'Session fork triggered — compacting and archiving',
  );

  try {
    // 1. Build summary from current messages
    const summary = await buildForkSummary(brain, session.messages);

    // 2. Archive old session
    await sessionManager.archive(oldId);
    log.info({ oldId }, 'Old session archived');

    // 3. Create new session (getOrCreate now returns a fresh one because old is archived)
    const newSession = await sessionManager.getOrCreate(channel, peerId);

    // 4. Inject summary as system context
    const forkNotice: BrainMessage = {
      role: 'system',
      content: [
        `[SESSION FORK — continued from ${oldId}]`,
        '',
        'The previous session reached its memory limit and was archived.',
        'Below is a full handoff brief. Continue seamlessly — the user sees no break.',
        '',
        summary,
      ].join('\n'),
    };
    newSession.messages.unshift(forkNotice);
    await sessionManager.save(newSession);

    // 5. Record parent-child lineage if a tracker is available
    if (lineageTracker) {
      try {
        lineageTracker.recordLineage(newSession.id, oldId, 'fork');
        log.info({ parentId: oldId, childId: newSession.id }, 'Lineage recorded for fork');
      } catch (err) {
        log.warn({ err, parentId: oldId, childId: newSession.id }, 'Failed to record lineage — fork still succeeds');
      }
    }

    log.info(
      { oldId, newId: newSession.id, channel, peerId },
      'Session forked successfully',
    );

    return { newSession, archivedSessionId: oldId, summary };
  } catch (err) {
    log.error({ err, oldId, channel, peerId }, 'Session fork failed — continuing with original session');
    return null;
  }
}
