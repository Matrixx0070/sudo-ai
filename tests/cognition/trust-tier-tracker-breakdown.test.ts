/**
 * @file tests/cognition/trust-tier-tracker-breakdown.test.ts
 * @description Wave 6O: getOutcomeBreakdown() tests for TrustTierTracker.
 *
 * Tests:
 *   BRKDWN-1  Empty DB → empty array
 *   BRKDWN-2  With data → correct kind/count/score per row
 *   BRKDWN-3  windowDays filter — rows outside window excluded
 *   BRKDWN-4  DB throw → empty array (fail-open)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { TrustTierTracker } from '../../src/core/cognition/trust-tier-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function makeDb(): Database {
  return new DatabaseConstructor(':memory:');
}

/** Directly insert a row into trust_outcomes for timestamp control. */
function rawInsert(db: Database, ts: number, kind: string, weight = 1.0): void {
  db.prepare(`INSERT INTO trust_outcomes (id, ts, kind, weight) VALUES (?, ?, ?, ?)`)
    .run(`test-${ts}-${kind}-${Math.random()}`, ts, kind, weight);
}

// ---------------------------------------------------------------------------
// BRKDWN-1: empty DB → empty array
// ---------------------------------------------------------------------------

describe('BRKDWN-1: getOutcomeBreakdown empty DB', () => {
  it('returns empty array when no outcomes recorded', () => {
    const db = makeDb();
    const tracker = new TrustTierTracker(db);
    const result = tracker.getOutcomeBreakdown();
    expect(result).toEqual([]);
  });

  it('returns empty array with explicit windowDays when no outcomes recorded', () => {
    const db = makeDb();
    const tracker = new TrustTierTracker(db);
    const result = tracker.getOutcomeBreakdown({ windowDays: 30 });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BRKDWN-2: with data → correct kind/count/score
// ---------------------------------------------------------------------------

describe('BRKDWN-2: getOutcomeBreakdown with data', () => {
  let db: Database;
  let tracker: TrustTierTracker;

  beforeEach(() => {
    db = makeDb();
    tracker = new TrustTierTracker(db);
  });

  it('returns correct count and score for injection-detected outcomes', () => {
    const now = Date.now();
    rawInsert(db, now - 1000, 'injection-detected', 1.0);
    rawInsert(db, now - 2000, 'injection-detected', 1.0);

    const result = tracker.getOutcomeBreakdown({ windowDays: 7 });
    const row = result.find(r => r.kind === 'injection-detected');
    expect(row).toBeDefined();
    expect(row!.count).toBe(2);
    // KIND_DELTAS['injection-detected'] = -2.5; total_weight = 2.0; score = -2.5 * 2.0 = -5.0
    expect(row!.score).toBeCloseTo(-5.0);
  });

  it('returns correct count and score for re-anchor outcomes', () => {
    const now = Date.now();
    rawInsert(db, now - 1000, 're-anchor', 1.0);

    const result = tracker.getOutcomeBreakdown();
    const row = result.find(r => r.kind === 're-anchor');
    expect(row).toBeDefined();
    expect(row!.count).toBe(1);
    // KIND_DELTAS['re-anchor'] = 0.5; total_weight = 1.0; score = 0.5 * 1.0 = 0.5
    expect(row!.score).toBeCloseTo(0.5);
  });

  it('groups multiple kinds correctly', () => {
    const now = Date.now();
    rawInsert(db, now - 1000, 'injection-detected', 1.0);
    rawInsert(db, now - 2000, 'success', 1.0);
    rawInsert(db, now - 3000, 'success', 1.0);

    const result = tracker.getOutcomeBreakdown({ windowDays: 7 });
    const injRow = result.find(r => r.kind === 'injection-detected');
    const sucRow = result.find(r => r.kind === 'success');

    expect(injRow).toBeDefined();
    expect(injRow!.count).toBe(1);
    expect(injRow!.score).toBeCloseTo(-2.5);

    expect(sucRow).toBeDefined();
    expect(sucRow!.count).toBe(2);
    // KIND_DELTAS['success'] = 1.0; score = 1.0 * 2.0 = 2.0
    expect(sucRow!.score).toBeCloseTo(2.0);
  });

  it('score=0 for unknown kind (no delta defined)', () => {
    const db2 = makeDb();
    // Directly insert a row with an unknown kind bypassing the public API
    db2.exec(`CREATE TABLE IF NOT EXISTS trust_outcomes (id TEXT NOT NULL PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0)`);
    db2.prepare(`INSERT INTO trust_outcomes (id, ts, kind, weight) VALUES (?, ?, ?, ?)`).run('u1', Date.now() - 1000, 'unknown-kind', 1.0);
    const tracker2 = new TrustTierTracker(db2);
    const result = tracker2.getOutcomeBreakdown({ windowDays: 7 });
    const row = result.find(r => r.kind === 'unknown-kind');
    expect(row).toBeDefined();
    expect(row!.score).toBeCloseTo(0);
  });
});

// ---------------------------------------------------------------------------
// BRKDWN-3: windowDays filter — rows outside window excluded
// ---------------------------------------------------------------------------

describe('BRKDWN-3: getOutcomeBreakdown windowDays filter', () => {
  it('excludes rows older than windowDays', () => {
    const db = makeDb();
    const tracker = new TrustTierTracker(db);
    const now = Date.now();

    // Inside 3-day window
    rawInsert(db, now - 1 * MS_PER_DAY, 'injection-detected', 1.0);
    // Outside 3-day window (4 days ago)
    rawInsert(db, now - 4 * MS_PER_DAY, 'injection-detected', 1.0);

    const result = tracker.getOutcomeBreakdown({ windowDays: 3 });
    const row = result.find(r => r.kind === 'injection-detected');
    expect(row).toBeDefined();
    // Only 1 row within 3-day window
    expect(row!.count).toBe(1);
    expect(row!.score).toBeCloseTo(-2.5);
  });

  it('includes all rows when windowDays is large', () => {
    const db = makeDb();
    const tracker = new TrustTierTracker(db);
    const now = Date.now();

    rawInsert(db, now - 1 * MS_PER_DAY, 'injection-detected', 1.0);
    rawInsert(db, now - 50 * MS_PER_DAY, 'injection-detected', 1.0);

    const result = tracker.getOutcomeBreakdown({ windowDays: 90 });
    const row = result.find(r => r.kind === 'injection-detected');
    expect(row).toBeDefined();
    expect(row!.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// BRKDWN-4: DB throw → empty array (fail-open)
// ---------------------------------------------------------------------------

describe('BRKDWN-4: getOutcomeBreakdown DB throw → fail-open', () => {
  it('returns empty array when prepared statement throws', () => {
    const db = makeDb();
    const tracker = new TrustTierTracker(db);

    // Close the DB to cause all queries to throw
    db.close();

    const result = tracker.getOutcomeBreakdown({ windowDays: 7 });
    expect(result).toEqual([]);
  });
});
