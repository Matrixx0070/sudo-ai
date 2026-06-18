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

/** Total character count across all messages that triggers a fork. ~40K tokens. */
export const FORK_THRESHOLD_CHARS = 160_000 as const;

/** Message count that triggers a fork regardless of char count. */
export const FORK_MESSAGE_COUNT = 80 as const;

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

async function buildForkSummary(brain: ForkBrain, messages: BrainMessage[]): Promise<string> {
  const serialised = messages
    .filter(m => m.role !== 'system' || !m.content.startsWith('[AutoCompact'))
    .map(m => `[${m.role.toUpperCase()}]\n${(m.content ?? '').slice(0, 2000)}`)
    .join('\n\n---\n\n');

  const prompt = [
    'You are a conversation memory system. Produce a dense handoff brief for a NEW session that continues this conversation.',
    '',
    'Output EXACTLY these sections:',
    '## Context',
    '## Decisions Made',
    '## Open Tasks',
    '## Key Facts (IDs, paths, URLs, names)',
    '## Last User Request',
    '',
    'Rules: be specific, use bullet points, max 2000 chars total.',
    '',
    'Conversation to summarise:',
    '',
    serialised,
  ].join('\n');

  try {
    const resp = await brain.call({
      source: 'session-fork',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
      temperature: 0.1,
    });
    return resp.content?.trim() ?? '[Fork summary unavailable]';
  } catch (err) {
    log.error({ err }, 'Fork summary LLM call failed — using fallback');
    // Fallback: extract last few user messages as raw context
    const lastUser = messages
      .filter(m => m.role === 'user')
      .slice(-5)
      .map(m => m.content.slice(0, 300))
      .join('\n---\n');
    return `## Context\n[Summary generation failed]\n\n## Last User Request\n${lastUser}`;
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
