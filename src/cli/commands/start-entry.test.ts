/**
 * @file cli/commands/start-entry.test.ts
 * @description Unit tests for resolveDaemonEntry() — the installed-vs-repo
 * daemon entry selection that `sudo-ai start` uses in both foreground and
 * --daemon modes.
 *
 * Regression guard for the 4.1.0 npm-package bug: the published tarball ships
 * only dist/ (no src/, no tsx), but start hardcoded `tsx src/cli.ts`, so
 * `sudo-ai start` died with ERR_MODULE_NOT_FOUND on every clean install.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveDaemonEntry, type EntryFs } from './start.js';

const ROOT = path.sep === '/' ? '/opt/sudo-ai' : 'C:\\opt\\sudo-ai';
const SRC_ENTRY = path.resolve(ROOT, 'src', 'cli.ts');
const DIST_ENTRY = path.resolve(ROOT, 'dist', 'src', 'cli.js');
const LOCAL_TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const FAKE_NODE = '/usr/bin/node-test';

function fakeFs(existing: string[]): EntryFs {
  const set = new Set(existing);
  return { existsSync: (p: string) => set.has(p) };
}

describe('resolveDaemonEntry', () => {
  it('repo layout: picks src/cli.ts with project-local tsx', () => {
    const entry = resolveDaemonEntry(ROOT, fakeFs([SRC_ENTRY, LOCAL_TSX, DIST_ENTRY]), FAKE_NODE);
    expect(entry.kind).toBe('src');
    expect(entry.entryPath).toBe(SRC_ENTRY);
    expect(entry.command).toBe(LOCAL_TSX);
    expect(entry.args).toEqual([SRC_ENTRY]);
  });

  it('repo layout without local tsx: falls back to tsx on PATH', () => {
    const entry = resolveDaemonEntry(ROOT, fakeFs([SRC_ENTRY]), FAKE_NODE);
    expect(entry.kind).toBe('src');
    expect(entry.command).toBe('tsx');
    expect(entry.args).toEqual([SRC_ENTRY]);
  });

  it('installed npm package: no src/ ships, picks dist/cli.js with plain node', () => {
    const entry = resolveDaemonEntry(ROOT, fakeFs([DIST_ENTRY]), FAKE_NODE);
    expect(entry.kind).toBe('dist');
    expect(entry.entryPath).toBe(DIST_ENTRY);
    expect(entry.command).toBe(FAKE_NODE);
    expect(entry.args).toEqual([DIST_ENTRY]);
  });

  it('prefers src over dist when both exist (repo with a stale build)', () => {
    const entry = resolveDaemonEntry(ROOT, fakeFs([SRC_ENTRY, DIST_ENTRY, LOCAL_TSX]), FAKE_NODE);
    expect(entry.kind).toBe('src');
  });

  it('corrupt install (neither entry): throws with an actionable message', () => {
    expect(() => resolveDaemonEntry(ROOT, fakeFs([]), FAKE_NODE)).toThrow(/src\/cli\.ts|dist\/cli\.js/);
  });
});
