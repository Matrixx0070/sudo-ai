/**
 * Tests for commitment-resolution-tracker.ts — Wave 6M Builder B.
 *
 * Uses in-memory SQLite for real-path tests and a mock DatabaseLike for
 * DB-throw fail-open coverage.
 *
 * Wall-clock-sensitive windowDays tests anchor timestamps to
 * `Math.floor(now / bucketMs) * bucketMs + margin` per lessons.md to avoid
 * bucket-boundary flakiness.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import {
  CommitmentResolutionTracker,
} from '../../src/core/cognition/commitment-resolution-tracker.js';
import type {
  CommitmentResolution,
  ResolutionEntry,
  ResolutionStats,
  DatabaseLike,
} from '../../src/core/cognition/commitment-resolution-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function makeDb(): Database {
  return new DatabaseConstructor(':memory:');
}

/**
 * Raw-insert a resolution row with precise ts control, bypassing resolve().
 * Useful for windowDays filtering tests.
 */
function rawInsert(
  db: Database,
  commitmentRef: string,
  resolution: CommitmentResolution,
  ts: number,
  notes?: string,
): void {
  db.prepare(
    `INSERT INTO commitment_resolutions (id, commitment_ref, resolution, ts, notes)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`raw-${ts}-${commitmentRef}`, commitmentRef, resolution, ts, notes ?? null);
}

/**
 * Build a mock DatabaseLike whose prepared-statement methods throw.
 * exec() succeeds so the constructor completes; statement calls throw later.
 */
function makeThrowingDb(): DatabaseLike {
  const throwingStmt = {
    run: (..._args: unknown[]): unknown => {
      throw new Error('DB unavailable');
    },
    all: (..._args: unknown[]): unknown[] => {
      throw new Error('DB unavailable');
    },
    get: (..._args: unknown[]): unknown => {
      throw new Error('DB unavailable');
    },
  };
  return {
    exec: (_sql: string): void => { /* noop — allow constructor to complete */ },
    prepare: (_sql: string) => throwingStmt as ReturnType<DatabaseLike['prepare']>,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommitmentResolutionTracker', () => {
  let db: Database;
  let tracker: CommitmentResolutionTracker;

  beforeEach(() => {
    db = makeDb();
    tracker = new CommitmentResolutionTracker(db);
  });

  // -------------------------------------------------------------------------
  // 1 — empty DB baseline
  // -------------------------------------------------------------------------

  it('empty DB: getStats returns zeros, getResolutions is empty, isResolved is false', () => {
    const stats: ResolutionStats = tracker.getStats();
    expect(stats.total).toBe(0);
    expect(stats.honored).toBe(0);
    expect(stats.abandoned).toBe(0);
    expect(stats.expiredAcknowledged).toBe(0);
    expect(stats.honorRate).toBe(0);

    expect(tracker.getResolutions()).toHaveLength(0);
    expect(tracker.isResolved('nonexistent-ref')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2 — resolve() happy path
  // -------------------------------------------------------------------------

  it('resolve() returns a valid ResolutionEntry and isResolved becomes true', () => {
    const entry: ResolutionEntry | null = tracker.resolve('c1', 'honored');

    expect(entry).not.toBeNull();
    expect(entry!.commitmentRef).toBe('c1');
    expect(entry!.resolution).toBe('honored');
    expect(typeof entry!.id).toBe('string');
    expect(entry!.id.length).toBeGreaterThan(0);
    expect(typeof entry!.ts).toBe('number');
    expect(entry!.ts).toBeGreaterThan(0);

    expect(tracker.isResolved('c1')).toBe(true);

    const stats = tracker.getStats();
    expect(stats.honored).toBe(1);
    expect(stats.total).toBe(1);
    expect(stats.honorRate).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3 — duplicate resolution for same ref returns null
  // -------------------------------------------------------------------------

  it('resolve() duplicate for same commitmentRef returns null (no second row)', () => {
    const first = tracker.resolve('c1', 'honored');
    expect(first).not.toBeNull();

    const second = tracker.resolve('c1', 'abandoned');
    expect(second).toBeNull();

    // Only 1 row in DB
    const resolutions = tracker.getResolutions();
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.resolution).toBe('honored');
  });

  // -------------------------------------------------------------------------
  // 4 — invalid resolution enum returns null silently
  // -------------------------------------------------------------------------

  it('resolve() with invalid enum returns null without throwing', () => {
    // Cast to bypass TypeScript — simulates runtime caller with bad value
    const result = tracker.resolve('c2', 'bogus-value' as CommitmentResolution);
    expect(result).toBeNull();
    expect(tracker.getResolutions()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5 — notes truncated to 200 chars
  // -------------------------------------------------------------------------

  it('resolve() stores notes truncated to 200 chars when input is 300 chars', () => {
    const longNotes = 'x'.repeat(300);
    const entry = tracker.resolve('c3', 'honored', longNotes);
    expect(entry).not.toBeNull();
    expect(entry!.notes).toHaveLength(200);

    // Confirm via getResolutions
    const list = tracker.getResolutions();
    expect(list[0]!.notes).toHaveLength(200);
  });

  // -------------------------------------------------------------------------
  // 6 — undefined notes stored as null (no notes field on entry)
  // -------------------------------------------------------------------------

  it('resolve() with undefined notes stores null and entry has no notes field', () => {
    const entry = tracker.resolve('c4', 'honored');
    expect(entry).not.toBeNull();
    expect(entry!.notes).toBeUndefined();

    const list = tracker.getResolutions();
    expect(list[0]!.notes).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 7 — getResolutions filters by resolution type
  // -------------------------------------------------------------------------

  it('getResolutions() filters by resolution type', () => {
    tracker.resolve('c1', 'honored');
    tracker.resolve('c2', 'abandoned');
    tracker.resolve('c3', 'expired-acknowledged');

    const honored = tracker.getResolutions({ resolution: 'honored' });
    expect(honored).toHaveLength(1);
    expect(honored[0]!.resolution).toBe('honored');

    const abandoned = tracker.getResolutions({ resolution: 'abandoned' });
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.resolution).toBe('abandoned');

    const expired = tracker.getResolutions({ resolution: 'expired-acknowledged' });
    expect(expired).toHaveLength(1);
    expect(expired[0]!.resolution).toBe('expired-acknowledged');

    // No filter → all 3
    expect(tracker.getResolutions()).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 8 — getResolutions filters by windowDays
  //     Anchored to 15-min bucket boundary per lessons.md to avoid flakiness.
  // -------------------------------------------------------------------------

  it('getResolutions() filters by windowDays (anchored timestamp)', () => {
    // Anchor: snap to current 15-min bucket start + 1 second margin
    const bucketMs = 15 * 60_000;
    const now = Date.now();
    const bucketStart = Math.floor(now / bucketMs) * bucketMs + 1_000;

    // Insert 3 rows at precise controlled timestamps
    rawInsert(db, 'old-ref', 'honored', bucketStart - 35 * MS_PER_DAY);  // 35 days ago
    rawInsert(db, 'mid-ref', 'abandoned', bucketStart - 10 * MS_PER_DAY); // 10 days ago
    rawInsert(db, 'new-ref', 'honored', bucketStart - 2 * MS_PER_DAY);   // 2 days ago

    // Default 30-day window → 2 rows (mid + new)
    const all30 = tracker.getResolutions({ windowDays: 30 });
    expect(all30).toHaveLength(2);

    // 5-day window → 1 row (new only)
    const all5 = tracker.getResolutions({ windowDays: 5 });
    expect(all5).toHaveLength(1);
    expect(all5[0]!.commitmentRef).toBe('new-ref');

    // 40-day window → all 3 rows
    const all40 = tracker.getResolutions({ windowDays: 40 });
    expect(all40).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 9 — getStats honorRate: 3 honored + 1 abandoned = 0.75
  // -------------------------------------------------------------------------

  it('getStats() computes honorRate 0.75 for 3 honored + 1 abandoned', () => {
    tracker.resolve('c1', 'honored');
    tracker.resolve('c2', 'honored');
    tracker.resolve('c3', 'honored');
    tracker.resolve('c4', 'abandoned');

    const stats = tracker.getStats();
    expect(stats.total).toBe(4);
    expect(stats.honored).toBe(3);
    expect(stats.abandoned).toBe(1);
    expect(stats.expiredAcknowledged).toBe(0);
    expect(stats.honorRate).toBeCloseTo(0.75, 9);
  });

  // -------------------------------------------------------------------------
  // 10 — getStats honorRate = 0 when no rows
  // -------------------------------------------------------------------------

  it('getStats() returns honorRate=0 when there are no rows', () => {
    const stats = tracker.getStats();
    expect(stats.honorRate).toBe(0);
    expect(stats.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11 — DB-throw fail-open: resolve returns null
  // -------------------------------------------------------------------------

  it('resolve() returns null when DB throws (fail-open)', () => {
    const throwingTracker = new CommitmentResolutionTracker(makeThrowingDb());
    // isResolved() also throws (fail-open → false), so duplicate guard passes;
    // then insert throws → null returned
    expect(() => throwingTracker.resolve('c1', 'honored')).not.toThrow();
    const result = throwingTracker.resolve('c1', 'honored');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 12 — DB-throw fail-open: getStats returns zero-stats
  // -------------------------------------------------------------------------

  it('getStats() returns zero-stats when DB throws (fail-open)', () => {
    const throwingTracker = new CommitmentResolutionTracker(makeThrowingDb());
    expect(() => throwingTracker.getStats()).not.toThrow();
    const stats = throwingTracker.getStats();
    expect(stats.total).toBe(0);
    expect(stats.honored).toBe(0);
    expect(stats.abandoned).toBe(0);
    expect(stats.expiredAcknowledged).toBe(0);
    expect(stats.honorRate).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 13 — limit clamp: resolve 10 rows, getResolutions({limit:3}) returns 3
  // -------------------------------------------------------------------------

  it('getResolutions() limit clamp: 10 rows inserted, limit=3 returns 3', () => {
    for (let i = 0; i < 10; i++) {
      tracker.resolve(`ref-${i}`, 'honored');
    }
    const limited = tracker.getResolutions({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 14 — 'expired-acknowledged' counts in honorRate denominator
  // -------------------------------------------------------------------------

  it("'expired-acknowledged' counts in honorRate denominator", () => {
    tracker.resolve('c1', 'honored');
    tracker.resolve('c2', 'expired-acknowledged');
    tracker.resolve('c3', 'expired-acknowledged');

    const stats = tracker.getStats();
    expect(stats.total).toBe(3);
    expect(stats.honored).toBe(1);
    expect(stats.abandoned).toBe(0);
    expect(stats.expiredAcknowledged).toBe(2);
    // honorRate = 1 / (1 + 0 + 2) = 1/3
    expect(stats.honorRate).toBeCloseTo(1 / 3, 9);
  });

  // -------------------------------------------------------------------------
  // 15 — DB-throw fail-open: getResolutions returns empty array
  // -------------------------------------------------------------------------

  it('getResolutions() returns empty array when DB throws (fail-open)', () => {
    const throwingTracker = new CommitmentResolutionTracker(makeThrowingDb());
    expect(() => throwingTracker.getResolutions()).not.toThrow();
    expect(throwingTracker.getResolutions()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 16 — isResolved fail-open: returns false when DB throws
  // -------------------------------------------------------------------------

  it('isResolved() returns false when DB throws (fail-open)', () => {
    const throwingTracker = new CommitmentResolutionTracker(makeThrowingDb());
    expect(() => throwingTracker.isResolved('any-ref')).not.toThrow();
    expect(throwingTracker.isResolved('any-ref')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 17 — resolve all three valid enum values successfully
  // -------------------------------------------------------------------------

  it('resolve() accepts all three valid resolution enum values', () => {
    const e1 = tracker.resolve('c1', 'honored');
    const e2 = tracker.resolve('c2', 'abandoned');
    const e3 = tracker.resolve('c3', 'expired-acknowledged');

    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(e3).not.toBeNull();
    expect(e1!.resolution).toBe('honored');
    expect(e2!.resolution).toBe('abandoned');
    expect(e3!.resolution).toBe('expired-acknowledged');
  });

  // -------------------------------------------------------------------------
  // 18 — getStats windowDays filters by time (anchored)
  // -------------------------------------------------------------------------

  it('getStats() respects windowDays filter (anchored timestamp)', () => {
    const bucketMs = 15 * 60_000;
    const now = Date.now();
    const bucketStart = Math.floor(now / bucketMs) * bucketMs + 1_000;

    rawInsert(db, 'old-ref', 'honored', bucketStart - 40 * MS_PER_DAY);  // 40 days ago
    rawInsert(db, 'new-ref1', 'honored', bucketStart - 2 * MS_PER_DAY);  // 2 days ago
    rawInsert(db, 'new-ref2', 'abandoned', bucketStart - 2 * MS_PER_DAY); // 2 days ago

    // 30-day window → 2 rows (new-ref1 + new-ref2)
    const stats30 = tracker.getStats({ windowDays: 30 });
    expect(stats30.total).toBe(2);
    expect(stats30.honored).toBe(1);
    expect(stats30.abandoned).toBe(1);
    expect(stats30.honorRate).toBeCloseTo(0.5, 9);

    // 50-day window → all 3 rows
    const stats50 = tracker.getStats({ windowDays: 50 });
    expect(stats50.total).toBe(3);
    expect(stats50.honored).toBe(2);
    expect(stats50.abandoned).toBe(1);
    expect(stats50.honorRate).toBeCloseTo(2 / 3, 9);
  });

  // -------------------------------------------------------------------------
  // 19 — limit clamp enforces minimum of 1
  // -------------------------------------------------------------------------

  it('getResolutions() limit clamp enforces minimum of 1', () => {
    tracker.resolve('c1', 'honored');
    tracker.resolve('c2', 'honored');

    // Passing limit=0 should clamp to 1
    const result = tracker.getResolutions({ limit: 0 });
    expect(result).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 20 — getResolutions returns newest first (ORDER BY ts DESC)
  // -------------------------------------------------------------------------

  it('getResolutions() returns rows ordered newest-first', () => {
    const bucketMs = 15 * 60_000;
    const now = Date.now();
    const bucketStart = Math.floor(now / bucketMs) * bucketMs + 1_000;

    rawInsert(db, 'oldest', 'honored', bucketStart - 5 * MS_PER_DAY);
    rawInsert(db, 'middle', 'abandoned', bucketStart - 3 * MS_PER_DAY);
    rawInsert(db, 'newest', 'expired-acknowledged', bucketStart - 1 * MS_PER_DAY);

    const rows = tracker.getResolutions({ windowDays: 10 });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.commitmentRef).toBe('newest');
    expect(rows[1]!.commitmentRef).toBe('middle');
    expect(rows[2]!.commitmentRef).toBe('oldest');
  });
});
