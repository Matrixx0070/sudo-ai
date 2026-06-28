/**
 * @file cognition/confidence-calibration-tracker.ts
 * @description ConfidenceCalibrationTracker — records predicted confidence at
 * decision time vs observed outcome, computes Brier score and per-bucket
 * reliability so the system can detect and correct overconfidence.
 *
 * Storage: SQLite table `confidence_calibration`.
 * Pure module — no REST wiring (6L will wire it).
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:confidence-calibration-tracker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Duck-typed database interface (allows mock injection in tests)
// ---------------------------------------------------------------------------

interface StatementLike<TParams extends unknown[], TResult> {
  run(...params: TParams): unknown;
  all(...params: TParams): TResult[];
}

export interface DatabaseLike {
  // TResult stays first (existing callers use prepare<RowType>); TParams is an
  // optional second arg so the insert can pin an explicit bind tuple.
  prepare<TResult = unknown, TParams extends unknown[] = unknown[]>(sql: string): StatementLike<TParams, TResult>;
  exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConfidenceBucket =
  | 'VERY_LOW'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'VERY_HIGH';

export interface CalibrationEntry {
  id: string;
  predictedConfidence: number; // [0,1]
  observedOutcome: 0 | 1;      // 0 = failure, 1 = success
  tag?: string;                // optional EpistemicTag or free-form label
  ts: number;
}

export interface BucketStats {
  bucket: ConfidenceBucket;
  rangeLow: number;
  rangeHigh: number;
  count: number;
  avgPredicted: number;
  actualSuccessRate: number;
  calibrationError: number;  // avgPredicted - actualSuccessRate
}

export interface CalibrationReport {
  totalSamples: number;
  brierScore: number;            // mean squared error between predicted and observed
  overallAvgPredicted: number;
  overallSuccessRate: number;
  buckets: BucketStats[];        // always 5 buckets, ordered low→high
  windowDays: number;
  computedAt: string;
}

export interface GetReportOptions {
  windowDays?: number;
  tag?: string;
  /**
   * Filter rows by exact tool_name match. Independent of `tag` — the verify
   * gate's per-tool Brier path keys on this, the legacy epistemic-tag path
   * keys on `tag`. When both are set the filters AND.
   */
  toolName?: string;
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface RawCalibrationRow {
  id: string;
  predicted: number;
  outcome: number;
  tag: string | null;
  tool_name: string | null;
  ts: number;
}

// ---------------------------------------------------------------------------
// Bucket definitions (ordered low → high)
// ---------------------------------------------------------------------------

interface BucketDef {
  bucket: ConfidenceBucket;
  low: number;
  high: number;
}

const BUCKET_DEFS: readonly BucketDef[] = [
  { bucket: 'VERY_LOW', low: 0.0, high: 0.2 },
  { bucket: 'LOW',      low: 0.2, high: 0.4 },
  { bucket: 'MEDIUM',   low: 0.4, high: 0.6 },
  { bucket: 'HIGH',     low: 0.6, high: 0.8 },
  { bucket: 'VERY_HIGH', low: 0.8, high: 1.0 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine which bucket a predicted confidence value falls into.
 * Boundary rule: [low, high) for all except VERY_HIGH which uses [0.8, 1.0].
 */
function assignBucket(predicted: number): ConfidenceBucket {
  // Bound first: a negative/NaN predicted otherwise fails every `>= def.low`
  // test and falls through to the VERY_HIGH fallback — inverting the signal
  // (least-confident reported as most-confident). Clamp the out-of-range ends.
  if (!Number.isFinite(predicted) || predicted <= 0) return 'VERY_LOW';
  if (predicted >= 1) return 'VERY_HIGH';
  for (const def of BUCKET_DEFS) {
    if (def.bucket === 'VERY_HIGH') {
      // closed upper bound: predicted >= 0.8 and <= 1.0
      if (predicted >= def.low) return def.bucket;
    } else {
      // right-exclusive: [low, high)
      if (predicted >= def.low && predicted < def.high) return def.bucket;
    }
  }
  // Fallback — should only hit if predicted = 1.0 exactly in a non-VERY_HIGH bucket
  return 'VERY_HIGH';
}

/** Build the zero-entry report returned when no rows exist or on error. */
function emptyReport(windowDays: number): CalibrationReport {
  return {
    totalSamples: 0,
    brierScore: 0,
    overallAvgPredicted: 0,
    overallSuccessRate: 0,
    buckets: BUCKET_DEFS.map(def => ({
      bucket: def.bucket,
      rangeLow: def.low,
      rangeHigh: def.high,
      count: 0,
      avgPredicted: 0,
      actualSuccessRate: 0,
      calibrationError: 0,
    })),
    windowDays,
    computedAt: new Date().toISOString(),
  };
}

/** Compute a CalibrationReport from a set of raw rows. */
function computeReport(
  rows: RawCalibrationRow[],
  windowDays: number,
): CalibrationReport {
  if (rows.length === 0) {
    return emptyReport(windowDays);
  }

  // Per-bucket accumulators
  const bucketAccum: Map<
    ConfidenceBucket,
    { sumPredicted: number; sumOutcome: number; count: number }
  > = new Map(
    BUCKET_DEFS.map(d => [
      d.bucket,
      { sumPredicted: 0, sumOutcome: 0, count: 0 },
    ]),
  );

  let sumPredicted = 0;
  let sumOutcome = 0;
  let sumSquaredError = 0;
  let includedCount = 0;

  for (const row of rows) {
    const p = row.predicted;
    const o = row.outcome;

    // Skip poisoned rows: an outcome outside {0,1} (legacy data, relaxed CHECK,
    // upstream bug) yields a Brier term up to 4 — outside [0,1] — corrupting the
    // aggregate and potentially flipping calibration error direction.
    if (o !== 0 && o !== 1) {
      log.warn({ outcome: o, event: 'calibration.report.poisoned-row' }, 'computeReport: skipping row with non-binary outcome');
      continue;
    }

    sumPredicted += p;
    sumOutcome += o;
    sumSquaredError += (p - o) ** 2;
    includedCount += 1;

    const bucket = assignBucket(p);
    const acc = bucketAccum.get(bucket)!;
    acc.sumPredicted += p;
    acc.sumOutcome += o;
    acc.count += 1;
  }

  // All rows poisoned → nothing to report on.
  if (includedCount === 0) {
    return emptyReport(windowDays);
  }

  const n = includedCount;
  const brierScore = sumSquaredError / n;
  const overallAvgPredicted = sumPredicted / n;
  const overallSuccessRate = sumOutcome / n;

  const buckets: BucketStats[] = BUCKET_DEFS.map(def => {
    const acc = bucketAccum.get(def.bucket)!;
    if (acc.count === 0) {
      return {
        bucket: def.bucket,
        rangeLow: def.low,
        rangeHigh: def.high,
        count: 0,
        avgPredicted: 0,
        actualSuccessRate: 0,
        calibrationError: 0,
      };
    }
    const avgPredicted = acc.sumPredicted / acc.count;
    const actualSuccessRate = acc.sumOutcome / acc.count;
    const calibrationError = avgPredicted - actualSuccessRate;
    return {
      bucket: def.bucket,
      rangeLow: def.low,
      rangeHigh: def.high,
      count: acc.count,
      avgPredicted,
      actualSuccessRate,
      calibrationError,
    };
  });

  return {
    totalSamples: n,
    brierScore,
    overallAvgPredicted,
    overallSuccessRate,
    buckets,
    windowDays,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// ConfidenceCalibrationTracker
// ---------------------------------------------------------------------------

export class ConfidenceCalibrationTracker {
  // Explicit param tuple: a column reorder in the INSERT becomes a COMPILE error
  // (the load-bearing insert path was previously bind-by-arity with no checking).
  private readonly _stmtInsert: StatementLike<[string, number, 0 | 1, string | null, string | null, number], unknown>;
  private readonly _stmtListWindow: StatementLike<unknown[], RawCalibrationRow>;
  private readonly _stmtListWindowByTag: StatementLike<unknown[], RawCalibrationRow>;
  private readonly _stmtListWindowByToolName: StatementLike<unknown[], RawCalibrationRow>;
  private readonly _stmtListWindowByTagAndToolName: StatementLike<unknown[], RawCalibrationRow>;
  private readonly _stmtDeleteAll: StatementLike<unknown[], unknown>;

  constructor(db: DatabaseLike) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS confidence_calibration (
          id        TEXT PRIMARY KEY,
          predicted REAL NOT NULL,
          outcome   INTEGER NOT NULL CHECK(outcome IN (0,1)),
          tag       TEXT,
          tool_name TEXT,
          ts        INTEGER NOT NULL
        )
      `);
      // Additive migration for DBs created before tool_name existed.
      // - New DB: CREATE TABLE above already includes tool_name, so the
      //   ALTER below throws "duplicate column name" — caught.
      // - Legacy DB: CREATE TABLE IF NOT EXISTS no-ops on the old shape,
      //   then ALTER successfully adds the column.
      // - Already-migrated DB: ALTER throws duplicate-column — caught.
      // All three paths converge on a table that has the column.
      try {
        db.exec(`ALTER TABLE confidence_calibration ADD COLUMN tool_name TEXT`);
      } catch {
        // Column already present — nothing to do.
      }
    } catch (err: unknown) {
      log.error(
        { err, event: 'calibration.init.error' },
        'confidence-calibration-tracker: failed to create table',
      );
      // Subsequent calls will fail-open via per-method try/catch.
    }

    this._stmtInsert = db.prepare<unknown, [string, number, 0 | 1, string | null, string | null, number]>(
      `INSERT INTO confidence_calibration (id, predicted, outcome, tag, tool_name, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this._stmtListWindow = db.prepare<RawCalibrationRow>(
      `SELECT id, predicted, outcome, tag, tool_name, ts
       FROM confidence_calibration
       WHERE ts >= ?
       ORDER BY ts ASC`,
    );

    this._stmtListWindowByTag = db.prepare<RawCalibrationRow>(
      `SELECT id, predicted, outcome, tag, tool_name, ts
       FROM confidence_calibration
       WHERE ts >= ? AND tag = ?
       ORDER BY ts ASC`,
    );

    this._stmtListWindowByToolName = db.prepare<RawCalibrationRow>(
      `SELECT id, predicted, outcome, tag, tool_name, ts
       FROM confidence_calibration
       WHERE ts >= ? AND tool_name = ?
       ORDER BY ts ASC`,
    );

    this._stmtListWindowByTagAndToolName = db.prepare<RawCalibrationRow>(
      `SELECT id, predicted, outcome, tag, tool_name, ts
       FROM confidence_calibration
       WHERE ts >= ? AND tag = ? AND tool_name = ?
       ORDER BY ts ASC`,
    );

    this._stmtDeleteAll = db.prepare(
      `DELETE FROM confidence_calibration`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record a predicted confidence and observed outcome.
   * - Clamps predicted to [0,1].
   * - Silent no-op on NaN or Infinity (fail-open).
   * - DB errors are caught and logged (fail-open).
   *
   * `toolName` enables the verify-gate's per-tool Brier-by-tool lookup. The
   * column is nullable; legacy callers and unrelated calibration sources
   * (epistemic-tag records keyed by `tag` only) pass through as before.
   */
  record(predicted: number, outcome: 0 | 1, tag?: string, toolName?: string): void {
    // Guard against NaN / Infinity — silent no-op
    if (!Number.isFinite(predicted)) {
      log.debug(
        { predicted, event: 'calibration.record.invalid' },
        'confidence-calibration-tracker: non-finite predicted value — no-op',
      );
      return;
    }

    // Validate outcome at runtime: the `0 | 1` type is erased, so a JS caller
    // passing 2/true/NaN/"1" otherwise hits the SQLite CHECK and is silently
    // dropped by the catch below — biasing the dataset toward buggy callers.
    let outcomeInt: 0 | 1;
    if (outcome === 1) outcomeInt = 1;
    else if (outcome === 0) outcomeInt = 0;
    else {
      log.warn(
        { outcome, event: 'calibration.record.invalid-outcome' },
        'confidence-calibration-tracker: outcome must be 0 or 1 — no-op',
      );
      return;
    }

    const clamped = Math.max(0, Math.min(1, predicted));
    const id = randomUUID();
    const ts = Date.now();

    try {
      this._stmtInsert.run(id, clamped, outcomeInt, tag ?? null, toolName ?? null, ts);
      log.debug(
        { id, predicted: clamped, outcome: outcomeInt, tag, toolName, ts, event: 'calibration.recorded' },
        'confidence-calibration-tracker: entry recorded',
      );
    } catch (err: unknown) {
      log.error(
        { err, predicted: clamped, outcome, tag, toolName, event: 'calibration.record.error' },
        'confidence-calibration-tracker: DB insert failed (fail-open)',
      );
    }
  }

  /**
   * Compute calibration statistics over a rolling window.
   * Returns a zero-sample report on any DB error (fail-open).
   */
  getReport(opts?: GetReportOptions): CalibrationReport {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const tag = opts?.tag;
    const toolName = opts?.toolName;
    const cutoffTs = Date.now() - windowDays * MS_PER_DAY;
    const hasTag = tag !== undefined && tag !== null;
    const hasTool = toolName !== undefined && toolName !== null;

    try {
      let rows: RawCalibrationRow[];
      if (hasTag && hasTool) {
        rows = this._stmtListWindowByTagAndToolName.all(cutoffTs, tag, toolName);
      } else if (hasTag) {
        rows = this._stmtListWindowByTag.all(cutoffTs, tag);
      } else if (hasTool) {
        rows = this._stmtListWindowByToolName.all(cutoffTs, toolName);
      } else {
        rows = this._stmtListWindow.all(cutoffTs);
      }
      return computeReport(rows, windowDays);
    } catch (err: unknown) {
      log.error(
        { err, windowDays, tag, toolName, event: 'calibration.report.error' },
        'confidence-calibration-tracker: DB query failed; returning empty report (fail-open)',
      );
      return emptyReport(windowDays);
    }
  }

  /**
   * Wipe all calibration data. Fail-open — DB errors are caught and logged.
   * Intended for admin use and test teardown.
   */
  reset(): void {
    try {
      this._stmtDeleteAll.run();
      log.info(
        { event: 'calibration.reset' },
        'confidence-calibration-tracker: table cleared',
      );
    } catch (err: unknown) {
      log.error(
        { err, event: 'calibration.reset.error' },
        'confidence-calibration-tracker: reset failed (fail-open)',
      );
    }
  }
}
