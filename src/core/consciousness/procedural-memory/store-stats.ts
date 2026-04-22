/**
 * @file store-stats.ts
 * @description Execution-stats mutations for the procedures table.
 *
 * Handles `updateProcedureStats` and `disableProcedure` — split from store.ts
 * to keep both files under the 300-line limit.
 *
 * Uses the better-sqlite3 synchronous API throughout.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('procedural-memory:store-stats');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Update execution statistics for a procedure after a run.
 *
 * Uses an incremental weighted average formula for `avg_duration_ms`:
 *   newAvg = ((oldAvg * oldCount) + durationMs) / newCount
 *
 * @param db         - Open DB instance.
 * @param id         - Procedure ID.
 * @param success    - Whether the execution succeeded.
 * @param durationMs - Wall-clock duration of the execution in milliseconds.
 */
export function updateProcedureStats(
  db: Database.Database,
  id: string,
  success: boolean,
  durationMs: number,
): void {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'updateProcedureStats: id must be a non-empty string',
      'consciousness_procedural_invalid_id',
      { id },
    );
  }
  if (typeof durationMs !== 'number' || durationMs < 0) {
    throw new ConsciousnessError(
      'updateProcedureStats: durationMs must be a non-negative number',
      'consciousness_procedural_invalid_duration',
      { id, durationMs },
    );
  }

  log.debug({ id, success, durationMs }, 'updateProcedureStats: updating procedure stats');

  // Fetch current counts to compute rolling average.
  const current = db
    .prepare(`SELECT success_count, avg_duration_ms FROM procedures WHERE id = ?`)
    .get(id) as { success_count: number; avg_duration_ms: number } | undefined;

  if (!current) {
    log.warn({ id }, 'updateProcedureStats: procedure not found — skipping');
    return;
  }

  const now = new Date().toISOString();

  if (success) {
    const newCount = current.success_count + 1;
    const newAvg =
      (current.avg_duration_ms * current.success_count + durationMs) / newCount;

    try {
      db.prepare(
        `UPDATE procedures
         SET success_count   = ?,
             avg_duration_ms = ?,
             last_used       = ?,
             updated_at      = ?
         WHERE id = ?`,
      ).run(newCount, newAvg, now, now, id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `updateProcedureStats: DB update (success) failed: ${msg}`,
        'consciousness_procedural_db_update_failed',
        { id, cause: msg },
      );
    }
  } else {
    try {
      db.prepare(
        `UPDATE procedures
         SET failure_count = failure_count + 1,
             last_used     = ?,
             updated_at    = ?
         WHERE id = ?`,
      ).run(now, now, id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `updateProcedureStats: DB update (failure) failed: ${msg}`,
        'consciousness_procedural_db_update_failed',
        { id, cause: msg },
      );
    }
  }

  log.debug({ id, success }, 'updateProcedureStats: stats updated');
}

/**
 * Disable a procedure so it will no longer be matched or executed.
 * Does not delete the row — data is retained for auditing.
 *
 * @param db - Open DB instance.
 * @param id - Procedure ID to disable.
 */
export function disableProcedure(db: Database.Database, id: string): void {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'disableProcedure: id must be a non-empty string',
      'consciousness_procedural_invalid_id',
      { id },
    );
  }

  log.debug({ id }, 'disableProcedure: disabling procedure');

  try {
    const result = db
      .prepare(
        `UPDATE procedures
         SET enabled    = 0,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);

    if (result.changes === 0) {
      log.warn({ id }, 'disableProcedure: no row matched — procedure may not exist');
    } else {
      log.info({ id }, 'disableProcedure: procedure disabled');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `disableProcedure: DB update failed: ${msg}`,
      'consciousness_procedural_db_update_failed',
      { id, cause: msg },
    );
  }
}
