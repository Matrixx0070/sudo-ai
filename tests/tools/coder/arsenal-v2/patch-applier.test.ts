/**
 * @file patch-applier.test.ts
 * @description Tests for the atomic per-file patch applier with drift detection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPatches } from '../../../../src/core/tools/builtin/coder/arsenal-v2/patch-applier.js';
import type { PatchOp } from '../../../../src/core/tools/builtin/coder/arsenal-v2/patch-types.js';

let projectRoot: string;
let backupRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'arsenal-v2-project-'));
  backupRoot = await mkdtemp(path.join(tmpdir(), 'arsenal-v2-backups-'));
});
afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(backupRoot, { recursive: true, force: true });
});

async function seed(rel: string, content: string): Promise<void> {
  const abs = path.join(projectRoot, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function readRel(rel: string): Promise<string> {
  return readFile(path.join(projectRoot, rel), 'utf-8');
}

describe('applyPatches — str_replace happy path', () => {
  it('replaces a unique occurrence and writes atomically', async () => {
    await seed('src/foo.ts', 'function bar() { return 1; }\nexport { bar };\n');
    const ops: PatchOp[] = [
      { op: 'str_replace', file: 'src/foo.ts', old: 'return 1;', new: 'return 2;' },
    ];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('applied');
    expect(result.filesWritten).toEqual(['src/foo.ts']);
    expect(await readRel('src/foo.ts')).toBe('function bar() { return 2; }\nexport { bar };\n');
  });
});

describe('applyPatches — str_replace drift + ambiguity', () => {
  it('skips when "old" is not present (drift)', async () => {
    await seed('a.ts', 'never matches anything\n');
    const ops: PatchOp[] = [{ op: 'str_replace', file: 'a.ts', old: 'xyz', new: 'abc' }];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('skipped');
    expect(result.results[0]?.reason).toBe('drift_detected');
    expect(await readRel('a.ts')).toBe('never matches anything\n');
  });
  it('skips when "old" appears more than once (ambiguous)', async () => {
    await seed('a.ts', 'foo\nfoo\n');
    const ops: PatchOp[] = [{ op: 'str_replace', file: 'a.ts', old: 'foo', new: 'bar' }];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('skipped');
    expect(result.results[0]?.reason).toBe('anchor_ambiguous');
    expect(await readRel('a.ts')).toBe('foo\nfoo\n');
  });
});

describe('applyPatches — insert_after / insert_before', () => {
  it('inserts content on the line after the anchor', async () => {
    await seed('a.ts', '// imports\nconst x = 1;\n');
    const ops: PatchOp[] = [
      { op: 'insert_after', file: 'a.ts', anchor: '// imports', content: "import { y } from './y';" },
    ];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('applied');
    expect(await readRel('a.ts')).toBe("// imports\nimport { y } from './y';\nconst x = 1;\n");
  });
  it('inserts content on the line before the anchor', async () => {
    await seed('a.ts', 'const x = 1;\n// end\n');
    const ops: PatchOp[] = [
      { op: 'insert_before', file: 'a.ts', anchor: '// end', content: 'const z = 2;' },
    ];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('applied');
    expect(await readRel('a.ts')).toBe('const x = 1;\nconst z = 2;\n// end\n');
  });
  it('skips when anchor is missing', async () => {
    await seed('a.ts', 'no anchor here\n');
    const ops: PatchOp[] = [
      { op: 'insert_after', file: 'a.ts', anchor: '// missing', content: 'x' },
    ];
    expect(applyPatches(ops, { projectRoot, backupRoot }).results[0]?.reason).toBe('anchor_not_found');
  });
});

describe('applyPatches — create_file / delete_file', () => {
  it('creates a new file with content', async () => {
    const ops: PatchOp[] = [{ op: 'create_file', file: 'src/new.ts', content: 'export const a = 1;\n' }];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('applied');
    expect(result.filesWritten).toEqual(['src/new.ts']);
    expect(await readRel('src/new.ts')).toBe('export const a = 1;\n');
  });
  it('refuses to overwrite an existing file', async () => {
    await seed('src/exists.ts', 'existing content');
    const ops: PatchOp[] = [{ op: 'create_file', file: 'src/exists.ts', content: 'new content' }];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('failed');
    expect(result.results[0]?.reason).toBe('file_already_exists');
    expect(await readRel('src/exists.ts')).toBe('existing content');
  });
  it('deletes an existing file with backup', async () => {
    await seed('src/gone.ts', 'remove me');
    const ops: PatchOp[] = [{ op: 'delete_file', file: 'src/gone.ts' }];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('applied');
    expect(result.filesDeleted).toEqual(['src/gone.ts']);
    expect(existsSync(path.join(projectRoot, 'src/gone.ts'))).toBe(false);
  });
  it('fails delete on missing file', async () => {
    const ops: PatchOp[] = [{ op: 'delete_file', file: 'src/never-was.ts' }];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('failed');
    expect(result.results[0]?.reason).toBe('file_not_found');
  });
});

describe('applyPatches — path-traversal guard', () => {
  it('blocks paths resolving outside the project root', async () => {
    // The path is project-relative per the parser contract but the applier
    // recomputes the resolved path; here we simulate a path that would
    // escape via symlink-style resolution. We feed an absolute path that
    // resolves outside; the applier should reject.
    const ops: PatchOp[] = [
      { op: 'str_replace', file: '../escape.ts', old: 'a', new: 'b' },
    ];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('failed');
    expect(result.results[0]?.reason).toBe('path_outside_project');
  });
});

describe('applyPatches — per-file isolation', () => {
  it('applies a good op even when a parallel file has drift', async () => {
    await seed('good.ts', 'old\n');
    await seed('bad.ts', 'unrelated\n');
    const ops: PatchOp[] = [
      { op: 'str_replace', file: 'good.ts', old: 'old', new: 'new' },
      { op: 'str_replace', file: 'bad.ts', old: 'no-match', new: 'x' },
    ];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    const byFile = Object.fromEntries(result.results.map((r) => [r.op.file, r.status]));
    expect(byFile['good.ts']).toBe('applied');
    expect(byFile['bad.ts']).toBe('skipped');
    expect(await readRel('good.ts')).toBe('new\n');
    expect(await readRel('bad.ts')).toBe('unrelated\n');
  });
});

describe('applyPatches — mixed-op rejection', () => {
  it('refuses create + mutate against the same file in one batch', async () => {
    const ops: PatchOp[] = [
      { op: 'create_file', file: 'a.ts', content: 'x' },
      { op: 'str_replace', file: 'a.ts', old: 'x', new: 'y' },
    ];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results.every((r) => r.status === 'failed')).toBe(true);
    expect(result.results[0]?.detail).toContain('mixed create/delete/mutate');
  });
});

describe('applyPatches — backup', () => {
  it('writes a backup of the original before mutating', async () => {
    await seed('foo.ts', 'before\n');
    const ops: PatchOp[] = [{ op: 'str_replace', file: 'foo.ts', old: 'before', new: 'after' }];
    const result = applyPatches(ops, { projectRoot, backupRoot });
    expect(result.results[0]?.status).toBe('applied');
    // The backup dir name is a timestamp under backupRoot. We just verify
    // a backup file exists for the touched path.
    const backedUp = await readFile(path.join(result.backupDir, 'foo.ts'), 'utf-8');
    expect(backedUp).toBe('before\n');
  });
});
