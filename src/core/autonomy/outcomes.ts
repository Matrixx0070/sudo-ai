/**
 * @file outcomes.ts
 * @description Structured outcomes ledger — persists what the agent accomplished.
 *
 * Records discrete outcomes (earnings, completed tasks, tool successes, errors)
 * in the same data/goals.db database used by GoalEngineV2.
 *
 * Types, DDL, and row converters live in outcomes-schema.ts.
 * Uses better-sqlite3 with WAL mode.  All methods are synchronous.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import {
  initOutcomesSchema,
  rowToEntry,
  type OutcomeRow,
  type OutcomeEntry,
  type OutcomeInput,
  type OutcomeFilter,
  type OutcomeSummary,
  type OutcomeType,
} from './outcomes-schema.js';

export type {
  OutcomeType,
  OutcomeEntry,
  OutcomeInput,
  OutcomeFilter,
  OutcomeSummary,
} from './outcomes-schema.js';

const log = createLogger('autonomy:outcomes');

const DB_PATH = path.resolve('data/goals.db');

// ---------------------------------------------------------------------------
// OutcomesLedger
// ---------------------------------------------------------------------------

/**
 * Persists and queries the agent's outcomes ledger.
 *
 * Uses the same `data/goals.db` file as GoalEngineV2 so all autonomy state
 * lives in one database file.
 *
 * @example
 * ```ts
 * const ledger = new OutcomesLedger();
 * ledger.record({ type: 'earning', description: 'API fee', valueNumeric: 0.02, currency: 'USD' });
 * const summary = ledger.summarize();
 * console.log(summary.totalEarnings); // 0.02
 * ```
 */
export class OutcomesLedger {
  private readonly db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    initOutcomesSchema(this.db);
    log.info({ dbPath }, 'OutcomesLedger initialised');
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Record a new outcome entry.
   *
   * When a UNIQUE(source_session_id, type) violation would occur
   * (i.e. the same session+type pair already exists), the insert is silently
   * ignored and `null` is returned — no error is thrown.
   *
   * @throws TypeError when type or description are missing.
   * @returns The persisted OutcomeEntry, or null if a duplicate was silently ignored.
   */
  record(entry: OutcomeInput): OutcomeEntry | null {
    if (!entry.type) {
      throw new TypeError('OutcomesLedger.record: type is required');
    }
    if (typeof entry.description !== 'string') {
      throw new TypeError('OutcomesLedger.record: description must be a string');
    }

    const id         = genId();
    const recordedAt = new Date().toISOString();

    // ITEM 5: INSERT OR IGNORE so duplicate (source_session_id, type) pairs are
    // silently discarded at the DB level rather than throwing a constraint error.
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO outcomes
         (id, type, description, value_numeric, currency,
          source_goal_id, source_session_id, recorded_at, metadata_json)
       VALUES
         (@id, @type, @description, @value_numeric, @currency,
          @source_goal_id, @source_session_id, @recorded_at, @metadata_json)`,
    ).run({
      id,
      type:              entry.type,
      description:       entry.description,
      value_numeric:     entry.valueNumeric     ?? null,
      currency:          entry.currency         ?? null,
      source_goal_id:    entry.sourceGoalId     ?? null,
      source_session_id: entry.sourceSessionId  ?? null,
      recorded_at:       recordedAt,
      metadata_json:     entry.metadata ? JSON.stringify(entry.metadata) : null,
    });

    if (result.changes === 0) {
      log.debug(
        { type: entry.type, sourceSessionId: entry.sourceSessionId },
        'Outcome already recorded for this session+type — duplicate silently ignored',
      );
      return null;
    }

    log.debug({ id, type: entry.type }, 'Outcome recorded');
    return { ...entry, id, recordedAt };
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * Query outcomes with optional filters.
   * Results are ordered by recorded_at DESC (most recent first).
   */
  query(filter: OutcomeFilter = {}): OutcomeEntry[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.type) {
      conditions.push('type = @type');
      params['type'] = filter.type;
    }
    if (filter.sourceGoalId) {
      conditions.push('source_goal_id = @source_goal_id');
      params['source_goal_id'] = filter.sourceGoalId;
    }
    if (filter.sourceSessionId) {
      conditions.push('source_session_id = @source_session_id');
      params['source_session_id'] = filter.sourceSessionId;
    }
    if (filter.since) {
      conditions.push('recorded_at >= @since');
      params['since'] = filter.since;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = typeof filter.limit === 'number' && filter.limit > 0
      ? `LIMIT ${filter.limit}`
      : '';

    const rows = this.db.prepare(
      `SELECT * FROM outcomes ${where} ORDER BY recorded_at DESC ${limit}`,
    ).all(params) as OutcomeRow[];

    return rows.map(rowToEntry);
  }

  /**
   * Produce an aggregate summary of outcomes since a given timestamp.
   *
   * @param since - Optional ISO-8601 lower bound. Defaults to all-time.
   */
  summarize(since?: string): OutcomeSummary {
    const params: Record<string, unknown> = {};
    const where = since ? (params['since'] = since, 'WHERE recorded_at >= @since') : '';

    const rows = this.db.prepare(
      `SELECT type, value_numeric FROM outcomes ${where}`,
    ).all(params) as Array<{ type: string; value_numeric: number | null }>;

    const byType: Partial<Record<OutcomeType, number>> = {};
    let totalValueNumeric = 0;
    let totalEarnings     = 0;

    for (const row of rows) {
      const t = row.type as OutcomeType;
      byType[t] = (byType[t] ?? 0) + 1;

      if (row.value_numeric !== null) {
        totalValueNumeric += row.value_numeric;
        if (t === 'earning' || t === 'payment') {
          totalEarnings += row.value_numeric;
        }
      }
    }

    return { totalCount: rows.length, byType, totalEarnings, totalValueNumeric, since };
  }

  /** Close the database connection. Call on graceful shutdown. */
  close(): void {
    this.db.close();
    log.info({}, 'OutcomesLedger database closed');
  }
}
