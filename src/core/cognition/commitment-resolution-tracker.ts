/**
 * @file cognition/commitment-resolution-tracker.ts
 * @description CommitmentResolutionTracker — persistent record of commitment
 * outcomes. Lets callers mark a commitment as honored, abandoned, or
 * expired-acknowledged, and surfaces the honor rate over time.
 *
 * Storage: SQLite table `commitment_resolutions`.
 * Pure module — no REST wiring (deferred).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:commitment-resolution-tracker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const NOTES_MAX_LEN = 200;
const NOTES_LOG_TRUNCATE_LEN = 60;

// ---------------------------------------------------------------------------
// Duck-typed database interface (allows mock injection in tests)
// ---------------------------------------------------------------------------

interface StatementLike<TParams extends unknown[], TResult> {
  run(...params: TParams): unknown;
  all(...params: TParams): TResult[];
  get(...params: TParams): TResult | undefined;
}

export interface DatabaseLike {
  prepare<TResult = unknown>(sql: string): StatementLike<unknown[], TResult>;
  exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CommitmentResolution = 'honored' | 'abandoned' | 'expired-acknowledged';

export interface ResolutionEntry {
  id: string;
  commitmentRef: string;
  resolution: CommitmentResolution;
  ts: number;        // epoch ms
  notes?: string;
}

export interface ResolutionStats {
  total: number;
  honored: number;
  abandoned: number;
  expiredAcknowledged: number;
  honorRate: number;  // honored / (honored + abandoned + expiredAcknowledged); 0 if empty
  windowDays: number;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface RawResolutionRow {
  id: string;
  commitment_ref: string;
  resolution: string;
  ts: number;
  notes: string | null;
}

interface IsResolvedRow {
  cnt: number;
}

interface StatsRow {
  total: number;
  honored: number;
  abandoned: number;
  expired_acknowledged: number;
}

// ---------------------------------------------------------------------------
// Valid resolutions set
// ---------------------------------------------------------------------------

const VALID_RESOLUTIONS: ReadonlySet<CommitmentResolution> = new Set([
  'honored',
  'abandoned',
  'expired-acknowledged',
]);

function isValidResolution(v: string): v is CommitmentResolution {
  return VALID_RESOLUTIONS.has(v as CommitmentResolution);
}

// ---------------------------------------------------------------------------
// Zero stats (fail-open)
// ---------------------------------------------------------------------------

function zeroStats(windowDays: number): ResolutionStats {
  return {
    total: 0,
    honored: 0,
    abandoned: 0,
    expiredAcknowledged: 0,
    honorRate: 0,
    windowDays,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Row → ResolutionEntry mapper
// ---------------------------------------------------------------------------

function mapRow(row: RawResolutionRow): ResolutionEntry {
  const entry: ResolutionEntry = {
    id: row.id,
    commitmentRef: row.commitment_ref,
    resolution: row.resolution as CommitmentResolution,
    ts: row.ts,
  };
  if (row.notes !== null) {
    entry.notes = row.notes;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// CommitmentResolutionTracker
// ---------------------------------------------------------------------------

export class CommitmentResolutionTracker {
  private readonly _stmtInsert: StatementLike<unknown[], unknown>;
  private readonly _stmtIsResolved: StatementLike<unknown[], IsResolvedRow>;
  private readonly _stmtListWindow: StatementLike<unknown[], RawResolutionRow>;
  private readonly _stmtListWindowByResolution: StatementLike<unknown[], RawResolutionRow>;
  private readonly _stmtStats: StatementLike<unknown[], StatsRow>;

  constructor(db: DatabaseLike) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS commitment_resolutions (
          id             TEXT NOT NULL PRIMARY KEY,
          commitment_ref TEXT NOT NULL,
          resolution     TEXT NOT NULL CHECK(resolution IN ('honored','abandoned','expired-acknowledged')),
          ts             INTEGER NOT NULL,
          notes          TEXT
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_commitment_resolutions_ref
        ON commitment_resolutions(commitment_ref)
      `);
    } catch (err: unknown) {
      log.error(
        { err, event: 'resolution.init.error' },
        'commitment-resolution-tracker: failed to create table or index',
      );
      // Subsequent calls will fail-open via per-method try/catch.
    }

    this._stmtInsert = db.prepare(
      `INSERT INTO commitment_resolutions (id, commitment_ref, resolution, ts, notes)
       VALUES (?, ?, ?, ?, ?)`,
    );

    this._stmtIsResolved = db.prepare<IsResolvedRow>(
      `SELECT COUNT(*) AS cnt FROM commitment_resolutions WHERE commitment_ref = ?`,
    );

    this._stmtListWindow = db.prepare<RawResolutionRow>(
      `SELECT id, commitment_ref, resolution, ts, notes
       FROM commitment_resolutions
       WHERE ts >= ?
       ORDER BY ts DESC
       LIMIT ?`,
    );

    this._stmtListWindowByResolution = db.prepare<RawResolutionRow>(
      `SELECT id, commitment_ref, resolution, ts, notes
       FROM commitment_resolutions
       WHERE ts >= ? AND resolution = ?
       ORDER BY ts DESC
       LIMIT ?`,
    );

    this._stmtStats = db.prepare<StatsRow>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN resolution = 'honored' THEN 1 ELSE 0 END) AS honored,
         SUM(CASE WHEN resolution = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
         SUM(CASE WHEN resolution = 'expired-acknowledged' THEN 1 ELSE 0 END) AS expired_acknowledged
       FROM commitment_resolutions
       WHERE ts >= ?`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record the outcome for a commitment.
   *
   * - Validates the resolution enum (returns null silently on invalid).
   * - Rejects duplicate resolutions for the same commitmentRef (idempotent safety).
   * - Truncates notes to 200 characters.
   * - Returns the full ResolutionEntry on success, null on any failure.
   */
  resolve(
    commitmentRef: string,
    resolution: CommitmentResolution,
    notes?: string,
  ): ResolutionEntry | null {
    // Validate resolution enum
    if (!isValidResolution(resolution)) {
      log.warn(
        { resolution, event: 'resolution.invalid-enum' },
        'commitment-resolution-tracker: invalid resolution enum — returning null (fail-open)',
      );
      return null;
    }

    // Idempotent duplicate guard
    if (this.isResolved(commitmentRef)) {
      log.warn(
        { commitmentRef, event: 'resolution.duplicate' },
        'commitment-resolution-tracker: commitmentRef already resolved — returning null',
      );
      return null;
    }

    const id = randomUUID();
    const ts = Date.now();
    const truncatedNotes = notes !== undefined
      ? notes.slice(0, NOTES_MAX_LEN)
      : null;

    try {
      this._stmtInsert.run(id, commitmentRef, resolution, ts, truncatedNotes);
      log.debug(
        {
          id,
          commitmentRef,
          resolution,
          ts,
          notesLen: truncatedNotes?.length ?? 0,
          event: 'resolution.recorded',
        },
        'commitment-resolution-tracker: resolution recorded',
      );
      const entry: ResolutionEntry = { id, commitmentRef, resolution, ts };
      if (truncatedNotes !== null) {
        entry.notes = truncatedNotes;
      }
      return entry;
    } catch (err: unknown) {
      log.error(
        {
          err,
          commitmentRef,
          resolution,
          notes: truncatedNotes !== null
            ? truncatedNotes.slice(0, NOTES_LOG_TRUNCATE_LEN)
            : null,
          event: 'resolution.insert.error',
        },
        'commitment-resolution-tracker: DB insert failed (fail-open)',
      );
      return null;
    }
  }

  /**
   * Return resolution entries within the rolling window.
   *
   * Defaults: windowDays=30, limit=100 (clamped [1,500]).
   * Optional filter by resolution type.
   * Fail-open: returns empty array on any DB error.
   */
  getResolutions(opts?: {
    windowDays?: number;
    resolution?: CommitmentResolution;
    limit?: number;
  }): ResolutionEntry[] {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const rawLimit = opts?.limit ?? DEFAULT_LIMIT;
    const limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, rawLimit));
    const cutoffTs = Date.now() - windowDays * MS_PER_DAY;
    const resolution = opts?.resolution;

    try {
      let rows: RawResolutionRow[];
      if (resolution !== undefined && isValidResolution(resolution)) {
        rows = this._stmtListWindowByResolution.all(cutoffTs, resolution, limit);
      } else {
        rows = this._stmtListWindow.all(cutoffTs, limit);
      }
      return rows.map(mapRow);
    } catch (err: unknown) {
      log.error(
        { err, windowDays, resolution, limit, event: 'resolution.list.error' },
        'commitment-resolution-tracker: DB query failed; returning empty array (fail-open)',
      );
      return [];
    }
  }

  /**
   * Compute honor-rate statistics over a rolling window.
   *
   * honorRate = honored / (honored + abandoned + expiredAcknowledged); 0 when empty.
   * Fail-open: returns zero-stats on any DB error.
   */
  getStats(opts?: { windowDays?: number }): ResolutionStats {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const cutoffTs = Date.now() - windowDays * MS_PER_DAY;

    try {
      const row = this._stmtStats.get(cutoffTs);
      if (row === undefined) {
        return zeroStats(windowDays);
      }

      const total = row.total ?? 0;
      const honored = row.honored ?? 0;
      const abandoned = row.abandoned ?? 0;
      const expiredAcknowledged = row.expired_acknowledged ?? 0;
      const denominator = honored + abandoned + expiredAcknowledged;
      const honorRate = denominator > 0 ? honored / denominator : 0;

      return {
        total,
        honored,
        abandoned,
        expiredAcknowledged,
        honorRate,
        windowDays,
        computedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      log.error(
        { err, windowDays, event: 'resolution.stats.error' },
        'commitment-resolution-tracker: DB stats query failed; returning zero-stats (fail-open)',
      );
      return zeroStats(windowDays);
    }
  }

  /**
   * Return true if any resolution exists for the given commitmentRef.
   * Fail-open: returns false on any DB error.
   */
  isResolved(commitmentRef: string): boolean {
    try {
      const row = this._stmtIsResolved.get(commitmentRef);
      return (row?.cnt ?? 0) > 0;
    } catch (err: unknown) {
      log.error(
        { err, commitmentRef, event: 'resolution.isresolved.error' },
        'commitment-resolution-tracker: DB query failed; returning false (fail-open)',
      );
      return false;
    }
  }
}
