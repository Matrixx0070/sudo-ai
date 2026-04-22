/**
 * @file tests/security/audit-chain.test.ts
 * @description Tests for audit-chain.ts primitives and AuditTrail hash-chain integration.
 *
 * Coverage:
 *  1. computeHash — deterministic output for fixed inputs
 *  2. computeHash — different prev_hash produces different digest
 *  3. computeHash — different timestamp produces different digest
 *  4. computeHash — different payload produces different digest
 *  5. computeHash — type validation (empty string prevHash allowed; empty timestamp throws)
 *  6. verifyChainRows — empty chain returns ok:true, rowsChecked:0
 *  7. verifyChainRows — single valid row returns ok:true, rowsChecked:1
 *  8. verifyChainRows — multi-row intact chain returns ok:true
 *  9. verifyChainRows — tampered hash at index 0 returns ok:false, breakAt=id, rowsChecked=1
 * 10. verifyChainRows — tampered hash at middle row returns ok:false with correct breakAt
 * 11. AuditTrail.record — inserts row, returns string id
 * 12. AuditTrail.verifyChain — single row chain is intact
 * 13. AuditTrail.verifyChain — multi-row chain is intact after multiple records
 * 14. AuditTrail.verifyChain — detects tampering when hash modified directly in DB
 * 15. AuditTrail.recordTriple — persists commitment, actor=system, action=commitment, all 4 metadata keys
 * 16. AuditTrail.backfillHashes — upgrades pre-chain rows; chain verifies intact after backfill
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  computeHash,
  verifyChainRows,
} from '../../src/core/security/audit-chain.js';
import type { ChainEntry } from '../../src/core/security/audit-chain.js';
import { AuditTrail } from '../../src/core/security/audit-trail.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(tmpDir: string): string {
  return path.join(tmpDir, 'audit.db');
}

function makeEntry(
  overrides: Partial<ChainEntry> & { id: string; timestamp: string; payload: string },
): ChainEntry {
  const prevHash = overrides.prev_hash ?? '';
  const hash = overrides.hash ?? computeHash(prevHash, overrides.timestamp, overrides.payload);
  return {
    id: overrides.id,
    timestamp: overrides.timestamp,
    payload: overrides.payload,
    prev_hash: prevHash,
    hash,
  };
}

function buildChain(count: number): ChainEntry[] {
  const entries: ChainEntry[] = [];
  let prevHash = '';
  for (let i = 0; i < count; i++) {
    const entry = makeEntry({
      id: `id-${i}`,
      timestamp: `2026-01-01T00:00:0${i}.000Z`,
      payload: `{"data":"row-${i}"}`,
      prev_hash: prevHash,
    });
    prevHash = entry.hash;
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// computeHash tests
// ---------------------------------------------------------------------------

describe('computeHash — determinism', () => {
  it('returns the same hex string for identical inputs', () => {
    const h1 = computeHash('', '2026-01-01T00:00:00.000Z', '{"x":1}');
    const h2 = computeHash('', '2026-01-01T00:00:00.000Z', '{"x":1}');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns different digest when prevHash differs', () => {
    const h1 = computeHash('aaa', '2026-01-01T00:00:00.000Z', 'payload');
    const h2 = computeHash('bbb', '2026-01-01T00:00:00.000Z', 'payload');
    expect(h1).not.toBe(h2);
  });

  it('returns different digest when timestamp differs', () => {
    const h1 = computeHash('', '2026-01-01T00:00:00.000Z', 'payload');
    const h2 = computeHash('', '2026-01-01T00:00:01.000Z', 'payload');
    expect(h1).not.toBe(h2);
  });

  it('returns different digest when payload differs', () => {
    const h1 = computeHash('', '2026-01-01T00:00:00.000Z', 'payload-a');
    const h2 = computeHash('', '2026-01-01T00:00:00.000Z', 'payload-b');
    expect(h1).not.toBe(h2);
  });

  it('accepts empty-string prevHash (first-row case)', () => {
    expect(() => computeHash('', '2026-01-01T00:00:00.000Z', '{}')).not.toThrow();
  });

  it('throws TypeError for empty timestamp', () => {
    expect(() => computeHash('', '', '{}')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// verifyChainRows tests
// ---------------------------------------------------------------------------

describe('verifyChainRows — chain verification', () => {
  it('returns ok:true and rowsChecked:0 for empty array', () => {
    const result = verifyChainRows([]);
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(0);
    expect(result.breakAt).toBeUndefined();
  });

  it('returns ok:true and rowsChecked:1 for single valid row', () => {
    const chain = buildChain(1);
    const result = verifyChainRows(chain);
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(1);
  });

  it('returns ok:true for a 5-row intact chain', () => {
    const chain = buildChain(5);
    const result = verifyChainRows(chain);
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(5);
  });

  it('detects tampered hash at index 0 and reports breakAt', () => {
    const chain = buildChain(3);
    // Corrupt first row's stored hash
    chain[0]!.hash = 'deadbeef' + chain[0]!.hash.slice(8);
    const result = verifyChainRows(chain);
    expect(result.ok).toBe(false);
    expect(result.breakAt).toBe('id-0');
    expect(result.rowsChecked).toBe(1);
  });

  it('detects tampered hash in the middle and stops at first mismatch', () => {
    const chain = buildChain(5);
    // Corrupt row at index 2
    chain[2]!.hash = 'feedcafe' + chain[2]!.hash.slice(8);
    const result = verifyChainRows(chain);
    expect(result.ok).toBe(false);
    expect(result.breakAt).toBe('id-2');
    expect(result.rowsChecked).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AuditTrail integration tests (each test gets its own fresh DB)
// ---------------------------------------------------------------------------

describe('AuditTrail — hash-chain integration', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'audit-chain-test-'));
    dbPath = freshDb(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('record() returns a non-empty string id', () => {
    const trail = new AuditTrail(dbPath);
    const id = trail.record({
      actor: 'user:alice',
      action: 'login',
      resource: 'auth',
      outcome: 'success',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('verifyChain() returns ok:true for a single-row chain', () => {
    const trail = new AuditTrail(dbPath);
    trail.record({ actor: 'system', action: 'boot', resource: 'server', outcome: 'success' });
    const result = trail.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(1);
  });

  it('verifyChain() returns ok:true after multiple records', () => {
    const trail = new AuditTrail(dbPath);
    for (let i = 0; i < 5; i++) {
      trail.record({
        actor: 'user:bob',
        action: `action-${i}`,
        resource: 'resource',
        outcome: 'success',
        metadata: { index: i },
      });
    }
    const result = trail.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(5);
  });

  it('verifyChain() detects direct DB hash tampering', () => {
    const trail = new AuditTrail(dbPath);
    trail.record({ actor: 'admin', action: 'delete', resource: 'record:42', outcome: 'success' });
    trail.record({ actor: 'admin', action: 'delete', resource: 'record:43', outcome: 'success' });

    // Directly corrupt the first row's stored hash via raw DB access
    const rawDb = new Database(dbPath);
    rawDb.prepare(
      "UPDATE audit_log SET hash = 'tampered000000000000000000000000000000000000000000000000000000000' WHERE rowid = (SELECT MIN(rowid) FROM audit_log)",
    ).run();
    rawDb.close();

    const result = trail.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.breakAt).toBeDefined();
  });

  it('recordTriple() persists commitment with actor=system and action=commitment and all 4 metadata keys', () => {
    const trail = new AuditTrail(dbPath);
    const id = trail.recordTriple({
      mistake: 'logged PII in plaintext',
      learned: 'use structured redaction',
      commitment: 'all user data redacted before logging',
      ttl_days: 30,
      resource: 'logging-subsystem',
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const entries = trail.query({ action: 'commitment' });
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.actor).toBe('system');
    expect(entry.action).toBe('commitment');
    expect(entry.resource).toBe('logging-subsystem');
    expect(entry.outcome).toBe('success');
    // Spec case 12: metadata must contain all 4 required keys
    expect(entry.metadata?.['ttl_days']).toBe(30);
    expect(entry.metadata?.['mistake']).toBe('logged PII in plaintext');
    expect(entry.metadata?.['learned']).toBe('use structured redaction');
    expect(entry.metadata?.['commitment']).toBe('all user data redacted before logging');
  });

  it('backfillHashes(): pre-chain rows get hashes, chain verifies intact', () => {
    // Insert rows WITHOUT hash columns (simulate rows inserted before the Wave 6A upgrade).
    // We create a fresh DB with only the original 7 columns, insert rows, then open
    // AuditTrail which will add columns and backfill.
    const rawDb = new Database(dbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id            TEXT PRIMARY KEY,
        timestamp     TEXT NOT NULL,
        actor         TEXT NOT NULL,
        action        TEXT NOT NULL,
        resource      TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        metadata_json TEXT
      )
    `);
    rawDb.prepare(
      'INSERT INTO audit_log (id, timestamp, actor, action, resource, outcome, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('pre-1', '2026-01-01T10:00:00.000Z', 'system', 'boot', 'server', 'success', null);
    rawDb.prepare(
      'INSERT INTO audit_log (id, timestamp, actor, action, resource, outcome, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('pre-2', '2026-01-01T10:00:01.000Z', 'user:alice', 'login', 'auth', 'success', '{"ip":"1.2.3.4"}');
    rawDb.close();

    // AuditTrail constructor calls addChainColumns + backfillHashes
    const trail = new AuditTrail(dbPath);
    const result = trail.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(2);
  });
});
