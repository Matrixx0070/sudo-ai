/**
 * @file outcomes-unique.test.ts
 * @description Tests for UNIQUE(source_session_id, type) constraint on outcomes
 * (ITEM 5 — security-debt-sweep).
 *
 * Uses an in-memory better-sqlite3 database via OutcomesLedger wired to ':memory:'.
 *
 * Verifies:
 * (a) First insert for (sessionId='abc', type='success') creates a row.
 * (b) Second insert for same pair is silently ignored (changes=0) → record() returns null.
 * (c) (sessionId='abc', type='failure') after a success creates a SECOND row (different type).
 * (d) NULL source_session_id rows can coexist without constraint violation.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initOutcomesSchema } from '../../../src/core/autonomy/outcomes-schema.js';
import { OutcomesLedger } from '../../../src/core/autonomy/outcomes.js';

// ---------------------------------------------------------------------------
// Helper: build an OutcomesLedger backed by an in-memory database.
// We bypass the default file path by using ':memory:' directly.
// ---------------------------------------------------------------------------

function makeInMemoryLedger(): OutcomesLedger {
  // OutcomesLedger accepts a dbPath string; ':memory:' gives us a fresh in-memory DB
  return new OutcomesLedger(':memory:');
}

// ---------------------------------------------------------------------------
// ITEM 5(a) + (b) — same (sessionId, type) pair deduplicated
// ---------------------------------------------------------------------------

describe('OutcomesLedger — UNIQUE(source_session_id, type)', () => {
  it('(a) first insert for (sessionId, type=goal_completed) creates a row', () => {
    const ledger = makeInMemoryLedger();
    const entry = ledger.record({
      type: 'goal_completed',
      description: 'Test goal completed',
      sourceSessionId: 'sess-abc',
    });

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('goal_completed');
    expect(entry?.sourceSessionId).toBe('sess-abc');

    const rows = ledger.query({ sourceSessionId: 'sess-abc', type: 'goal_completed' });
    expect(rows).toHaveLength(1);

    ledger.close();
  });

  it('(b) second insert for same (sessionId, type) is silently ignored — returns null', () => {
    const ledger = makeInMemoryLedger();

    const first = ledger.record({
      type: 'goal_completed',
      description: 'First attempt',
      sourceSessionId: 'sess-dup',
    });
    expect(first).not.toBeNull();

    const second = ledger.record({
      type: 'goal_completed',
      description: 'Duplicate attempt',
      sourceSessionId: 'sess-dup',
    });
    expect(second).toBeNull();

    // DB should have exactly one row
    const rows = ledger.query({ sourceSessionId: 'sess-dup', type: 'goal_completed' });
    expect(rows).toHaveLength(1);

    ledger.close();
  });

  it('(c) (sessionId, type=error) after (sessionId, type=goal_completed) creates a second row', () => {
    const ledger = makeInMemoryLedger();

    const first = ledger.record({
      type: 'goal_completed',
      description: 'Goal completed',
      sourceSessionId: 'sess-two',
    });
    expect(first).not.toBeNull();

    const second = ledger.record({
      type: 'error',
      description: 'An error also occurred',
      sourceSessionId: 'sess-two',
    });
    expect(second).not.toBeNull();

    // Both rows exist
    const allRows = ledger.query({ sourceSessionId: 'sess-two' });
    expect(allRows).toHaveLength(2);
    const types = allRows.map((r) => r.type).sort();
    expect(types).toEqual(['error', 'goal_completed']);

    ledger.close();
  });

  it('(d) NULL source_session_id rows can coexist without constraint violation', () => {
    const ledger = makeInMemoryLedger();

    // Two rows with the same type but no sourceSessionId — should NOT be constrained
    const r1 = ledger.record({
      type: 'earning',
      description: 'Revenue event 1',
      // sourceSessionId intentionally omitted (undefined → null)
    });
    expect(r1).not.toBeNull();

    const r2 = ledger.record({
      type: 'earning',
      description: 'Revenue event 2',
    });
    expect(r2).not.toBeNull();

    const rows = ledger.query({ type: 'earning' });
    expect(rows.length).toBeGreaterThanOrEqual(2);

    ledger.close();
  });

  it('multiple different sessionIds with the same type each get their own row', () => {
    const ledger = makeInMemoryLedger();

    const sessions = ['sess-1', 'sess-2', 'sess-3'];
    for (const sessionId of sessions) {
      const result = ledger.record({
        type: 'task_done',
        description: `Task done for ${sessionId}`,
        sourceSessionId: sessionId,
      });
      expect(result).not.toBeNull();
    }

    for (const sessionId of sessions) {
      const rows = ledger.query({ sourceSessionId: sessionId, type: 'task_done' });
      expect(rows).toHaveLength(1);
    }

    ledger.close();
  });

  it('summary totals reflect only inserted rows (not duplicates)', () => {
    const ledger = makeInMemoryLedger();

    ledger.record({ type: 'goal_completed', description: 'First', sourceSessionId: 'sess-sum' });
    ledger.record({ type: 'goal_completed', description: 'Duplicate ignored', sourceSessionId: 'sess-sum' });
    ledger.record({ type: 'error', description: 'Error row', sourceSessionId: 'sess-sum' });

    const summary = ledger.summarize();
    // Only 2 rows should exist: one goal_completed, one error
    expect(summary.byType['goal_completed']).toBe(1);
    expect(summary.byType['error']).toBe(1);

    ledger.close();
  });
});

// ---------------------------------------------------------------------------
// Verify UNIQUE index is present in schema
// ---------------------------------------------------------------------------

describe('OutcomesLedger — UNIQUE index registration', () => {
  it('uniq_outcomes_session_type index exists in DB after init', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initOutcomesSchema(db);

    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='uniq_outcomes_session_type'`,
    ).get() as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.name).toBe('uniq_outcomes_session_type');
    db.close();
  });
});
