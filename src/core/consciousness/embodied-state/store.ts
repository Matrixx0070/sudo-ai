/**
 * @file store.ts
 * @description Persistence layer for embodied-state snapshots in SUDO-AI v4.
 *
 * Writes and reads from the `body_state_log` table managed by ConsciousnessDB.
 * Prepared statements are cached per Database instance via a WeakMap so they
 * are compiled once and reused across calls without leaking memory when the
 * database is closed.
 *
 * All public functions are synchronous to match the better-sqlite3 API.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { BodyState } from '../types.js';
import type { RawSystemMetrics } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('consciousness:embodied-state');

// ---------------------------------------------------------------------------
// Prepared statement cache
// ---------------------------------------------------------------------------

interface PreparedStatements {
  insert: Database.Statement;
  selectLatest: Database.Statement;
  selectHistory: Database.Statement;
}

/**
 * WeakMap keyed on the underlying better-sqlite3 Database object.
 * Entries are garbage-collected automatically when the database is closed
 * and no other reference to the Database instance exists.
 */
const stmtCache = new WeakMap<Database.Database, PreparedStatements>();

/**
 * Return cached prepared statements for `db`, creating them on first access.
 *
 * @param db - Open better-sqlite3 Database instance.
 * @returns Cached `PreparedStatements`.
 */
function getStatements(db: Database.Database): PreparedStatements {
  const cached = stmtCache.get(db);
  if (cached !== undefined) return cached;

  const stmts: PreparedStatements = {
    insert: db.prepare(`
      INSERT INTO body_state_log
        (energy, clarity, fullness, connectivity, continuity, raw_metrics, sampled_at)
      VALUES
        (@energy, @clarity, @fullness, @connectivity, @continuity, @raw_metrics, @sampled_at)
    `),

    selectLatest: db.prepare(`
      SELECT energy, clarity, fullness, connectivity, continuity, sampled_at
      FROM   body_state_log
      ORDER  BY sampled_at DESC
      LIMIT  1
    `),

    selectHistory: db.prepare(`
      SELECT energy, clarity, fullness, connectivity, continuity, sampled_at
      FROM   body_state_log
      WHERE  sampled_at >= datetime('now', @offset)
      ORDER  BY sampled_at ASC
    `),
  };

  stmtCache.set(db, stmts);
  return stmts;
}

// ---------------------------------------------------------------------------
// Row → BodyState helper
// ---------------------------------------------------------------------------

interface BodyStateRow {
  energy: number;
  clarity: number;
  fullness: number;
  connectivity: number;
  continuity: number;
  sampled_at: string;
}

function rowToBodyState(row: BodyStateRow): BodyState {
  return {
    energy: row.energy,
    clarity: row.clarity,
    fullness: row.fullness,
    connectivity: row.connectivity,
    continuity: row.continuity,
    sampledAt: row.sampled_at,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a BodyState snapshot alongside its originating raw metrics.
 *
 * @param cdb   - Open ConsciousnessDB instance.
 * @param state - Normalised BodyState to persist.
 * @param raw   - Raw metrics from which `state` was derived.
 *
 * @throws ConsciousnessError on database write failure.
 */
export function saveState(
  cdb: ConsciousnessDB,
  state: BodyState,
  raw: RawSystemMetrics,
): void {
  const db = cdb.getDb();
  const stmts = getStatements(db);

  const rawJson = JSON.stringify(raw);

  try {
    stmts.insert.run({
      energy: state.energy,
      clarity: state.clarity,
      fullness: state.fullness,
      connectivity: state.connectivity,
      continuity: state.continuity,
      raw_metrics: rawJson,
      sampled_at: state.sampledAt,
    });

    log.debug(
      {
        energy: state.energy.toFixed(3),
        clarity: state.clarity.toFixed(3),
        sampledAt: state.sampledAt,
      },
      'store: body state saved',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, 'store: failed to save body state');
    throw new ConsciousnessError(
      `Failed to save body state: ${msg}`,
      'consciousness_store_write_failed',
      { sampledAt: state.sampledAt, cause: msg },
    );
  }
}

/**
 * Retrieve the most recently persisted BodyState.
 *
 * @param cdb - Open ConsciousnessDB instance.
 * @returns The latest BodyState, or null if the table is empty.
 */
export function getLatestState(cdb: ConsciousnessDB): BodyState | null {
  const db = cdb.getDb();
  const stmts = getStatements(db);

  try {
    const row = stmts.selectLatest.get() as BodyStateRow | undefined;
    if (row === undefined) return null;
    return rowToBodyState(row);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, 'store: failed to read latest body state');
    throw new ConsciousnessError(
      `Failed to read latest body state: ${msg}`,
      'consciousness_store_read_failed',
      { cause: msg },
    );
  }
}

/**
 * Retrieve body state history from the last `hours` hours.
 *
 * @param cdb   - Open ConsciousnessDB instance.
 * @param hours - Lookback window in hours.  Must be > 0.
 * @returns Array of BodyState records ordered oldest-first; may be empty.
 *
 * @throws RangeError if `hours` <= 0.
 */
export function getStateHistory(
  cdb: ConsciousnessDB,
  hours: number,
): BodyState[] {
  if (hours <= 0) {
    throw new RangeError(`getStateHistory: hours must be > 0, got ${hours}`);
  }

  const db = cdb.getDb();
  const stmts = getStatements(db);

  // SQLite datetime modifier format: '-N hours'
  const offset = `-${hours} hours`;

  try {
    const rows = stmts.selectHistory.all({ offset }) as BodyStateRow[];
    return rows.map(rowToBodyState);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg, hours }, 'store: failed to read body state history');
    throw new ConsciousnessError(
      `Failed to read body state history: ${msg}`,
      'consciousness_store_history_failed',
      { hours, cause: msg },
    );
  }
}
