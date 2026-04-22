/**
 * @file tests/security/audit-chain-gaps.test.ts
 * @description Gap-fill tests for Wave 6A spec cases missing from audit-chain.test.ts.
 *
 * Covers spec §6 Builder B cases:
 *  - Case 8:  10 record() calls via sequential Promise.all → verifyChain() passes
 *  - Case 9:  verifyChain() on fresh empty db → ok:true, rowsChecked:0
 *  - Case 13: addChainColumns() idempotent — construct AuditTrail twice on same db → no throw
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AuditTrail } from '../../src/core/security/audit-trail.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(tmpDir: string): string {
  return path.join(tmpDir, 'audit.db');
}

// ---------------------------------------------------------------------------
// Gap-fill tests
// ---------------------------------------------------------------------------

describe('AuditTrail — spec gap-fill cases', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'audit-gap-test-'));
    dbPath = freshDb(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Spec case 9: verifyChain() on a fresh empty db returns ok:true, rowsChecked:0.
  it('verifyChain() on fresh empty db returns ok:true with rowsChecked:0', () => {
    const trail = new AuditTrail(dbPath);
    const result = trail.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(0);
    expect(result.breakAt).toBeUndefined();
  });

  // Spec case 13: addChainColumns() idempotent — construct AuditTrail twice on same db.
  // Second construction calls addChainColumns again; must not throw even when columns exist.
  it('constructing AuditTrail twice on same db does not throw (addChainColumns idempotent)', () => {
    const trail1 = new AuditTrail(dbPath);
    trail1.record({ actor: 'system', action: 'boot', resource: 'server', outcome: 'success' });

    // Second construction on the same DB file — addChainColumns will find columns already present.
    expect(() => {
      const trail2 = new AuditTrail(dbPath);
      const result = trail2.verifyChain();
      expect(result.ok).toBe(true);
    }).not.toThrow();
  });

  // Spec case 8: 10 record() calls (better-sqlite3 is synchronous; transactions serialise
  // naturally). Using Promise.all with sync functions validates the chain integrity holds
  // after sequential inserts triggered from concurrent promise resolution.
  it('10 record() calls then verifyChain() passes (concurrent-safe transaction)', async () => {
    const trail = new AuditTrail(dbPath);

    // better-sqlite3 record() is synchronous; wrap in promises to satisfy spec intent
    const insertPromises = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() =>
        trail.record({
          actor: `user:${i}`,
          action: `action-${i}`,
          resource: `resource-${i}`,
          outcome: 'success',
          metadata: { index: i },
        }),
      ),
    );

    const ids = await Promise.all(insertPromises);

    // All IDs must be non-empty strings
    expect(ids).toHaveLength(10);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }

    // Chain must be intact after all inserts
    const result = trail.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.rowsChecked).toBe(10);
  });

  // Spec case 7 (direct assertion): record() sets prev_hash and hash columns on inserted row.
  it('record() sets non-empty hash and prev_hash on the inserted row', () => {
    const trail = new AuditTrail(dbPath);
    const id = trail.record({ actor: 'system', action: 'init', resource: 'db', outcome: 'success' });

    const rawDb = new Database(dbPath);
    const row = rawDb.prepare('SELECT prev_hash, hash FROM audit_log WHERE id = ?').get(id) as {
      prev_hash: string;
      hash: string;
    };
    rawDb.close();

    // First row: prev_hash should be '' (genesis); hash should be a 64-char hex string.
    expect(row.prev_hash).toBe('');
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
