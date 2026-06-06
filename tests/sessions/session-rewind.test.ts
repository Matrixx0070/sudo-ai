/**
 * @file tests/sessions/session-rewind.test.ts
 * @description Tests for SessionRewindManager — JSONL-based undo history.
 *
 * Tests:
 *  1.  recordPoint() creates a valid RewindPoint with correct fields
 *  2.  getRewindPoints() returns all recorded points in order
 *  3.  rewindTo() reverts files that differ from the target snapshot
 *  4.  rewindTo() identifies clean files (unchanged or post-checkpoint)
 *  5.  rewindTo() detects conflicts across consecutive checkpoints
 *  6.  rewindTo() truncates future points after rewind
 *  7.  persist() + restore() round-trips rewind points via JSONL
 *  8.  Size cap enforcement evicts oldest points when over 4.5 MB
 *  9.  restore() handles missing JSONL file gracefully (fresh start)
 *  10. ACP rewind/points returns filtered and limited results
 *  11. ACP rewind/execute dry-run returns result without mutating state
 *  12. ACP rewind/execute actual rewind mutates state correctly
 *  13. recordPoint() rejects negative turnNumber
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SessionRewindManager,
  MAX_REWIND_SIZE,
  REWIND_POINTS_FILE,
} from '../../src/core/sessions/session-rewind.js';
import type { RewindPoint, RewindResult } from '../../src/core/sessions/session-rewind.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-rewind-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeFiles(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionRewindManager', () => {
  it('1. recordPoint() creates a valid RewindPoint with correct fields', () => {
    const mgr = new SessionRewindManager();
    const files = makeFiles([['/src/a.ts', 'content-a'], ['/src/b.ts', 'content-b']]);
    const point = mgr.recordPoint(1, files, 5);

    expect(point.id).toBeTruthy();
    expect(point.turnNumber).toBe(1);
    expect(point.timestamp).toBeTruthy();
    expect(point.fileSnapshots['/src/a.ts']).toBe('content-a');
    expect(point.fileSnapshots['/src/b.ts']).toBe('content-b');
    expect(point.conversationLength).toBe(5);
    expect(mgr.count).toBe(1);
  });

  it('2. getRewindPoints() returns all recorded points in order', () => {
    const mgr = new SessionRewindManager();
    mgr.recordPoint(1, makeFiles([['/a', '1']]), 3);
    mgr.recordPoint(2, makeFiles([['/a', '2']]), 6);
    mgr.recordPoint(3, makeFiles([['/a', '3']]), 9);

    const points = mgr.getRewindPoints();
    expect(points).toHaveLength(3);
    expect(points[0].turnNumber).toBe(1);
    expect(points[1].turnNumber).toBe(2);
    expect(points[2].turnNumber).toBe(3);
  });

  it('3. rewindTo() reverts files that differ from the target snapshot', () => {
    const mgr = new SessionRewindManager();
    const filesTurn1 = makeFiles([['/a.ts', 'v1'], ['/b.ts', 'v1']]);
    mgr.recordPoint(1, filesTurn1, 2);

    // Modify a.ts, add c.ts
    const filesTurn2 = makeFiles([['/a.ts', 'v2'], ['/b.ts', 'v1'], ['/c.ts', 'new']]);
    const point2 = mgr.recordPoint(2, filesTurn2, 4);

    // Now the manager's currentFiles reflect turn 2.
    // Rewind to turn 1: a.ts should be reverted (v2 -> v1), c.ts is clean (not in snapshot)
    const point1 = mgr.getRewindPoints()[0];
    const result = mgr.rewindTo(point1.id);

    expect(result.revertedFiles).toContain('/a.ts');
    // b.ts matches snapshot so it's clean
    expect(result.cleanFiles).toContain('/b.ts');
    // c.ts was created after the checkpoint — clean
    expect(result.cleanFiles).toContain('/c.ts');
  });

  it('4. rewindTo() identifies clean files (unchanged or post-checkpoint)', () => {
    const mgr = new SessionRewindManager();
    const files = makeFiles([['/x.ts', 'same'], ['/y.ts', 'same']]);
    mgr.recordPoint(1, files, 2);

    // Record again with identical content
    mgr.recordPoint(2, files, 4);

    // Rewind to turn 1 — both files are identical to the snapshot
    const point1 = mgr.getRewindPoints()[0];
    const result = mgr.rewindTo(point1.id);

    expect(result.revertedFiles).toHaveLength(0);
    expect(result.cleanFiles).toContain('/x.ts');
    expect(result.cleanFiles).toContain('/y.ts');
  });

  it('5. rewindTo() detects conflicts across consecutive checkpoints', () => {
    const mgr = new SessionRewindManager();

    // Turn 1: a.ts = "alpha"
    mgr.recordPoint(1, makeFiles([['/a.ts', 'alpha']]), 2);
    // Turn 2: a.ts = "beta"
    mgr.recordPoint(2, makeFiles([['/a.ts', 'beta']]), 4);
    // Turn 3: a.ts = "gamma" — current state
    const point3 = mgr.recordPoint(3, makeFiles([['/a.ts', 'gamma']]), 6);

    // Rewind to turn 2:
    // a.ts differs from snapshot ("gamma" vs "beta") → reverted
    // Turn 1 had "alpha", turn 2 had "beta" → content changed across checkpoint boundary → conflict
    const point2 = mgr.getRewindPoints()[1];
    const result = mgr.rewindTo(point2.id);

    expect(result.revertedFiles).toContain('/a.ts');
    expect(result.conflicts).toContain('/a.ts');
  });

  it('6. rewindTo() truncates future points after rewind', () => {
    const mgr = new SessionRewindManager();
    mgr.recordPoint(1, makeFiles([['/a', '1']]), 2);
    mgr.recordPoint(2, makeFiles([['/a', '2']]), 4);
    mgr.recordPoint(3, makeFiles([['/a', '3']]), 6);
    mgr.recordPoint(4, makeFiles([['/a', '4']]), 8);

    // Rewind to turn 2
    const point2 = mgr.getRewindPoints()[1];
    mgr.rewindTo(point2.id);

    // Points 3 and 4 should be gone
    const remaining = mgr.getRewindPoints();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].turnNumber).toBe(1);
    expect(remaining[1].turnNumber).toBe(2);
  });

  it('7. persist() + restore() round-trips rewind points via JSONL', () => {
    const mgr = new SessionRewindManager();
    mgr.recordPoint(1, makeFiles([['/a.ts', 'v1']]), 3);
    mgr.recordPoint(2, makeFiles([['/a.ts', 'v2'], ['/b.ts', 'v1']]), 6);
    mgr.recordPoint(3, makeFiles([['/a.ts', 'v3']]), 9);

    // Persist
    mgr.persist(tmpDir);
    const jsonlPath = path.join(tmpDir, REWIND_POINTS_FILE);
    expect(fs.existsSync(jsonlPath)).toBe(true);

    // Restore into a fresh manager
    const mgr2 = new SessionRewindManager();
    mgr2.restore(tmpDir);

    const points = mgr2.getRewindPoints();
    expect(points).toHaveLength(3);
    expect(points[0].turnNumber).toBe(1);
    expect(points[0].fileSnapshots['/a.ts']).toBe('v1');
    expect(points[1].turnNumber).toBe(2);
    expect(points[1].fileSnapshots['/a.ts']).toBe('v2');
    expect(points[1].fileSnapshots['/b.ts']).toBe('v1');
    expect(points[2].turnNumber).toBe(3);
    expect(points[2].fileSnapshots['/a.ts']).toBe('v3');

    // currentFiles should reflect last point
    expect(mgr2.files.get('/a.ts')).toBe('v3');
  });

  it('8. Size cap enforcement evicts oldest points when over 4.5 MB', () => {
    const mgr = new SessionRewindManager();

    // Create large file content to trigger size cap quickly
    // 4.5 MB / ~500KB per point ≈ need ~9-10 points to trigger eviction
    const largeContent = 'x'.repeat(500_000); // ~500 KB
    const totalPoints = 12;

    for (let i = 1; i <= totalPoints; i++) {
      mgr.recordPoint(i, makeFiles([['/big.ts', largeContent + i]]), i * 3);
    }

    // Should have evicted some oldest points
    expect(mgr.count).toBeLessThan(totalPoints);
    expect(mgr.sizeBytes).toBeLessThanOrEqual(MAX_REWIND_SIZE + 600_000); // allow margin for eviction timing
    // Remaining points should be the most recent ones
    const remaining = mgr.getRewindPoints();
    expect(remaining[remaining.length - 1].turnNumber).toBe(totalPoints);
  });

  it('9. restore() handles missing JSONL file gracefully (fresh start)', () => {
    const mgr = new SessionRewindManager();
    const emptyDir = path.join(tmpDir, 'no-jsonl');

    // Should not throw, should start fresh
    mgr.restore(emptyDir);

    expect(mgr.count).toBe(0);
    expect(mgr.sizeBytes).toBe(0);
    expect(mgr.files.size).toBe(0);
  });

  it('10. ACP rewind/points returns filtered and limited results', () => {
    const mgr = new SessionRewindManager();
    for (let i = 1; i <= 5; i++) {
      mgr.recordPoint(i, makeFiles([['/a', `v${i}`]]), i * 2);
    }

    // No filter — all points
    const all = mgr.handleAcpRewindPoints({ method: 'rewind/points' });
    expect(all.points).toHaveLength(5);

    // minTurn filter
    const filtered = mgr.handleAcpRewindPoints({ method: 'rewind/points', minTurn: 3 });
    expect(filtered.points).toHaveLength(3);
    expect(filtered.points[0].turnNumber).toBe(3);

    // limit
    const limited = mgr.handleAcpRewindPoints({ method: 'rewind/points', limit: 2 });
    expect(limited.points).toHaveLength(2);
    expect(limited.points[0].turnNumber).toBe(4);
    expect(limited.points[1].turnNumber).toBe(5);

    // Both minTurn and limit
    const both = mgr.handleAcpRewindPoints({ method: 'rewind/points', minTurn: 2, limit: 2 });
    expect(both.points).toHaveLength(2);
    expect(both.points[0].turnNumber).toBe(4);
    expect(both.points[1].turnNumber).toBe(5);
  });

  it('11. ACP rewind/execute dry-run returns result without mutating state', () => {
    const mgr = new SessionRewindManager();
    mgr.recordPoint(1, makeFiles([['/a.ts', 'v1']]), 2);
    const point2 = mgr.recordPoint(2, makeFiles([['/a.ts', 'v2']]), 4);
    mgr.recordPoint(3, makeFiles([['/a.ts', 'v3']]), 6);

    // Dry-run rewind to turn 2
    const dryResult = mgr.handleAcpRewindExecute({
      method: 'rewind/execute',
      rewindId: point2.id,
      dryRun: true,
    });

    expect(dryResult.success).toBe(true);
    expect(dryResult.revertedFiles).toContain('/a.ts');

    // State should NOT be mutated — still 3 points, currentFiles still at turn 3
    expect(mgr.count).toBe(3);
    expect(mgr.files.get('/a.ts')).toBe('v3');
  });

  it('12. ACP rewind/execute actual rewind mutates state correctly', () => {
    const mgr = new SessionRewindManager();
    mgr.recordPoint(1, makeFiles([['/a.ts', 'v1']]), 2);
    const point2 = mgr.recordPoint(2, makeFiles([['/a.ts', 'v2']]), 4);
    mgr.recordPoint(3, makeFiles([['/a.ts', 'v3']]), 6);

    // Actual rewind to turn 2
    const result = mgr.handleAcpRewindExecute({
      method: 'rewind/execute',
      rewindId: point2.id,
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.revertedFiles).toContain('/a.ts');

    // State IS mutated — only 2 points, currentFiles restored to turn 2
    expect(mgr.count).toBe(2);
    expect(mgr.files.get('/a.ts')).toBe('v2');
  });

  it('13. recordPoint() rejects negative turnNumber', () => {
    const mgr = new SessionRewindManager();
    expect(() => mgr.recordPoint(-1, new Map(), 0)).toThrow(TypeError);
  });
});