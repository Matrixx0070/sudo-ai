/**
 * Tests for reanchor-monitor.ts — Wave 6O Builder.
 *
 * Uses an in-memory SQLite DB with a minimal audit_chain schema.
 * Timestamps are anchored to a day-bucket boundary (lessons.md wall-clock pattern)
 * to prevent boundary-flake failures in window-filter tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { ReAnchorMonitor } from '../../src/core/cognition/reanchor-monitor.js';
import type { ReAnchorEvent, ReAnchorStats } from '../../src/core/cognition/reanchor-monitor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Helpers — DB setup
// ---------------------------------------------------------------------------

/** Create a fresh in-memory DB with the relevant audit_chain schema. */
function makeDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE audit_chain (
      id       TEXT NOT NULL PRIMARY KEY,
      learned  TEXT,
      mistake  TEXT,
      ts       INTEGER NOT NULL
    )
  `);
  return db;
}

let _seq = 0;
function nextId(): string {
  return `row-${++_seq}`;
}

interface InsertOpts {
  learned?: string;
  mistake?: string;
}

/** Insert an audit_chain row with the given ts (epoch ms) and optional text fields. */
function insertRow(db: Database, ts: number, opts: InsertOpts = {}): string {
  const id = nextId();
  db.prepare(
    `INSERT INTO audit_chain (id, ts, learned, mistake) VALUES (?, ?, ?, ?)`,
  ).run(id, ts, opts.learned ?? null, opts.mistake ?? null);
  return id;
}

// ---------------------------------------------------------------------------
// Wall-clock bucket anchor (lessons.md pattern):
// Snap to the start of the current day bucket + 1s margin so tests never
// straddle the boundary regardless of when they run.
// ---------------------------------------------------------------------------

const ANCHORED_NOW = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY + 1000;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ReAnchorMonitor', () => {
  let db: Database;
  let monitor: ReAnchorMonitor;

  beforeEach(() => {
    _seq = 0;
    db = makeDb();
    monitor = new ReAnchorMonitor(db);
    // Pin Date.now() so all window cutoffs are deterministic.
    vi.spyOn(Date, 'now').mockReturnValue(ANCHORED_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Empty DB
  // ---------------------------------------------------------------------------

  it('1: empty DB → zero total, empty byTrigger, no lastReAnchorAt', () => {
    const stats: ReAnchorStats = monitor.getStats();
    expect(stats.total).toBe(0);
    expect(stats.byTrigger).toEqual({});
    expect(stats.lastReAnchorAt).toBeUndefined();
    expect(stats.windowDays).toBe(30);
    expect(typeof stats.computedAt).toBe('string');
  });

  it('2: empty DB → getRecent returns empty array', () => {
    const events: ReAnchorEvent[] = monitor.getRecent();
    expect(events).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Single explicit re-anchor row
  // ---------------------------------------------------------------------------

  it('3: single explicit re-anchor row → total 1, byTrigger.explicit=1, lastReAnchorAt set', () => {
    const ts = ANCHORED_NOW - 5 * MS_PER_DAY;
    insertRow(db, ts, { learned: 'explicit re-anchor performed after deployment' });

    const stats = monitor.getStats();
    expect(stats.total).toBe(1);
    expect(stats.byTrigger['explicit']).toBe(1);
    expect(stats.lastReAnchorAt).toBe(ts);
  });

  // ---------------------------------------------------------------------------
  // 4. Mixed triggers — correct breakdown
  // ---------------------------------------------------------------------------

  it('4: mixed triggers → correct byTrigger breakdown', () => {
    insertRow(db, ANCHORED_NOW - 1 * MS_PER_DAY, { learned: 'explicit re-anchor after boot' });
    insertRow(db, ANCHORED_NOW - 2 * MS_PER_DAY, { learned: 'reanchor triggered post dispatch routing' });
    insertRow(db, ANCHORED_NOW - 3 * MS_PER_DAY, { learned: 'identity-anchor refreshed following veto override' });
    insertRow(db, ANCHORED_NOW - 4 * MS_PER_DAY, { learned: 'identity-anchor reset after discordance detected' });
    insertRow(db, ANCHORED_NOW - 5 * MS_PER_DAY, { learned: 'reanchor event with no additional context' });

    const stats = monitor.getStats();
    expect(stats.total).toBe(5);
    expect(stats.byTrigger['explicit']).toBe(1);
    expect(stats.byTrigger['post-dispatch']).toBe(1);
    expect(stats.byTrigger['post-veto']).toBe(1);
    expect(stats.byTrigger['post-discordance']).toBe(1);
    expect(stats.byTrigger['unknown']).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 5. windowDays filter excludes old rows
  // ---------------------------------------------------------------------------

  it('5: windowDays filter excludes rows older than the window', () => {
    // Inside 30-day window
    insertRow(db, ANCHORED_NOW - 10 * MS_PER_DAY, { learned: 're-anchor check' });
    // Outside 30-day window
    insertRow(db, ANCHORED_NOW - 35 * MS_PER_DAY, { learned: 're-anchor old event' });

    const stats = monitor.getStats({ windowDays: 30 });
    expect(stats.total).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 6. getRecent limit clamping (insert 60, limit=10 → 10)
  // ---------------------------------------------------------------------------

  it('6: getRecent with limit=10 returns exactly 10 rows when 60 exist', () => {
    for (let i = 0; i < 60; i++) {
      insertRow(db, ANCHORED_NOW - i * 60_000, { learned: `reanchor event ${i}` });
    }

    const events = monitor.getRecent({ limit: 10 });
    expect(events).toHaveLength(10);
  });

  // ---------------------------------------------------------------------------
  // 7. getRecent orders by ts DESC
  // ---------------------------------------------------------------------------

  it('7: getRecent orders events newest-first (ts DESC)', () => {
    const ts1 = ANCHORED_NOW - 3 * MS_PER_DAY;
    const ts2 = ANCHORED_NOW - 1 * MS_PER_DAY;
    const ts3 = ANCHORED_NOW - 2 * MS_PER_DAY;

    insertRow(db, ts1, { learned: 're-anchor oldest' });
    insertRow(db, ts2, { learned: 're-anchor newest' });
    insertRow(db, ts3, { learned: 're-anchor middle' });

    const events = monitor.getRecent();
    expect(events[0]?.ts).toBe(ts2);
    expect(events[1]?.ts).toBe(ts3);
    expect(events[2]?.ts).toBe(ts1);
  });

  // ---------------------------------------------------------------------------
  // 8. Snippet truncation — insert 300-char learned text → snippet ≤120 chars
  // ---------------------------------------------------------------------------

  it('8: snippet is at most 120 chars even for 300-char source text', () => {
    const longText = 'A'.repeat(150) + ' re-anchor event happened ' + 'B'.repeat(124);
    insertRow(db, ANCHORED_NOW - 1 * MS_PER_DAY, { learned: longText });

    const events = monitor.getRecent({ limit: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.snippet.length).toBeLessThanOrEqual(120);
  });

  // ---------------------------------------------------------------------------
  // 9. Snippet strips newlines
  // ---------------------------------------------------------------------------

  it('9: snippet replaces newlines with spaces', () => {
    const textWithNewlines = 're-anchor\nafter\nreboot';
    insertRow(db, ANCHORED_NOW - 1 * MS_PER_DAY, { learned: textWithNewlines });

    const events = monitor.getRecent({ limit: 1 });
    expect(events[0]?.snippet).not.toMatch(/[\n\r]/);
  });

  // ---------------------------------------------------------------------------
  // 10. Snippet redacts 8+ digit sequences
  // ---------------------------------------------------------------------------

  it('10: snippet redacts numeric sequences of 8+ digits', () => {
    const textWithId = 're-anchor triggered by session 12345678 override';
    insertRow(db, ANCHORED_NOW - 1 * MS_PER_DAY, { learned: textWithId });

    const events = monitor.getRecent({ limit: 1 });
    expect(events[0]?.snippet).toContain('[REDACTED]');
    expect(events[0]?.snippet).not.toContain('12345678');
  });

  // ---------------------------------------------------------------------------
  // 11. LOWER() case-insensitive match ('RE-ANCHOR' uppercased matches)
  // ---------------------------------------------------------------------------

  it('11: LOWER() case-insensitive — uppercased RE-ANCHOR is matched', () => {
    insertRow(db, ANCHORED_NOW - 1 * MS_PER_DAY, { learned: 'SYSTEM PERFORMED RE-ANCHOR OPERATION' });

    const stats = monitor.getStats();
    expect(stats.total).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 12. LIKE '%identity drift%' in mistake column matches
  // ---------------------------------------------------------------------------

  it('12: mistake column LIKE identity drift matches the row', () => {
    insertRow(db, ANCHORED_NOW - 1 * MS_PER_DAY, {
      learned: null as unknown as string,
      mistake: 'detected identity drift in recent turns',
    });

    const stats = monitor.getStats();
    expect(stats.total).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 13. DB throw fail-open on getStats
  // ---------------------------------------------------------------------------

  it('13: DB throw on getStats → returns empty stats (fail-open)', () => {
    const fakeStmt = {
      all: (): never => { throw new Error('SQLITE_ERROR: no such table'); },
    };

    const brokenMonitor = Object.create(ReAnchorMonitor.prototype) as ReAnchorMonitor;
    // @ts-expect-error -- injecting private for fail-open test
    brokenMonitor._stmtList = fakeStmt;
    // @ts-expect-error -- injecting private for fail-open test
    brokenMonitor._stmtListRecent = fakeStmt;
    // @ts-expect-error -- injecting db for fail-open test
    brokenMonitor.db = db;

    const stats = brokenMonitor.getStats();
    expect(stats.total).toBe(0);
    expect(stats.byTrigger).toEqual({});
    expect(stats.lastReAnchorAt).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 14. DB throw fail-open on getRecent
  // ---------------------------------------------------------------------------

  it('14: DB throw on getRecent → returns empty array (fail-open)', () => {
    const fakeStmt = {
      all: (): never => { throw new Error('SQLITE_ERROR: no such table'); },
    };

    const brokenMonitor = Object.create(ReAnchorMonitor.prototype) as ReAnchorMonitor;
    // @ts-expect-error -- injecting private for fail-open test
    brokenMonitor._stmtList = fakeStmt;
    // @ts-expect-error -- injecting private for fail-open test
    brokenMonitor._stmtListRecent = fakeStmt;
    // @ts-expect-error -- injecting db for fail-open test
    brokenMonitor.db = db;

    const events = brokenMonitor.getRecent();
    expect(events).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 15. Trigger classification: row with both "veto" and "dispatch" → 'post-veto'
  // (post-veto has higher priority than post-dispatch per implementation spec)
  // ---------------------------------------------------------------------------

  it('15: row with both "veto" and "dispatch" markers → trigger is post-veto (priority order)', () => {
    insertRow(db, ANCHORED_NOW - 1 * MS_PER_DAY, {
      learned: 'reanchor after veto blocked dispatch routing',
    });

    const events = monitor.getRecent({ limit: 1 });
    expect(events[0]?.trigger).toBe('post-veto');
  });

  // ---------------------------------------------------------------------------
  // 16. lastReAnchorAt reflects the maximum ts in the result set
  // ---------------------------------------------------------------------------

  it('16: lastReAnchorAt is the max ts across all matching rows', () => {
    const tsOlder = ANCHORED_NOW - 10 * MS_PER_DAY;
    const tsNewer = ANCHORED_NOW - 2 * MS_PER_DAY;

    insertRow(db, tsOlder, { learned: 're-anchor earlier event' });
    insertRow(db, tsNewer, { learned: 're-anchor latest event' });

    const stats = monitor.getStats();
    expect(stats.lastReAnchorAt).toBe(tsNewer);
  });
});
