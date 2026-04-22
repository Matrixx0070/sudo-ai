/**
 * @file store.ts
 * @description SQLite persistence layer for Procedure objects — core CRUD.
 *
 * All functions accept a raw better-sqlite3 Database instance (obtained from
 * ConsciousnessDB.getDb()) and operate synchronously.
 *
 * Stat updates and disabling are handled in store-stats.ts.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Procedure } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('procedural-memory:store');

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

export interface ProcedureRow {
  id: string;
  name: string;
  description: string;
  trigger_pattern: string;
  steps: string;
  success_count: number;
  failure_count: number;
  avg_duration_ms: number;
  last_used: string | null;
  compiled_from: string;
  enabled: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row converter (shared with store-stats)
// ---------------------------------------------------------------------------

/**
 * Convert a raw `procedures` row into a typed Procedure object.
 * Parses JSON columns and coerces SQLite integers to booleans.
 */
export function rowToProcedure(row: ProcedureRow): Procedure {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerPattern: row.trigger_pattern,
    steps: (() => {
      try {
        return JSON.parse(row.steps);
      } catch {
        log.warn({ id: row.id }, 'rowToProcedure: failed to parse steps JSON — defaulting to []');
        return [];
      }
    })(),
    successCount: row.success_count,
    failureCount: row.failure_count,
    avgDurationMs: row.avg_duration_ms,
    lastUsed: row.last_used,
    compiledFrom: (() => {
      try {
        return JSON.parse(row.compiled_from);
      } catch {
        return [];
      }
    })(),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a new Procedure to the `procedures` table.
 *
 * @throws ConsciousnessError on validation failure or DB error.
 */
export function saveProcedure(db: Database.Database, procedure: Procedure): void {
  if (!procedure || !procedure.id) {
    throw new ConsciousnessError(
      'saveProcedure: procedure must have an id',
      'consciousness_procedural_invalid_procedure',
      { procedure },
    );
  }

  log.debug({ id: procedure.id, name: procedure.name }, 'saveProcedure: inserting procedure');

  try {
    db.prepare(
      `INSERT INTO procedures
         (id, name, description, trigger_pattern, steps,
          success_count, failure_count, avg_duration_ms,
          last_used, compiled_from, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      procedure.id,
      procedure.name,
      procedure.description,
      procedure.triggerPattern,
      JSON.stringify(procedure.steps),
      procedure.successCount,
      procedure.failureCount,
      procedure.avgDurationMs,
      procedure.lastUsed,
      JSON.stringify(procedure.compiledFrom),
      procedure.enabled ? 1 : 0,
      procedure.createdAt,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveProcedure: DB insert failed: ${msg}`,
      'consciousness_procedural_db_insert_failed',
      { id: procedure.id, cause: msg },
    );
  }

  log.info({ id: procedure.id, name: procedure.name }, 'saveProcedure: procedure saved');
}

/**
 * Retrieve all procedures, optionally filtering to enabled-only.
 *
 * @param db          - Open DB instance.
 * @param enabledOnly - When true, only return enabled procedures.
 */
export function getProcedures(
  db: Database.Database,
  enabledOnly = false,
): Procedure[] {
  log.debug({ enabledOnly }, 'getProcedures: querying procedures');

  try {
    const sql = enabledOnly
      ? `SELECT * FROM procedures WHERE enabled = 1 ORDER BY created_at DESC`
      : `SELECT * FROM procedures ORDER BY created_at DESC`;

    const rows = db.prepare(sql).all() as ProcedureRow[];
    const procedures = rows.map(rowToProcedure);

    log.debug({ count: procedures.length, enabledOnly }, 'getProcedures: returned procedures');
    return procedures;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getProcedures: DB query failed: ${msg}`,
      'consciousness_procedural_db_query_failed',
      { enabledOnly, cause: msg },
    );
  }
}

/**
 * Find the first enabled procedure whose triggerPattern matches `context`
 * using a SQL LIKE substring search.
 *
 * @param db      - Open DB instance.
 * @param context - Natural-language context string to match against.
 * @returns Matching Procedure or null if none found.
 */
export function findMatchingProcedure(
  db: Database.Database,
  context: string,
): Procedure | null {
  if (!context || typeof context !== 'string') {
    throw new ConsciousnessError(
      'findMatchingProcedure: context must be a non-empty string',
      'consciousness_procedural_invalid_context',
      { context },
    );
  }

  log.debug({ context }, 'findMatchingProcedure: searching for matching procedure');

  try {
    const row = db
      .prepare(
        `SELECT * FROM procedures
         WHERE enabled = 1
           AND trigger_pattern LIKE ?
         ORDER BY success_count DESC
         LIMIT 1`,
      )
      .get(`%${context}%`) as ProcedureRow | undefined;

    if (!row) {
      log.debug({ context }, 'findMatchingProcedure: no match found');
      return null;
    }

    const procedure = rowToProcedure(row);
    log.info(
      { id: procedure.id, name: procedure.name, context },
      'findMatchingProcedure: match found',
    );
    return procedure;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `findMatchingProcedure: DB query failed: ${msg}`,
      'consciousness_procedural_db_query_failed',
      { context, cause: msg },
    );
  }
}
