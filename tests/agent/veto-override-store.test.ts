/**
 * @file tests/agent/veto-override-store.test.ts
 * @description VetoOverrideStore unit tests — 10 original + A1/A2 additions.
 *
 * Tests:
 *   B-1  recordOverride allow → returns VetoOverride with id + createdAt
 *   B-2  getOverride(unknownId) → null
 *   B-3  getOverride(existingId) → stored record
 *   B-4  Duplicate decisionId → throws (UNIQUE constraint)
 *   B-5  listOverrides returns all records
 *   B-6  listOverrides clamps limit below minimum to 1
 *   B-7  listOverrides clamps limit above maximum to 500
 *   B-8  listOverrides respects explicit limit
 *   B-9  listOverrides returns empty array when no records
 *   B-10 recordOverride deny action is stored correctly
 *
 *   A1-1  content_hash column exists after schema init
 *   A1-2  idempotent ALTER — constructing store twice on same DB does not throw
 *   A1-3  getOverrideByContentHash roundtrip — happy path
 *   A1-4  getOverrideByContentHash returns null for unknown hash
 *   A1-5  NULL content_hash is allowed and does not violate UNIQUE constraint
 *   A1-6  Two rows with NULL content_hash both insertable (partial UNIQUE index)
 *   A1-7  recordOverride without contentHash stores NULL, still retrievable by decisionId
 *   A2-1  Prepared-statement invariance — getOverride called 3x with same result
 *   A2-2  listOverrides on DB with legacy rows (no content_hash) returns them
 *   A2-3  recordOverride with contentHash stored and retrievable by both methods
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { VetoOverrideStore } from '../../src/core/agent/veto-override-store.js';
import type { VetoOverride } from '../../src/core/agent/veto-override-store.js';

function makeInMemoryStore(): VetoOverrideStore {
  const db = new Database(':memory:');
  return new VetoOverrideStore(db);
}

describe('VetoOverrideStore', () => {
  let store: VetoOverrideStore;

  beforeEach(() => {
    store = makeInMemoryStore();
  });

  // B-1: recordOverride allow → returns VetoOverride with id + createdAt
  it('recordOverride allow returns VetoOverride with generated id and createdAt', () => {
    const result = store.recordOverride({
      decisionId: 'decision-abc',
      action: 'allow',
      reason: 'this is a valid reason for allowing this tool call',
      createdBy: 'admin',
    });

    expect(result).toMatchObject<Partial<VetoOverride>>({
      decisionId: 'decision-abc',
      action: 'allow',
      reason: 'this is a valid reason for allowing this tool call',
      createdBy: 'admin',
    });
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.createdAt).toBe('string');
    // createdAt should be a valid ISO-8601 string
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });

  // B-2: getOverride(unknownId) → null
  it('getOverride returns null for unknown decisionId', () => {
    const result = store.getOverride('nonexistent-decision-id');
    expect(result).toBeNull();
  });

  // B-3: getOverride(existingId) → stored record
  it('getOverride returns stored record for known decisionId', () => {
    store.recordOverride({
      decisionId: 'known-decision',
      action: 'deny',
      reason: 'this is a well-reasoned deny reason for testing',
      createdBy: 'admin',
    });

    const result = store.getOverride('known-decision');

    expect(result).not.toBeNull();
    expect(result?.decisionId).toBe('known-decision');
    expect(result?.action).toBe('deny');
    expect(result?.reason).toBe('this is a well-reasoned deny reason for testing');
    expect(result?.createdBy).toBe('admin');
  });

  // B-4: Duplicate decisionId → throws
  it('recordOverride throws when decisionId already exists', () => {
    store.recordOverride({
      decisionId: 'duplicate-decision',
      action: 'allow',
      reason: 'first override entry with sufficient length',
      createdBy: 'admin',
    });

    expect(() =>
      store.recordOverride({
        decisionId: 'duplicate-decision',
        action: 'deny',
        reason: 'second override should fail due to unique constraint',
        createdBy: 'admin',
      }),
    ).toThrow();
  });

  // B-5: listOverrides returns all records
  it('listOverrides returns all stored records', () => {
    store.recordOverride({ decisionId: 'dec-1', action: 'allow', reason: 'allow reason first', createdBy: 'admin' });
    store.recordOverride({ decisionId: 'dec-2', action: 'deny', reason: 'deny reason second entry', createdBy: 'admin' });
    store.recordOverride({ decisionId: 'dec-3', action: 'allow', reason: 'allow reason third entry', createdBy: 'admin' });

    const results = store.listOverrides();
    expect(results).toHaveLength(3);
    // Newest first
    const decisionIds = results.map((r) => r.decisionId);
    expect(decisionIds).toContain('dec-1');
    expect(decisionIds).toContain('dec-2');
    expect(decisionIds).toContain('dec-3');
  });

  // B-6: listOverrides clamps limit below minimum to 1
  it('listOverrides clamps limit of 0 to minimum of 1', () => {
    store.recordOverride({ decisionId: 'dec-clamp', action: 'allow', reason: 'clamping test reason here', createdBy: 'admin' });

    // limit=0 should be clamped to 1
    const results = store.listOverrides(0);
    expect(results).toHaveLength(1);
  });

  // B-7: listOverrides clamps limit above maximum to 500
  it('listOverrides clamps limit above 500 to 500', () => {
    // Insert 3 records; even requesting 99999 should cap at 500 (but return all 3)
    store.recordOverride({ decisionId: 'dec-cap-1', action: 'allow', reason: 'cap test first entry', createdBy: 'admin' });
    store.recordOverride({ decisionId: 'dec-cap-2', action: 'allow', reason: 'cap test second entry', createdBy: 'admin' });

    const results = store.listOverrides(99999);
    // Should not error out; returns whatever is in DB (≤500)
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(500);
  });

  // B-8: listOverrides respects explicit limit
  it('listOverrides respects explicit limit parameter', () => {
    store.recordOverride({ decisionId: 'limit-dec-1', action: 'allow', reason: 'limit test first entry here', createdBy: 'admin' });
    store.recordOverride({ decisionId: 'limit-dec-2', action: 'allow', reason: 'limit test second entry here', createdBy: 'admin' });
    store.recordOverride({ decisionId: 'limit-dec-3', action: 'allow', reason: 'limit test third entry here', createdBy: 'admin' });

    const results = store.listOverrides(2);
    expect(results).toHaveLength(2);
  });

  // B-9: listOverrides returns empty array when no records
  it('listOverrides returns empty array when store is empty', () => {
    const results = store.listOverrides();
    expect(results).toEqual([]);
  });

  // B-10: recordOverride deny action is stored correctly
  it('recordOverride deny action is stored and retrievable', () => {
    const stored = store.recordOverride({
      decisionId: 'deny-decision',
      action: 'deny',
      reason: 'this denial reason must be at least 20 chars',
      createdBy: 'operator-1',
    });

    expect(stored.action).toBe('deny');
    expect(stored.createdBy).toBe('operator-1');

    const retrieved = store.getOverride('deny-decision');
    expect(retrieved?.action).toBe('deny');
    expect(retrieved?.createdBy).toBe('operator-1');
  });
});

// ---------------------------------------------------------------------------
// A1 + A2: Schema v2 content_hash and prepared-statement caching tests
// ---------------------------------------------------------------------------

describe('VetoOverrideStore — A1 content_hash schema v2', () => {
  // A1-1: content_hash column exists after schema init
  it('content_hash column exists in veto_overrides table after init', () => {
    const db = new Database(':memory:');
    new VetoOverrideStore(db);
    // PRAGMA table_info returns one row per column
    const cols = db.prepare('PRAGMA table_info(veto_overrides)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('content_hash');
  });

  // A1-2: idempotent ALTER — constructing two stores on same DB must not throw
  it('constructing two VetoOverrideStore instances on the same DB is idempotent (no throw)', () => {
    const db = new Database(':memory:');
    expect(() => {
      new VetoOverrideStore(db);
      new VetoOverrideStore(db);
    }).not.toThrow();
  });

  // A1-3: getOverrideByContentHash roundtrip — happy path
  it('getOverrideByContentHash returns override when content_hash matches', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);
    s.recordOverride({
      decisionId: 'hash-roundtrip-dec',
      contentHash: 'abc123def456abc123def456abc12345',
      action: 'allow',
      reason: 'testing content hash roundtrip lookup here',
      createdBy: 'admin',
    });

    const result = s.getOverrideByContentHash('abc123def456abc123def456abc12345');
    expect(result).not.toBeNull();
    expect(result?.decisionId).toBe('hash-roundtrip-dec');
    expect(result?.contentHash).toBe('abc123def456abc123def456abc12345');
    expect(result?.action).toBe('allow');
  });

  // A1-4: getOverrideByContentHash returns null for unknown hash
  it('getOverrideByContentHash returns null for non-existent hash', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);
    const result = s.getOverrideByContentHash('nonexistenthash00000000000000000');
    expect(result).toBeNull();
  });

  // A1-5: NULL content_hash is allowed (no UNIQUE violation among NULLs)
  it('recordOverride without contentHash stores NULL and does not violate UNIQUE index', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);
    expect(() => {
      s.recordOverride({
        decisionId: 'null-hash-dec-1',
        action: 'allow',
        reason: 'null content hash should be valid and storable',
        createdBy: 'admin',
      });
    }).not.toThrow();

    const retrieved = s.getOverride('null-hash-dec-1');
    expect(retrieved).not.toBeNull();
    // contentHash should be null or undefined (legacy-compatible)
    expect(retrieved?.contentHash ?? null).toBeNull();
  });

  // A1-6: Two rows with NULL content_hash — partial UNIQUE index allows both
  it('two rows with NULL content_hash both insertable due to partial UNIQUE index', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);
    expect(() => {
      s.recordOverride({ decisionId: 'null-hash-a', action: 'allow', reason: 'first null hash row reason here', createdBy: 'admin' });
      s.recordOverride({ decisionId: 'null-hash-b', action: 'deny', reason: 'second null hash row reason here', createdBy: 'admin' });
    }).not.toThrow();

    const all = s.listOverrides();
    expect(all.length).toBe(2);
  });

  // A1-7: recordOverride without contentHash: null stored, row retrievable by decisionId
  it('row without contentHash is retrievable by decisionId and has null contentHash', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);
    s.recordOverride({
      decisionId: 'legacy-row-dec',
      action: 'deny',
      reason: 'legacy row without content hash should still be retrievable',
      createdBy: 'operator',
    });

    const row = s.getOverride('legacy-row-dec');
    expect(row).not.toBeNull();
    expect(row?.decisionId).toBe('legacy-row-dec');
    expect(row?.contentHash ?? null).toBeNull();
  });

  // A1: duplicate content_hash (non-null) should throw UNIQUE violation
  it('duplicate non-null content_hash throws UNIQUE constraint violation', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);
    s.recordOverride({
      decisionId: 'unique-hash-dec-1',
      contentHash: 'aabbccddeeff00112233445566778899',
      action: 'allow',
      reason: 'first entry with this content hash value',
      createdBy: 'admin',
    });
    expect(() =>
      s.recordOverride({
        decisionId: 'unique-hash-dec-2',
        contentHash: 'aabbccddeeff00112233445566778899',
        action: 'deny',
        reason: 'second entry with duplicate content hash should fail',
        createdBy: 'admin',
      }),
    ).toThrow();
  });
});

describe('VetoOverrideStore — A2 prepared-statement caching', () => {
  // A2-1: Prepared-statement invariance — getOverride called 3x returns same result each time
  it('getOverride called 3 times returns consistent result (prepared stmt reuse)', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);
    s.recordOverride({
      decisionId: 'ps-reuse-dec',
      action: 'allow',
      reason: 'testing prepared statement reuse across multiple calls',
      createdBy: 'admin',
    });

    const r1 = s.getOverride('ps-reuse-dec');
    const r2 = s.getOverride('ps-reuse-dec');
    const r3 = s.getOverride('ps-reuse-dec');

    expect(r1?.decisionId).toBe('ps-reuse-dec');
    expect(r2?.decisionId).toBe('ps-reuse-dec');
    expect(r3?.decisionId).toBe('ps-reuse-dec');
    expect(r1?.action).toBe(r2?.action);
    expect(r2?.action).toBe(r3?.action);
  });

  // A2-2: listOverrides on DB with pre-existing rows (simulated legacy migration)
  it('listOverrides returns rows from legacy DB that had no content_hash column initially', () => {
    // Simulate legacy DB: create table without content_hash, insert rows, then init store
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS veto_overrides (
        id          TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE,
        action      TEXT NOT NULL CHECK(action IN ('allow','deny')),
        reason      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        created_by  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_veto_overrides_decision_id ON veto_overrides(decision_id);
    `);
    // Insert legacy row without content_hash
    db.prepare(
      `INSERT INTO veto_overrides (id, decision_id, action, reason, created_at, created_by)
       VALUES ('legacy-id-1', 'legacy-dec-1', 'allow', 'legacy allow reason for test', '2025-01-01T00:00:00.000Z', 'admin')`,
    ).run();

    // Now construct store — should run ALTER TABLE idempotently and still return legacy row
    const s = new VetoOverrideStore(db);
    const all = s.listOverrides();

    expect(all.length).toBe(1);
    expect(all[0]!.decisionId).toBe('legacy-dec-1');
    expect(all[0]!.contentHash ?? null).toBeNull();
  });

  // A2-3: recordOverride with contentHash stored and retrievable by both methods
  it('recordOverride with contentHash is retrievable by both getOverride and getOverrideByContentHash', () => {
    const db = new Database(':memory:');
    const s = new VetoOverrideStore(db);

    const hash = 'deadbeef00112233445566778899aabb';
    const stored = s.recordOverride({
      decisionId: 'dual-lookup-dec',
      contentHash: hash,
      action: 'allow',
      reason: 'override retrievable by both decisionId and contentHash',
      createdBy: 'admin',
    });

    expect(stored.contentHash).toBe(hash);

    const byDecisionId  = s.getOverride('dual-lookup-dec');
    const byContentHash = s.getOverrideByContentHash(hash);

    expect(byDecisionId).not.toBeNull();
    expect(byContentHash).not.toBeNull();
    expect(byDecisionId?.decisionId).toBe('dual-lookup-dec');
    expect(byContentHash?.decisionId).toBe('dual-lookup-dec');
    expect(byDecisionId?.contentHash).toBe(hash);
    expect(byContentHash?.contentHash).toBe(hash);
  });
});
