/**
 * @file post-run-persist.ts
 * @description Persist-after-revision glue for the agent loop's post-run blocks.
 *
 * The turn's end-of-run save runs right after the inner loop returns, but two
 * post-run blocks can still APPEND an assistant message after it:
 *   - CompletionVerify's retry adoption, and
 *   - the universal-negative guard's corrective revision.
 * Those appends are what the channel actually delivers, yet nothing saved the
 * session again — the corrected message lived only in the session cache, so a
 * restart/hydrate resurrected the PRE-revision answer as the final assistant
 * row (observed live: the guard rescoped an overclaim, the channel delivered
 * the rescoped text, and mind.db kept the overclaim).
 *
 * This helper re-saves the session ONLY when messages were appended after the
 * end-of-run save. Fail-open: a persist error never aborts the turn.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:post-run-persist');

export type PostRunPersistOutcome = 'saved' | 'no-appends' | 'zdr-skipped' | 'error';

/**
 * Persist messages appended after the end-of-run save, if any.
 *
 * @param opts.sessionId        Session id (log context only).
 * @param opts.persistedThrough `session.messages.length` at the end-of-run save.
 * @param opts.currentLength    `session.messages.length` now, after post-run blocks.
 * @param opts.zdrBlocked       True when ZDR blocks session persistence (mirrors
 *                              the end-of-run gate — both saves honor the same policy).
 * @param opts.save             Persists the session (bound `sessionManager.save(session)`).
 */
export async function persistPostRunAppends(opts: {
  sessionId: string;
  persistedThrough: number;
  currentLength: number;
  zdrBlocked: boolean;
  save: () => Promise<void>;
}): Promise<PostRunPersistOutcome> {
  const { sessionId, persistedThrough, currentLength, zdrBlocked, save } = opts;
  if (currentLength <= persistedThrough) return 'no-appends';
  if (zdrBlocked) return 'zdr-skipped';
  try {
    await save();
    log.info(
      { sessionId, appended: currentLength - persistedThrough },
      'Post-run appends persisted — stored conversation ends on the delivered answer',
    );
    return 'saved';
  } catch (err) {
    log.warn({ sessionId, err: String(err) }, 'Post-run persist failed — continuing (revision stays in-memory)');
    return 'error';
  }
}
