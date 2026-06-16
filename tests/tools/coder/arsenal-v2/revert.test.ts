/**
 * Unit tests for arsenal-v2 auto-revert (PR #186 deferred limitation).
 *
 * Pins:
 *   - readAutoRevertEnabled strict opt-in via SUDO_ARSENAL_V2_AUTO_REVERT=1
 *   - revertAttempts: earliest-backup-per-file wins (multi-attempt mutation)
 *   - revertAttempts: created files get deleted, not restored
 *   - revertAttempts: best-effort on missing-backup / collision (no throw)
 *   - revertAttempts: empty attempts → no-op
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readAutoRevertEnabled,
  revertAttempts,
  type RevertAttempt,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/revert.js';
import type { ApplyResult, PatchOp, PatchOpResult } from '../../../../src/core/tools/builtin/coder/arsenal-v2/patch-types.js';

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'arsenal-revert-test-'));
}

function attempt(opts: {
  backupDir: string;
  results: Array<{ op: PatchOp; status: 'applied' | 'skipped' | 'failed' }>;
}): RevertAttempt {
  const r: PatchOpResult[] = opts.results.map((x) => ({ op: x.op, status: x.status }));
  const apply: ApplyResult = {
    results: r,
    filesWritten: r.filter((x) => x.status === 'applied' && x.op.op !== 'delete_file').map((x) => x.op.file),
    filesDeleted: r.filter((x) => x.status === 'applied' && x.op.op === 'delete_file').map((x) => x.op.file),
    backupDir: opts.backupDir,
  };
  return { applyResult: apply };
}

function encode(rel: string): string {
  return rel.replace(/[\\/]/g, '__');
}

let workspaces: string[] = [];
beforeEach(() => {
  workspaces = [];
});
afterEach(() => {
  for (const w of workspaces) {
    try { rmSync(w, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
function workspace(): string {
  const w = tmp();
  workspaces.push(w);
  return w;
}

describe('readAutoRevertEnabled', () => {
  it('defaults to false when env var is unset', () => {
    expect(readAutoRevertEnabled({})).toBe(false);
  });

  it('returns true ONLY for the literal string "1"', () => {
    expect(readAutoRevertEnabled({ SUDO_ARSENAL_V2_AUTO_REVERT: '1' })).toBe(true);
    expect(readAutoRevertEnabled({ SUDO_ARSENAL_V2_AUTO_REVERT: 'true' })).toBe(false);
    expect(readAutoRevertEnabled({ SUDO_ARSENAL_V2_AUTO_REVERT: 'yes' })).toBe(false);
    expect(readAutoRevertEnabled({ SUDO_ARSENAL_V2_AUTO_REVERT: '0' })).toBe(false);
    expect(readAutoRevertEnabled({ SUDO_ARSENAL_V2_AUTO_REVERT: '' })).toBe(false);
  });
});

describe('revertAttempts', () => {
  it('returns zeroed result for an empty attempts list (no-op)', () => {
    const r = revertAttempts([], { projectRoot: workspace() });
    expect(r).toEqual({ restored: 0, deleted: 0, failed: 0, errors: [] });
  });

  it('restores a single modified file from its backup', () => {
    const root = workspace();
    const backupDir = path.join(root, 'data', 'arsenal-v2-backups', '1000');
    mkdirSync(backupDir, { recursive: true });

    const rel = 'src/foo.ts';
    writeFileSync(path.join(root, 'src'), '', { flag: 'w' }); // (placeholder, removed by mkdir)
    rmSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'src'), { recursive: true });

    // Pre-tool content snapshot lives in the backup dir.
    writeFileSync(path.join(backupDir, encode(rel)), 'original content');
    // Current (mutated) content lives at the project path.
    writeFileSync(path.join(root, rel), 'mutated by arsenal');

    const r = revertAttempts(
      [attempt({
        backupDir,
        results: [{ op: { op: 'str_replace', file: rel, old: 'x', new: 'y' }, status: 'applied' }],
      })],
      { projectRoot: root },
    );

    expect(r.restored).toBe(1);
    expect(r.deleted).toBe(0);
    expect(r.failed).toBe(0);
    expect(readFileSync(path.join(root, rel), 'utf8')).toBe('original content');
  });

  it('deletes a created file instead of restoring (pre-tool state was absent)', () => {
    const root = workspace();
    const backupDir = path.join(root, 'data', 'arsenal-v2-backups', '2000');
    mkdirSync(backupDir, { recursive: true });

    const rel = 'src/new.ts';
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, rel), 'created by arsenal');
    // .created marker (mirrors patch-applier behavior).
    writeFileSync(path.join(backupDir, encode(rel) + '.created'), '');

    const r = revertAttempts(
      [attempt({
        backupDir,
        results: [{ op: { op: 'create_file', file: rel, content: 'created by arsenal' }, status: 'applied' }],
      })],
      { projectRoot: root },
    );

    expect(r.deleted).toBe(1);
    expect(r.restored).toBe(0);
    expect(existsSync(path.join(root, rel))).toBe(false);
  });

  it('earliest-backup-per-file wins: attempt 2 mutation does NOT overwrite attempt 1 backup', () => {
    const root = workspace();
    const rel = 'src/foo.ts';
    mkdirSync(path.join(root, 'src'), { recursive: true });

    const backupA = path.join(root, 'data', 'arsenal-v2-backups', '1000');
    const backupB = path.join(root, 'data', 'arsenal-v2-backups', '2000');
    mkdirSync(backupA, { recursive: true });
    mkdirSync(backupB, { recursive: true });

    // Pre-tool state ("ORIGINAL") is the backup for attempt 1; attempt 2's
    // backup is the post-attempt-1 state ("AFTER A"). Reverting must use
    // attempt 1's backup, not attempt 2's.
    writeFileSync(path.join(backupA, encode(rel)), 'ORIGINAL');
    writeFileSync(path.join(backupB, encode(rel)), 'AFTER A');
    writeFileSync(path.join(root, rel), 'AFTER B (current)');

    const r = revertAttempts(
      [
        attempt({
          backupDir: backupA,
          results: [{ op: { op: 'str_replace', file: rel, old: 'a', new: 'b' }, status: 'applied' }],
        }),
        attempt({
          backupDir: backupB,
          results: [{ op: { op: 'str_replace', file: rel, old: 'c', new: 'd' }, status: 'applied' }],
        }),
      ],
      { projectRoot: root },
    );

    expect(r.restored).toBe(1);
    expect(readFileSync(path.join(root, rel), 'utf8')).toBe('ORIGINAL');
  });

  it('ignores non-applied results (skipped / failed ops have no backup to restore)', () => {
    const root = workspace();
    const backupDir = path.join(root, 'data', 'arsenal-v2-backups', '3000');
    mkdirSync(backupDir, { recursive: true });

    const r = revertAttempts(
      [attempt({
        backupDir,
        results: [
          { op: { op: 'str_replace', file: 'src/x.ts', old: 'a', new: 'b' }, status: 'skipped' },
          { op: { op: 'str_replace', file: 'src/y.ts', old: 'a', new: 'b' }, status: 'failed' },
        ],
      })],
      { projectRoot: root },
    );

    expect(r).toEqual({ restored: 0, deleted: 0, failed: 0, errors: [] });
  });

  it('best-effort on missing backup: records the failure but does not throw', () => {
    const root = workspace();
    const backupDir = path.join(root, 'data', 'arsenal-v2-backups', '4000');
    mkdirSync(backupDir, { recursive: true });

    const rel = 'src/missing.ts';
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, rel), 'mutated content');
    // NO backup file at backupDir/encode(rel).

    const r = revertAttempts(
      [attempt({
        backupDir,
        results: [{ op: { op: 'str_replace', file: rel, old: 'a', new: 'b' }, status: 'applied' }],
      })],
      { projectRoot: root },
    );

    expect(r.failed).toBe(1);
    expect(r.restored).toBe(0);
    expect(r.errors[0]).toMatch(/src\/missing\.ts: backup file missing/);
    // Current file is left untouched (no destructive guess).
    expect(readFileSync(path.join(root, rel), 'utf8')).toBe('mutated content');
  });

  it('treats a created-then-deleted-by-later-attempt file as a no-op (delete branch tolerates absence)', () => {
    const root = workspace();
    const rel = 'src/short-lived.ts';

    const backupA = path.join(root, 'data', 'arsenal-v2-backups', '5000');
    const backupB = path.join(root, 'data', 'arsenal-v2-backups', '6000');
    mkdirSync(backupA, { recursive: true });
    mkdirSync(backupB, { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });

    // Attempt 1 created the file (with .created marker), attempt 2 deleted it
    // (its delete backup = the attempt-1 content). The file is currently
    // ABSENT on disk. Revert should treat this as already-clean.
    writeFileSync(path.join(backupA, encode(rel) + '.created'), '');
    writeFileSync(path.join(backupB, encode(rel)), 'attempt-1 content');

    const r = revertAttempts(
      [
        attempt({
          backupDir: backupA,
          results: [{ op: { op: 'create_file', file: rel, content: 'attempt-1 content' }, status: 'applied' }],
        }),
        attempt({
          backupDir: backupB,
          results: [{ op: { op: 'delete_file', file: rel }, status: 'applied' }],
        }),
      ],
      { projectRoot: root },
    );

    // Earliest wins → first-touch was create. File is already absent, so
    // delete is a no-op success (no failure recorded, no count incremented).
    expect(r.deleted).toBe(0);
    expect(r.restored).toBe(0);
    expect(r.failed).toBe(0);
    expect(existsSync(path.join(root, rel))).toBe(false);
  });

  it('restores a delete_file op (pre-tool state had the file)', () => {
    const root = workspace();
    const backupDir = path.join(root, 'data', 'arsenal-v2-backups', '7000');
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });

    const rel = 'src/deleted.ts';
    // Pre-deletion content was backed up by the applier.
    writeFileSync(path.join(backupDir, encode(rel)), 'I was deleted');
    // Current state: file is absent on disk.

    const r = revertAttempts(
      [attempt({
        backupDir,
        results: [{ op: { op: 'delete_file', file: rel }, status: 'applied' }],
      })],
      { projectRoot: root },
    );

    expect(r.restored).toBe(1);
    expect(readFileSync(path.join(root, rel), 'utf8')).toBe('I was deleted');
  });
});
