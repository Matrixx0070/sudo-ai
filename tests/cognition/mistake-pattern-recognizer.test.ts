/**
 * Tests for mistake-pattern-recognizer.ts — Wave 6J Builder B.
 *
 * Uses an in-memory SQLite DB with the minimal audit_log schema.
 * MistakePatternRecognizer accepts a DatabaseLike duck type, so we pass a
 * real better-sqlite3 Database instance directly (it satisfies the interface).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import {
  MistakePatternRecognizer,
} from '../../src/core/cognition/mistake-pattern-recognizer.js';
import type {
  PatternAnalysisReport,
  MistakePattern,
} from '../../src/core/cognition/mistake-pattern-recognizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Create a fresh in-memory DB with the minimal audit_log schema. */
function makeDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(`
    CREATE TABLE audit_log (
      id            TEXT PRIMARY KEY,
      timestamp     TEXT NOT NULL,
      actor         TEXT NOT NULL,
      action        TEXT NOT NULL,
      resource      TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      metadata_json TEXT,
      prev_hash     TEXT NOT NULL DEFAULT '',
      hash          TEXT NOT NULL DEFAULT ''
    )
  `);
  return db;
}

let _seq = 0;
/** Insert a commitment row with a mistake field at a given age in days. */
function insertMistake(
  db: Database,
  mistakeText: string,
  ageDays = 0,
  opts: {
    commitment?: string;
    learned?: string;
    resource?: string;
    id?: string;
  } = {},
): void {
  const id = opts.id ?? `row-${++_seq}`;
  const ts = new Date(Date.now() - ageDays * MS_PER_DAY).toISOString();
  const meta = JSON.stringify({
    mistake: mistakeText,
    learned: opts.learned ?? 'lesson text',
    commitment: opts.commitment ?? 'will improve',
    ttl_days: 7,
  });
  db.prepare(
    `INSERT INTO audit_log (id, timestamp, actor, action, resource, outcome, metadata_json)
     VALUES (?, ?, 'system', 'commitment', ?, 'success', ?)`,
  ).run(id, ts, opts.resource ?? 'system', meta);
}

/** Insert a row with a non-commitment action (should be ignored). */
function insertNonCommitment(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO audit_log (id, timestamp, actor, action, resource, outcome, metadata_json)
     VALUES (?, datetime('now'), 'system', 'tool_call', 'system', 'success', '{}')`,
  ).run(id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MistakePatternRecognizer', () => {
  let db: Database;
  let recognizer: MistakePatternRecognizer;

  beforeEach(() => {
    _seq = 0;
    db = makeDb();
    recognizer = new MistakePatternRecognizer(db);
  });

  // -------------------------------------------------------------------------
  // 1. Empty DB
  // -------------------------------------------------------------------------
  it('returns empty report when DB has no commitment rows', () => {
    const report: PatternAnalysisReport = recognizer.analyze();
    expect(report.totalMistakes).toBe(0);
    expect(report.uniquePatterns).toBe(0);
    expect(report.recurringPatterns).toHaveLength(0);
    expect(report.windowDays).toBe(30);
    expect(typeof report.analyzedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 2. Single mistake — unique but no recurrence
  // -------------------------------------------------------------------------
  it('counts a single mistake but excludes it from recurringPatterns', () => {
    insertMistake(db, 'I forgot to validate the input');
    const report = recognizer.analyze();
    expect(report.totalMistakes).toBe(1);
    expect(report.uniquePatterns).toBe(1);
    expect(report.recurringPatterns).toHaveLength(0); // threshold=2 by default
  });

  // -------------------------------------------------------------------------
  // 3. Duplicate signatures → grouped and counted
  // -------------------------------------------------------------------------
  it('groups duplicate mistakes and returns them in recurringPatterns', () => {
    const text = 'Forgot to validate input data before saving';
    insertMistake(db, text, 2);
    insertMistake(db, text, 1);
    insertMistake(db, text, 0);

    const report = recognizer.analyze();
    expect(report.totalMistakes).toBe(3);
    expect(report.uniquePatterns).toBe(1);
    expect(report.recurringPatterns).toHaveLength(1);

    const pattern: MistakePattern = report.recurringPatterns[0]!;
    expect(pattern.occurrences).toBe(3);
    expect(pattern.signatureHash).toHaveLength(16);
    expect(typeof pattern.firstSeenAt).toBe('string');
    expect(typeof pattern.lastSeenAt).toBe('string');
    expect(pattern.firstSeenAt < pattern.lastSeenAt).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. windowDays filtering — old rows excluded
  // -------------------------------------------------------------------------
  it('excludes rows outside the windowDays', () => {
    const text = 'repeated timeout error in the service layer';
    insertMistake(db, text, 5);   // within 7-day window
    insertMistake(db, text, 5);   // within 7-day window
    insertMistake(db, text, 40);  // outside 30-day default window
    insertMistake(db, text, 40);  // outside 30-day default window

    // With default 30-day window: only the 5-day-old ones are within; 40d are out
    const report30 = recognizer.analyze({ windowDays: 30 });
    expect(report30.totalMistakes).toBe(2);
    expect(report30.recurringPatterns).toHaveLength(1);
    expect(report30.recurringPatterns[0]!.occurrences).toBe(2);

    // With a 3-day window: all are excluded
    const report3 = recognizer.analyze({ windowDays: 3 });
    expect(report3.totalMistakes).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Non-commitment rows are ignored
  // -------------------------------------------------------------------------
  it('ignores rows where action != commitment', () => {
    insertNonCommitment(db, 'ignored-1');
    insertNonCommitment(db, 'ignored-2');
    const report = recognizer.analyze();
    expect(report.totalMistakes).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 6. findSimilar — exact hash match
  // -------------------------------------------------------------------------
  it('findSimilar returns a match for exact same normalized text', () => {
    const text = 'Timeout when calling external API without retry logic';
    insertMistake(db, text, 1);
    insertMistake(db, text, 0);

    const matches = recognizer.findSimilar(text);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.occurrences).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 7. findSimilar — Jaccard similarity match
  // -------------------------------------------------------------------------
  it('findSimilar returns a Jaccard match for heavily overlapping text', () => {
    // Insert base text
    const stored = 'calling external api service without retry';
    insertMistake(db, stored, 0);

    // Query with similar wording — many shared tokens, Jaccard should be >= 0.6
    const query = 'calling external api service without any retry logic';
    const matches = recognizer.findSimilar(query);
    // At minimum one match via Jaccard (stored text shares ~6 of ~8 unique tokens)
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 8. Normalization invariance — punctuation variants collapse to same hash
  // -------------------------------------------------------------------------
  it('collapses punctuation variants to the same signatureHash', () => {
    const v1 = 'forgot to validate, input! before saving.';
    const v2 = 'forgot to validate  input  before saving';
    const v3 = 'FORGOT TO VALIDATE INPUT BEFORE SAVING';

    insertMistake(db, v1, 2);
    insertMistake(db, v2, 1);
    insertMistake(db, v3, 0);

    const report = recognizer.analyze();
    expect(report.uniquePatterns).toBe(1);
    expect(report.recurringPatterns).toHaveLength(1);
    expect(report.recurringPatterns[0]!.occurrences).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 9. DB-throw fail-open for analyze()
  // -------------------------------------------------------------------------
  it('analyze() returns empty report when DB throws (fail-open)', () => {
    // Close the DB so queries throw
    db.close();
    const report = recognizer.analyze();
    expect(report.totalMistakes).toBe(0);
    expect(report.uniquePatterns).toBe(0);
    expect(report.recurringPatterns).toHaveLength(0);
    expect(typeof report.analyzedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 10. DB-throw fail-open for findSimilar()
  // -------------------------------------------------------------------------
  it('findSimilar() returns [] when DB throws (fail-open)', () => {
    db.close();
    const matches = recognizer.findSimilar('some mistake text');
    expect(matches).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 11. minOccurrences option respected
  // -------------------------------------------------------------------------
  it('respects custom minOccurrences threshold', () => {
    const textA = 'failed to close db connection after query';
    const textB = 'used wrong config path for environment';
    insertMistake(db, textA, 0);
    insertMistake(db, textA, 1);
    insertMistake(db, textA, 2); // 3 occurrences of A

    insertMistake(db, textB, 0);
    insertMistake(db, textB, 1); // 2 occurrences of B

    const report3 = recognizer.analyze({ minOccurrences: 3 });
    expect(report3.recurringPatterns).toHaveLength(1);
    expect(report3.recurringPatterns[0]!.occurrences).toBe(3);

    const report2 = recognizer.analyze({ minOccurrences: 2 });
    expect(report2.recurringPatterns).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // 12. findSimilar returns at most 5 matches
  // -------------------------------------------------------------------------
  it('findSimilar returns at most 5 matches even with many patterns', () => {
    // Insert 8 distinct but Jaccard-similar mistakes
    const base = 'failed to handle error in the module correctly';
    for (let i = 0; i < 8; i++) {
      insertMistake(db, `${base} variant ${i}`, i % 3);
    }
    // The query text matches the base — all variants share many tokens
    const matches = recognizer.findSimilar(base);
    expect(matches.length).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // 13. Tags derived from commitment field
  // -------------------------------------------------------------------------
  it('includes commitment text in tags when present', () => {
    insertMistake(db, 'repeated timeout without circuit breaker', 0, {
      commitment: 'will add circuit breaker on all outbound calls',
      resource: 'api-service',
    });
    insertMistake(db, 'repeated timeout without circuit breaker', 1, {
      commitment: 'will add circuit breaker on all outbound calls',
      resource: 'api-service',
    });

    const report = recognizer.analyze();
    expect(report.recurringPatterns).toHaveLength(1);
    const pattern = report.recurringPatterns[0]!;
    expect(pattern.tags.length).toBeGreaterThan(0);
    // resource 'api-service' should appear as tag
    expect(pattern.tags).toContain('api-service');
  });
});
