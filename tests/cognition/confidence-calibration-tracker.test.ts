/**
 * Tests for confidence-calibration-tracker.ts — Wave 6K Builder B.
 *
 * Uses in-memory SQLite for real path tests and a mock DatabaseLike for
 * DB-throw fail-open coverage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import {
  ConfidenceCalibrationTracker,
} from '../../src/core/cognition/confidence-calibration-tracker.js';
import type {
  CalibrationReport,
  BucketStats,
  ConfidenceBucket,
  DatabaseLike,
} from '../../src/core/cognition/confidence-calibration-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function makeDb(): Database {
  return new DatabaseConstructor(':memory:');
}

/** Direct raw-insert bypassing record() so we can control ts precisely. */
function rawInsert(
  db: Database,
  predicted: number,
  outcome: 0 | 1,
  ts: number,
  tag?: string,
): void {
  db.prepare(
    `INSERT INTO confidence_calibration (id, predicted, outcome, tag, ts)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`test-${ts}-${predicted}`, predicted, outcome, tag ?? null, ts);
}

/** Build a mock DatabaseLike whose prepared-statement methods throw. */
function makeThrowingDb(): DatabaseLike {
  const throwingStmt = {
    run: (..._args: unknown[]): unknown => {
      throw new Error('DB unavailable');
    },
    all: (..._args: unknown[]): unknown[] => {
      throw new Error('DB unavailable');
    },
  };
  return {
    exec: (_sql: string): void => {
      // exec succeeds so constructor completes; statement calls throw later
    },
    prepare: (_sql: string) => throwingStmt as ReturnType<DatabaseLike['prepare']>,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfidenceCalibrationTracker', () => {
  let db: Database;
  let tracker: ConfidenceCalibrationTracker;

  beforeEach(() => {
    db = makeDb();
    tracker = new ConfidenceCalibrationTracker(db);
  });

  // 1 — empty DB → zero Brier, 5 empty buckets
  it('returns zero Brier and 5 empty buckets when DB is empty', () => {
    const report: CalibrationReport = tracker.getReport();
    expect(report.totalSamples).toBe(0);
    expect(report.brierScore).toBe(0);
    expect(report.overallAvgPredicted).toBe(0);
    expect(report.overallSuccessRate).toBe(0);
    expect(report.buckets).toHaveLength(5);

    const bucketOrder: ConfidenceBucket[] = [
      'VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH',
    ];
    report.buckets.forEach((b, i) => {
      expect(b.bucket).toBe(bucketOrder[i]);
      expect(b.count).toBe(0);
      expect(b.avgPredicted).toBe(0);
      expect(b.actualSuccessRate).toBe(0);
      expect(b.calibrationError).toBe(0);
    });
  });

  // 2 — perfect prediction: always 1.0 predicted + always outcome 1 → Brier 0
  it('returns Brier 0 for perfect prediction (confidence=1 + outcome=1)', () => {
    for (let i = 0; i < 10; i++) {
      tracker.record(1.0, 1);
    }
    const report: CalibrationReport = tracker.getReport();
    expect(report.totalSamples).toBe(10);
    expect(report.brierScore).toBeCloseTo(0, 9);
  });

  // 3 — worst prediction: always 1.0 confidence + always outcome 0 → Brier 1
  it('returns Brier 1 for worst prediction (confidence=1 + outcome=0)', () => {
    for (let i = 0; i < 5; i++) {
      tracker.record(1.0, 0);
    }
    const report: CalibrationReport = tracker.getReport();
    expect(report.totalSamples).toBe(5);
    expect(report.brierScore).toBeCloseTo(1.0, 9);
  });

  // 4 — mixed calibration: verify bucket counts and calibrationError signs
  it('computes bucket stats and calibration error signs for mixed data', () => {
    // 3 rows in VERY_HIGH bucket: predicted=0.9, outcome=1 → calibration ~0 (perfect)
    tracker.record(0.9, 1);
    tracker.record(0.9, 1);
    tracker.record(0.9, 1);
    // 2 rows in LOW bucket: predicted=0.3, outcome=1 → overconfident for LOW
    //   avgPredicted=0.3, actualSuccessRate=1.0 → calibrationError = -0.7 (under-confident)
    tracker.record(0.3, 1);
    tracker.record(0.3, 1);

    const report: CalibrationReport = tracker.getReport();
    expect(report.totalSamples).toBe(5);

    const veryHigh: BucketStats = report.buckets.find(b => b.bucket === 'VERY_HIGH')!;
    expect(veryHigh.count).toBe(3);
    // avgPredicted=0.9, actualSuccessRate=1.0 → calibrationError = -0.1 (under-confident)
    expect(veryHigh.calibrationError).toBeCloseTo(-0.1, 5);

    const low: BucketStats = report.buckets.find(b => b.bucket === 'LOW')!;
    expect(low.count).toBe(2);
    expect(low.avgPredicted).toBeCloseTo(0.3, 5);
    expect(low.actualSuccessRate).toBeCloseTo(1.0, 5);
    expect(low.calibrationError).toBeCloseTo(-0.7, 5); // under-predicted
  });

  // 5 — windowDays filter excludes old rows
  it('excludes rows older than windowDays', () => {
    // Insert row 35 days ago (outside default 30-day window)
    rawInsert(db, 0.8, 1, Date.now() - 35 * MS_PER_DAY);
    // Insert row 5 days ago (inside window)
    rawInsert(db, 0.8, 1, Date.now() - 5 * MS_PER_DAY);

    const report: CalibrationReport = tracker.getReport({ windowDays: 30 });
    expect(report.totalSamples).toBe(1);
  });

  // 6 — tag filter returns only matching rows
  it('filters by tag correctly', () => {
    tracker.record(0.7, 1, 'CERTAIN');
    tracker.record(0.7, 1, 'CERTAIN');
    tracker.record(0.5, 0, 'CONJECTURE');

    const certainReport = tracker.getReport({ tag: 'CERTAIN' });
    expect(certainReport.totalSamples).toBe(2);

    const conjectureReport = tracker.getReport({ tag: 'CONJECTURE' });
    expect(conjectureReport.totalSamples).toBe(1);

    // No tag filter → all 3
    const allReport = tracker.getReport();
    expect(allReport.totalSamples).toBe(3);
  });

  // 7 — record(NaN) is silent no-op
  it('record(NaN) is a silent no-op', () => {
    expect(() => tracker.record(NaN, 1)).not.toThrow();
    const report = tracker.getReport();
    expect(report.totalSamples).toBe(0);
  });

  // 8 — record(2.5) clamps to 1.0
  it('clamps predicted=2.5 to 1.0 before storing', () => {
    tracker.record(2.5, 1);
    const report = tracker.getReport();
    expect(report.totalSamples).toBe(1);
    // Brier: (1.0 - 1)^2 = 0
    expect(report.brierScore).toBeCloseTo(0, 9);
    const veryHigh = report.buckets.find(b => b.bucket === 'VERY_HIGH')!;
    expect(veryHigh.count).toBe(1);
    expect(veryHigh.avgPredicted).toBeCloseTo(1.0, 5);
  });

  // 9 — reset() clears table
  it('reset() wipes all calibration data', () => {
    tracker.record(0.8, 1);
    tracker.record(0.6, 0);
    expect(tracker.getReport().totalSamples).toBe(2);

    tracker.reset();
    expect(tracker.getReport().totalSamples).toBe(0);
  });

  // 10 — DB-throw fail-open: getReport returns zero-sample report
  it('getReport returns zero-sample report when DB throws (fail-open)', () => {
    const throwingTracker = new ConfidenceCalibrationTracker(makeThrowingDb());
    expect(() => throwingTracker.getReport()).not.toThrow();
    const report = throwingTracker.getReport();
    expect(report.totalSamples).toBe(0);
    expect(report.brierScore).toBe(0);
    expect(report.buckets).toHaveLength(5);
  });

  // 11 — DB-throw fail-open: record does not throw
  it('record() does not throw when DB throws (fail-open)', () => {
    const throwingTracker = new ConfidenceCalibrationTracker(makeThrowingDb());
    expect(() => throwingTracker.record(0.5, 1)).not.toThrow();
  });

  // 12 — DB-throw fail-open: reset does not throw
  it('reset() does not throw when DB throws (fail-open)', () => {
    const throwingTracker = new ConfidenceCalibrationTracker(makeThrowingDb());
    expect(() => throwingTracker.reset()).not.toThrow();
  });

  // 13 — boundary: predicted=0.2 falls into LOW bucket (not VERY_LOW)
  it('predicted=0.2 is assigned to LOW bucket (right-exclusive VERY_LOW boundary)', () => {
    tracker.record(0.2, 1);
    const report = tracker.getReport();
    const veryLow = report.buckets.find(b => b.bucket === 'VERY_LOW')!;
    const low = report.buckets.find(b => b.bucket === 'LOW')!;
    expect(veryLow.count).toBe(0); // 0.2 is NOT in VERY_LOW [0,0.2)
    expect(low.count).toBe(1);     // 0.2 IS in LOW [0.2,0.4)
  });

  // 14 — predicted=0.0 falls into VERY_LOW bucket
  it('predicted=0.0 falls into VERY_LOW bucket', () => {
    tracker.record(0.0, 0);
    const veryLow = tracker.getReport().buckets.find(b => b.bucket === 'VERY_LOW')!;
    expect(veryLow.count).toBe(1);
  });

  // 15 — predicted=1.0 falls into VERY_HIGH bucket (closed upper bound)
  it('predicted=1.0 falls into VERY_HIGH bucket (closed upper bound)', () => {
    tracker.record(1.0, 1);
    const veryHigh = tracker.getReport().buckets.find(b => b.bucket === 'VERY_HIGH')!;
    expect(veryHigh.count).toBe(1);
  });

  // 16 — record(Infinity) is silent no-op
  it('record(Infinity) is a silent no-op', () => {
    expect(() => tracker.record(Infinity, 0)).not.toThrow();
    expect(tracker.getReport().totalSamples).toBe(0);
  });

  // 17 — record(-Infinity) is silent no-op
  it('record(-Infinity) is a silent no-op', () => {
    expect(() => tracker.record(-Infinity, 1)).not.toThrow();
    expect(tracker.getReport().totalSamples).toBe(0);
  });

  // 18 — negative clamping: predicted=-0.5 clamps to 0.0
  it('clamps predicted=-0.5 to 0.0 and stores in VERY_LOW', () => {
    tracker.record(-0.5, 0);
    const report = tracker.getReport();
    expect(report.totalSamples).toBe(1);
    const veryLow = report.buckets.find(b => b.bucket === 'VERY_LOW')!;
    expect(veryLow.count).toBe(1);
    expect(veryLow.avgPredicted).toBeCloseTo(0.0, 5);
  });

  // 19 — windowDays custom value respected
  it('respects custom windowDays in getReport', () => {
    rawInsert(db, 0.5, 1, Date.now() - 3 * MS_PER_DAY);
    rawInsert(db, 0.5, 1, Date.now() - 8 * MS_PER_DAY);
    rawInsert(db, 0.5, 1, Date.now() - 15 * MS_PER_DAY);

    // Only 7-day window → 1 row
    expect(tracker.getReport({ windowDays: 7 }).totalSamples).toBe(1);
    // 10-day window → 2 rows
    expect(tracker.getReport({ windowDays: 10 }).totalSamples).toBe(2);
    // 20-day window → 3 rows
    expect(tracker.getReport({ windowDays: 20 }).totalSamples).toBe(3);
  });

  // 20 — Brier score is correct on known values
  it('computes correct Brier score on a known mixed set', () => {
    // predicted=0.8, outcome=1: (0.8-1)^2 = 0.04
    // predicted=0.6, outcome=0: (0.6-0)^2 = 0.36
    // Brier = (0.04 + 0.36) / 2 = 0.20
    tracker.record(0.8, 1);
    tracker.record(0.6, 0);
    const report = tracker.getReport();
    expect(report.totalSamples).toBe(2);
    expect(report.brierScore).toBeCloseTo(0.20, 5);
  });
});
