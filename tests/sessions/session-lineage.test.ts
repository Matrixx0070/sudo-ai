/**
 * Unit tests for SessionLineageTracker (Phase 5).
 * Uses in-memory better-sqlite3 with mocked SessionManager.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionLineageTracker } from '../../src/core/sessions/session-lineage.js';
import type { LineageConfig } from '../../src/core/sessions/session-lineage.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}
function makeSm(db: Database.Database) {
  return { db: { db } } as unknown as import('../../src/core/sessions/manager.js').SessionManager;
}
function makeTracker(overrides?: Partial<LineageConfig>) {
  const db = makeDb();
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-test-'));
  const tracker = new SessionLineageTracker(makeSm(db), {
    enableSnapshots: true, snapshotDir, maxLineageDepth: 10, ftsSearchLimit: 20, ...overrides,
  });
  return { tracker, db, snapshotDir };
}

// 1. Record lineage — parent-child chain
describe('recordLineage', () => {
  it('creates parent-child chain', () => {
    const { tracker } = makeTracker();
    const root = tracker.recordLineage('ses_A');
    const child = tracker.recordLineage('ses_B', 'ses_A', 'fork');
    const grandchild = tracker.recordLineage('ses_C', 'ses_B', 'compact');
    expect(root.parentId).toBeUndefined();
    expect(root.depth).toBe(0);
    expect(child.parentId).toBe('ses_A');
    expect(child.depth).toBe(1);
    expect(child.rootId).toBe('ses_A');
    expect(grandchild.depth).toBe(2);
    expect(grandchild.rootId).toBe('ses_A');
  });

  it('throws on empty sessionId', () => {
    const { tracker } = makeTracker();
    expect(() => tracker.recordLineage('')).toThrow(TypeError);
  });
});

// 2. Get lineage — full chain to root
describe('getLineage', () => {
  it('returns full chain from leaf to root', () => {
    const { tracker } = makeTracker();
    tracker.recordLineage('ses_root');
    tracker.recordLineage('ses_mid', 'ses_root');
    tracker.recordLineage('ses_leaf', 'ses_mid');
    const chain = tracker.getLineage('ses_leaf');
    expect(chain).toHaveLength(3);
    expect(chain.map((n) => n.sessionId)).toEqual(['ses_leaf', 'ses_mid', 'ses_root']);
  });

  it('returns single-element chain for root and empty for unknown', () => {
    const { tracker } = makeTracker();
    tracker.recordLineage('ses_solo');
    expect(tracker.getLineage('ses_solo')).toHaveLength(1);
    expect(tracker.getLineage('ses_ghost')).toEqual([]);
    expect(tracker.getLineage('')).toEqual([]);
  });
});

// 3. Root session — depth 0, no parent
describe('root session', () => {
  it('has depth 0 and no parent, and getRootSession returns itself', () => {
    const { tracker } = makeTracker();
    const lineage = tracker.recordLineage('ses_r1');
    expect(lineage.depth).toBe(0);
    expect(lineage.parentId).toBeUndefined();
    expect(lineage.rootId).toBe('ses_r1');
    const root = tracker.getRootSession('ses_r1');
    expect(root).not.toBeNull();
    expect(root!.sessionId).toBe('ses_r1');
  });
});

// 4. Child session — depth 1, has parent
describe('child session', () => {
  it('has depth 1 and references parent as root', () => {
    const { tracker } = makeTracker();
    tracker.recordLineage('ses_p1');
    const child = tracker.recordLineage('ses_ch1', 'ses_p1');
    expect(child.depth).toBe(1);
    expect(child.parentId).toBe('ses_p1');
    expect(child.rootId).toBe('ses_p1');
  });

  it('getRootSession returns ancestor for deeply nested child', () => {
    const { tracker } = makeTracker();
    tracker.recordLineage('ses_grand');
    tracker.recordLineage('ses_par', 'ses_grand');
    tracker.recordLineage('ses_ch2', 'ses_par');
    expect(tracker.getRootSession('ses_ch2')!.sessionId).toBe('ses_grand');
  });
});

// 5. Get children — returns all children of a parent
describe('getChildren', () => {
  it('returns all direct children of a parent', () => {
    const { tracker } = makeTracker();
    tracker.recordLineage('ses_p');
    tracker.recordLineage('ses_c1', 'ses_p');
    tracker.recordLineage('ses_c2', 'ses_p');
    tracker.recordLineage('ses_c3', 'ses_p');
    const ids = tracker.getChildren('ses_p').map((c) => c.sessionId).sort();
    expect(ids).toEqual(['ses_c1', 'ses_c2', 'ses_c3']);
  });

  it('returns empty for childless parent or empty id', () => {
    const { tracker } = makeTracker();
    tracker.recordLineage('ses_lonely');
    expect(tracker.getChildren('ses_lonely')).toEqual([]);
    expect(tracker.getChildren('')).toEqual([]);
  });
});

// 6. Create snapshot — freezes session state
describe('createSnapshot', () => {
  it('writes snapshot JSON to disk', async () => {
    const { tracker, snapshotDir } = makeTracker();
    const snap = await tracker.createSnapshot('ses_snap1');
    expect(snap.sessionId).toBe('ses_snap1');
    expect(snap.snapshotAt).toBeTruthy();
    const filePath = path.join(snapshotDir, 'ses_snap1.json');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessionId).toBe('ses_snap1');
  });

  it('returns empty files when snapshots disabled', async () => {
    const { tracker } = makeTracker({ enableSnapshots: false });
    expect((await tracker.createSnapshot('ses_ns')).files).toEqual([]);
  });

  it('throws on empty sessionId', async () => {
    const { tracker } = makeTracker();
    await expect(tracker.createSnapshot('')).rejects.toThrow(TypeError);
  });
});

// 7. Load snapshot — retrieves frozen snapshot
describe('loadSnapshot', () => {
  it('round-trips a created snapshot', async () => {
    const { tracker } = makeTracker();
    const created = await tracker.createSnapshot('ses_rt');
    const loaded = tracker.loadSnapshot('ses_rt');
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(created.sessionId);
  });

  it('returns null for non-existent or empty sessionId', () => {
    const { tracker } = makeTracker();
    expect(tracker.loadSnapshot('ses_missing')).toBeNull();
    expect(tracker.loadSnapshot('')).toBeNull();
  });
});

// 8. Cross-session search
describe('searchAcrossSessions', () => {
  it('returns empty for empty/whitespace query', () => {
    const { tracker } = makeTracker();
    expect(tracker.searchAcrossSessions('')).toEqual([]);
    expect(tracker.searchAcrossSessions('   ')).toEqual([]);
  });

  it('returns empty gracefully when FTS5 table does not exist', () => {
    const { tracker } = makeTracker();
    expect(tracker.searchAcrossSessions('test query')).toEqual([]);
  });
});

// 9. Max lineage depth — enforced limit
describe('max lineage depth', () => {
  it('caps depth at maxLineageDepth', () => {
    const maxDepth = 5;
    const { tracker } = makeTracker({ maxLineageDepth: maxDepth });
    tracker.recordLineage('ses_d0');
    for (let i = 1; i <= maxDepth + 3; i++) {
      tracker.recordLineage(`ses_d${i}`, `ses_d${i - 1}`);
    }
    const deep = tracker.recordLineage('ses_over', 'ses_d8');
    expect(deep.depth).toBeLessThanOrEqual(maxDepth);
  });
});

// 10. Stats tracking
describe('getStats', () => {
  it('tracks total lineages, avg depth, and search count', () => {
    const { tracker } = makeTracker();
    tracker.recordLineage('ses_s1');
    tracker.recordLineage('ses_s2');
    tracker.recordLineage('ses_s3', 'ses_s1');
    tracker.searchAcrossSessions('hello');
    tracker.searchAcrossSessions('world');
    const stats = tracker.getStats();
    expect(stats.totalLineages).toBe(3);
    expect(stats.searchCount).toBe(2);
    expect(stats.avgDepth).toBeGreaterThanOrEqual(0);
  });

  it('counts snapshots on disk', async () => {
    const { tracker } = makeTracker();
    expect(tracker.getStats().totalSnapshots).toBe(0);
    await tracker.createSnapshot('ses_ss1');
    await tracker.createSnapshot('ses_ss2');
    expect(tracker.getStats().totalSnapshots).toBe(2);
  });
});