/**
 * @file subagent-resume.ts
 * @description Subagent resume_from (gap #21) — load a finished sub-
 * agent's session transcript so the next sub-agent run starts on top of
 * it instead of cold.
 *
 * The swarm already creates each sub-agent's ephemeral session under
 * `channel='swarm', peerId='subagent:<agentId>'` and saves messages as
 * the loop runs. After the loop returns, that session persists in the
 * SessionManager (and in the journal under SUDO_CRASH_SAFE) so future
 * runs can re-read it. This module supplies the small read-side helper
 * that turns an agentId into the messages array ready to push into a
 * brand-new session.
 *
 * Why a separate module: the existing `fork-history.ts` filters parent
 * conversation messages keeping system+user+final-answer-assistant and
 * dropping intermediate assistant + tool messages. Resume is the
 * OPPOSITE — we want the complete transcript including tool I/O and
 * intermediate turns, because the new prompt is layered on top of a
 * finished arc, not threaded into a parent flow.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:subagent-resume');

/** Sub-agent session peer-key convention; mirrors swarm.ts:210 / :407. */
export const SUBAGENT_CHANNEL = 'swarm';
export function subagentPeerKey(agentId: string): string {
  return `subagent:${agentId}`;
}

/**
 * Minimal session-manager surface the loader needs. Duck-typed so the
 * tests can pass a stub with just these two methods.
 */
export interface ResumeSessionManager {
  getOrCreate(channel: string, peerId: string): Promise<{ id: string; messages?: unknown }>;
}

/**
 * Generic message shape we'll splice into the new session. Kept loose so
 * roles other than the standard four still survive (e.g. a future
 * `system-context` role) — the loop accepts whatever the session holds.
 */
export interface ResumableMessage {
  role: string;
  content?: string;
  // Tool-call metadata is preserved verbatim so the AI SDK's pair
  // validation (AI_MissingToolResultsError) does not complain after a
  // resume that lands mid-tool-call train.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

/**
 * Load the messages of a previously-completed sub-agent by id. Returns
 * an empty array on any failure (unknown agent, manager throw, malformed
 * session) — the caller decides whether to fail loud or just start cold.
 *
 * IMPORTANT: `role: 'system'` messages are filtered out of the loaded
 * transcript because `Brain.toSDKMessages` (brain.ts:131) drops every
 * system-role entry from `request.messages` with a warn log — the SDK
 * routes system content via the dedicated `system` param of
 * generateText. Including the prior agent's system message in
 * session.messages here means the new sub-agent never sees it AND every
 * brain.call emits the noisy drop warning (verifier gap #21 BLOCKER).
 * The prior system seed therefore travels with the AgentConfig
 * (persona / model defaults), not via this resume path.
 */
export async function loadResumeMessages(
  sessionManager: ResumeSessionManager,
  agentId: string,
): Promise<ResumableMessage[]> {
  if (!agentId || typeof agentId !== 'string') return [];
  try {
    const session = await sessionManager.getOrCreate(SUBAGENT_CHANNEL, subagentPeerKey(agentId));
    if (!session || typeof session !== 'object') return [];
    const messages = (session as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) {
      log.warn({ agentId, sessionId: session.id }, 'resume: session has no messages array — starting cold');
      return [];
    }
    return messages.filter((m): m is ResumableMessage => {
      if (typeof m !== 'object' || m === null) return false;
      const role = (m as { role?: unknown }).role;
      if (typeof role !== 'string') return false;
      // System messages would be silently dropped by Brain.toSDKMessages
      // — exclude them here so the loop's warn log stays meaningful.
      if (role === 'system') return false;
      return true;
    });
  } catch (err) {
    log.warn({ agentId, err: String(err) }, 'resume: loadResumeMessages failed — starting cold');
    return [];
  }
}

/**
 * Splice resumed messages onto a freshly-created session in place. Returns
 * the number of messages appended. Mirrors `seedForkedHistory`'s contract
 * (mutate, return count) for symmetry with the fork-mode seeding path.
 *
 * Behaviour:
 *   - PREPENDS resumed messages onto session.messages (unshift). On a
 *     freshly-created sub-agent session, `existing.length` is usually 0
 *     so the order is just the resumed transcript. If a session-manager
 *     pre-seeds anything, the seed lands AFTER the resumed messages
 *     (caller is responsible for normalizing any system seed back to
 *     position 0 if that matters).
 *   - Skips empty inputs gracefully (no-op, returns 0).
 *
 * The caller is responsible for awaiting `sessionManager.save(session)`
 * after this returns if it wants the resumed history to persist.
 */
export function seedResumeHistory(
  session: { messages?: unknown },
  resumed: ResumableMessage[],
): number {
  if (!Array.isArray(resumed) || resumed.length === 0) return 0;
  if (!Array.isArray(session.messages)) session.messages = [];
  const existing = session.messages as ResumableMessage[];
  // Splice resumed in BEFORE any pre-existing system seed.
  existing.unshift(...resumed);
  return resumed.length;
}
