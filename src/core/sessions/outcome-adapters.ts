/**
 * @file outcome-adapters.ts
 * @description Builds the three store-backed callbacks required by
 * SessionOutcomeListenerOptions from a SqliteSessionStore instance.
 *
 * All three methods fail-safe: any store error is caught, logged at WARN,
 * and a safe default value is returned so the outcome listener keeps running.
 */

import type { SqliteSessionStore } from './sqlite-session-store.js';
import type { SessionOutcomeListenerOptions } from '../outcomes/session-outcome-listener.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('sessions:outcome-adapters');

/**
 * Given a SqliteSessionStore, return the three callback fields that
 * SessionOutcomeListenerOptions requires.
 *
 * The returned object is intentionally typed with Pick<> — no hand-rolled
 * duplicate of the interface.
 */
export function buildOutcomeAdapters(
  store: SqliteSessionStore,
): Pick<SessionOutcomeListenerOptions, 'getSessionGoal' | 'getRecentMessages' | 'getToolStats'> {
  return {
    /**
     * Return the goal string for a session.
     * Uses `title` as the primary source; falls back to `system_prompt`.
     * Returns null when the session does not exist or both fields are null.
     */
    getSessionGoal(sessionId: string): string | null {
      try {
        const row = store.getSession(sessionId);
        if (!row) return null;
        return row.title ?? row.system_prompt ?? null;
      } catch (err) {
        logger.warn({ sessionId, error: String(err).slice(0, 200) }, 'getSessionGoal failed');
        return null;
      }
    },

    /**
     * Return the last n messages for a session as {role, content} pairs.
     * Returns [] when the session has no messages or does not exist.
     */
    getRecentMessages(
      sessionId: string,
      n: number,
    ): Array<{ role: string; content: string }> {
      try {
        // store.getMessages returns rows in chronological order (id ASC) limited
        // to the FIRST `limit` rows, so passing `n` yields the OLDEST n messages.
        // To return the LAST n (most recent) in chronological order, fetch the
        // full set and take the trailing slice.
        const total = store.getMessageCount(sessionId);
        if (total <= 0) return [];
        const rows = store.getMessages(sessionId, total);
        return rows.slice(Math.max(0, rows.length - n)).map((r) => ({ role: r.role, content: r.content }));
      } catch (err) {
        logger.warn({ sessionId, error: String(err).slice(0, 200) }, 'getRecentMessages failed');
        return [];
      }
    },

    /**
     * Return tool call success/failure counts for a session.
     * successCount = number of messages with role === 'tool'.
     * failureCount is currently always 0 (no failure-role signal in the schema).
     */
    getToolStats(sessionId: string): { successCount: number; failureCount: number } {
      try {
        const rows = store.getMessages(sessionId, 1000);
        const successCount = rows.filter((r) => r.role === 'tool').length;
        return { successCount, failureCount: 0 };
      } catch (err) {
        logger.warn({ sessionId, error: String(err).slice(0, 200) }, 'getToolStats failed');
        return { successCount: 0, failureCount: 0 };
      }
    },
  };
}
