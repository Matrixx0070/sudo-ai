/**
 * Tests for trust-tier-tracker.ts — Wave 6I Builder B.
 *
 * Uses an in-memory SQLite DB. The TrustTierTracker constructor handles
 * CREATE TABLE IF NOT EXISTS, so tests receive a fresh DB directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { TrustTierTracker } from '../../src/core/cognition/trust-tier-tracker.js';
import type { TrustTier, AuditSnapshot, OutcomeRecord } from '../../src/core/cognition/trust-tier-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function makeDb(): Database {
  return new DatabaseConstructor(':memory:');
}

/** Shorthand: build an outcome record at a given age in days from now. */
function outcome(
  kind: OutcomeRecord['kind'],
  ageDays = 0,
  weight = 1.0,
): OutcomeRecord {
  return {
    timestamp: Date.now() - ageDays * MS_PER_DAY,
    kind,
    weight,
  };
}

/** Directly insert a row into trust_outcomes bypassing recordOutcome (for timestamp control). */
function rawInsert(db: Database, ts: number, kind: string, weight = 1.0): void {
  db.prepare(`INSERT INTO trust_outcomes (id, ts, kind, weight) VALUES (?, ?, ?, ?)`)
    .run(`test-${ts}-${kind}`, ts, kind, weight);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrustTierTracker', () => {
  let db: Database;
  let tracker: TrustTierTracker;

  beforeEach(() => {
    db = makeDb();
    tracker = new TrustTierTracker(db);
  });

  // 1. Fresh DB → MEDIUM tier, score 0.5
  it('returns MEDIUM tier and score 0.5 when DB is empty', () => {
    const tier: TrustTier = tracker.getCurrentTier();
    const score: number = tracker.getScore();
    expect(tier).toBe('MEDIUM');
    expect(score).toBe(0.5);
  });

  // 2. 5 successes → HIGH tier
  it('promotes to HIGH after 5 success outcomes', () => {
    // 5 successes: each +1.0 base × 1.0 weight = +5.0
    // score = clamp(0.5 + 5/20, 0, 1) = 0.75 → HIGH
    for (let i = 0; i < 5; i++) {
      tracker.recordOutcome(outcome('success'));
    }
    const tier: TrustTier = tracker.getCurrentTier();
    const score: number = tracker.getScore();
    expect(tier).toBe('HIGH');
    expect(score).toBeCloseTo(0.75, 5);
  });

  // 3. 5 failures → LOW or PROBATION
  it('drops to LOW or PROBATION after 5 failure outcomes', () => {
    // 5 failures: each -1.0 × 1.0 = -5.0
    // score = clamp(0.5 + (-5)/20, 0, 1) = 0.25 → LOW
    for (let i = 0; i < 5; i++) {
      tracker.recordOutcome(outcome('failure'));
    }
    const tier: TrustTier = tracker.getCurrentTier();
    const score: number = tracker.getScore();
    expect(['LOW', 'PROBATION']).toContain(tier);
    expect(score).toBeLessThanOrEqual(0.5);
  });

  // 4. Mix of success + conjecture-commit → score drops significantly
  it('conjecture-commit weighs heavily against successes', () => {
    // 3 successes: +3.0; 2 conjecture-commits: -4.0 → sum = -1.0
    // score = clamp(0.5 + (-1)/20) = 0.45 → LOW
    for (let i = 0; i < 3; i++) {
      tracker.recordOutcome(outcome('success'));
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordOutcome(outcome('conjecture-commit'));
    }
    const tier: TrustTier = tracker.getCurrentTier();
    const score: number = tracker.getScore();
    expect(tier).toBe('LOW');
    expect(score).toBeCloseTo(0.45, 5);
  });

  // 5. Window decay: outcome 8 days old is excluded
  it('excludes outcomes older than 7 days from score', () => {
    // Insert an old outcome (8 days ago) directly to control timestamp
    rawInsert(db, Date.now() - 8 * MS_PER_DAY, 'success', 1.0);
    // No outcomes in window → MEDIUM
    const tier: TrustTier = tracker.getCurrentTier();
    const score: number = tracker.getScore();
    expect(tier).toBe('MEDIUM');
    expect(score).toBe(0.5);
  });

  // 6. commitment-honored pattern → HIGH
  it('promotes to HIGH with commitment-honored outcomes', () => {
    // 3 commitment-honored: +1.5 each = +4.5
    // score = clamp(0.5 + 4.5/20) = 0.725 — still MEDIUM (just under 0.75)
    // Use 4 to push past 0.75: 4 × 1.5 = +6.0 → 0.5 + 6/20 = 0.8 → HIGH
    for (let i = 0; i < 4; i++) {
      tracker.recordOutcome(outcome('commitment-honored'));
    }
    const tier: TrustTier = tracker.getCurrentTier();
    expect(tier).toBe('HIGH');
  });

  // 7. commitment-expired pattern → LOW tier
  it('drops to LOW with repeated commitment-expired outcomes', () => {
    // 5 commitment-expired: each -1.0 → sum = -5.0
    // score = clamp(0.5 + (-5)/20) = 0.25 → LOW
    for (let i = 0; i < 5; i++) {
      tracker.recordOutcome(outcome('commitment-expired'));
    }
    const tier: TrustTier = tracker.getCurrentTier();
    const score: number = tracker.getScore();
    expect(tier).toBe('LOW');
    expect(score).toBeCloseTo(0.25, 5);
  });

  // 8. getAuditSnapshot returns all required fields
  it('getAuditSnapshot returns a fully populated snapshot', () => {
    tracker.recordOutcome(outcome('success'));
    tracker.recordOutcome(outcome('veto'));

    const snap: AuditSnapshot = tracker.getAuditSnapshot();

    expect(snap).toHaveProperty('tier');
    expect(snap).toHaveProperty('score');
    expect(snap).toHaveProperty('windowSizeDays', 7);
    expect(snap).toHaveProperty('recentOutcomes');
    expect(snap).toHaveProperty('lastAdjustedAt');

    expect(['HIGH', 'MEDIUM', 'LOW', 'PROBATION']).toContain(snap.tier);
    expect(snap.score).toBeGreaterThanOrEqual(0);
    expect(snap.score).toBeLessThanOrEqual(1);
    expect(Array.isArray(snap.recentOutcomes)).toBe(true);
    expect(snap.recentOutcomes.length).toBeGreaterThan(0);
    expect(typeof snap.lastAdjustedAt).toBe('string');
    expect(snap.lastAdjustedAt).toMatch(/^\d{4}-/); // ISO-8601
  });

  // 9. DB error during recordOutcome → fail-open (does not throw)
  it('recordOutcome does not throw when DB is closed', () => {
    db.close();
    expect(() => {
      tracker.recordOutcome(outcome('success'));
    }).not.toThrow();
  });

  // 10. DB error during getScore → fail-open, returns 0.5
  it('getScore returns 0.5 when DB is closed (fail-open)', () => {
    db.close();
    const score: number = tracker.getScore();
    expect(score).toBe(0.5);
  });

  // 11. DB error during getCurrentTier → fail-open, returns MEDIUM
  it('getCurrentTier returns MEDIUM when DB is closed (fail-open)', () => {
    db.close();
    const tier: TrustTier = tracker.getCurrentTier();
    expect(tier).toBe('MEDIUM');
  });

  // 12. DB error during getAuditSnapshot → fail-open, returns neutral snapshot
  it('getAuditSnapshot returns neutral snapshot when DB is closed (fail-open)', () => {
    db.close();
    const snap: AuditSnapshot = tracker.getAuditSnapshot();
    expect(snap.tier).toBe('MEDIUM');
    expect(snap.score).toBe(0.5);
    expect(snap.windowSizeDays).toBe(7);
    expect(Array.isArray(snap.recentOutcomes)).toBe(true);
    expect(typeof snap.lastAdjustedAt).toBe('string');
  });

  // 13. Weighted outcomes are applied correctly
  it('respects custom weight multiplier on outcomes', () => {
    // 1 success with weight=5: delta = 1.0 × 5 = +5.0
    // score = clamp(0.5 + 5/20) = 0.75 → HIGH
    tracker.recordOutcome({ timestamp: Date.now(), kind: 'success', weight: 5.0 });
    const tier: TrustTier = tracker.getCurrentTier();
    const score: number = tracker.getScore();
    expect(tier).toBe('HIGH');
    expect(score).toBeCloseTo(0.75, 5);
  });

  // 14. Score clamped to 0 when many heavy negatives
  it('score is clamped to 0 with many conjecture-commit outcomes', () => {
    // 20 conjecture-commits: -2.0 each = -40
    // score = clamp(0.5 + (-40)/20) = clamp(-1.5) = 0 → PROBATION
    for (let i = 0; i < 20; i++) {
      tracker.recordOutcome(outcome('conjecture-commit'));
    }
    const score: number = tracker.getScore();
    const tier: TrustTier = tracker.getCurrentTier();
    expect(score).toBe(0);
    expect(tier).toBe('PROBATION');
  });

  // 15. recentOutcomes in snapshot aggregates correctly
  it('recentOutcomes in snapshot lists kind counts accurately', () => {
    tracker.recordOutcome(outcome('success'));
    tracker.recordOutcome(outcome('success'));
    tracker.recordOutcome(outcome('veto'));

    const snap: AuditSnapshot = tracker.getAuditSnapshot();
    const successEntry = snap.recentOutcomes.find(r => r.kind === 'success');
    const vetoEntry = snap.recentOutcomes.find(r => r.kind === 'veto');

    expect(successEntry).toBeDefined();
    expect(successEntry?.count).toBe(2);
    expect(vetoEntry).toBeDefined();
    expect(vetoEntry?.count).toBe(1);
  });
});
