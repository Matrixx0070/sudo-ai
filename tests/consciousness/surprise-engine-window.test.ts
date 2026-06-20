/**
 * @file surprise-engine-window.test.ts
 * @description getAverageSurprise() time-window boundary, the regression proof
 * for the ISO-vs-space datetime cutoff sweep.
 *
 * surprise_events.created_at is ISO-8601 (DDL default
 * strftime('%Y-%m-%dT%H:%M:%fZ','now')). The cutoff must also be ISO. The prior
 * `datetime('now', ?)` form produced a SPACE-separated string 'YYYY-MM-DD HH:MM:SS';
 * for any row on the SAME calendar date as the cutoff, the ISO 'T' byte (0x54)
 * sorts AFTER the space (0x20), so `created_at > <space-cutoff>` was true for
 * every same-date row regardless of its time — silently over-including rows that
 * fell outside the window. SE-1 seeds an out-of-window row on the same date and
 * asserts it is excluded: it FAILS against the old datetime('now') form (avg 0.5)
 * and PASSES against the strftime fix (avg 0.1). It never false-fails with the
 * fix — the new ISO cutoff excludes the older row by real time regardless of the
 * time of day.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { getAverageSurprise } from '../../src/core/consciousness/surprise-engine/store.js';

// Mirrors the real DDL at consciousness-db.ts (incl. CHECK constraints + the ISO default).
const DDL = `CREATE TABLE surprise_events (
  id              TEXT    PRIMARY KEY,
  prediction_id   TEXT    NOT NULL,
  magnitude       REAL    NOT NULL CHECK (magnitude BETWEEN 0 AND 1),
  direction       TEXT    NOT NULL CHECK (direction IN ('better','worse','different')),
  description     TEXT    NOT NULL,
  triggered_actions TEXT  NOT NULL DEFAULT '[]',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

function seed(db: Database.Database, id: string, magnitude: number, agoSeconds: number): void {
  const createdAt = new Date(Date.now() - agoSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO surprise_events (id, prediction_id, magnitude, direction, description, created_at)
     VALUES (?, 'p', ?, 'different', 'd', ?)`,
  ).run(id, magnitude, createdAt);
}

describe('getAverageSurprise — ISO time-window boundary', () => {
  it('SE-1: excludes a same-date row outside the window (ISO cutoff, not space-format)', () => {
    const db = new Database(':memory:');
    db.exec(DDL);
    seed(db, 'recent', 0.1, 30);  // 30s ago — inside the 180s window
    seed(db, 'old', 0.9, 300);    // 5 min ago — outside, same calendar date

    // 0.05 h = 180 s window. Only the 30s-ago row qualifies → avg = 0.1.
    // The old datetime('now', ?) space cutoff would over-include the same-date
    // 5-min row (avg (0.1+0.9)/2 = 0.5), so this assertion distinguishes the fix.
    expect(getAverageSurprise(db, 0.05)).toBeCloseTo(0.1, 5);
    db.close();
  });

  it('SE-2: averages all rows that are genuinely within the window', () => {
    const db = new Database(':memory:');
    db.exec(DDL);
    seed(db, 'a', 0.2, 10);
    seed(db, 'b', 0.4, 60);
    // Both within the 180s window → avg 0.3.
    expect(getAverageSurprise(db, 0.05)).toBeCloseTo(0.3, 5);
    db.close();
  });

  it('SE-3: returns 0 when nothing is within the window', () => {
    const db = new Database(':memory:');
    db.exec(DDL);
    seed(db, 'old', 0.9, 3600); // 1h ago, far outside the 180s window
    expect(getAverageSurprise(db, 0.05)).toBe(0);
    db.close();
  });
});
