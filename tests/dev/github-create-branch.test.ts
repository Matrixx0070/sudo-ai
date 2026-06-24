/**
 * @file github-create-branch.test.ts
 * @description Regression: createBranch must recover when the target branch
 * already exists instead of hard-failing. Branch names are semantic (e.g.
 * `auto-fix/<issue>-<slug>`), so retrying the same fix collides — and the old
 * `git checkout -b` path returned "ERROR: ...already exists", which the auto-fix
 * trigger treated as a terminal failure (observed live 3×). The fix switches
 * onto the existing branch so the flow continues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.exec; execAsync = promisify(exec) in the module under test.
const execImpl = vi.fn<(cmd: string, cb: (e: Error | null, out?: unknown) => void) => void>();
vi.mock('child_process', () => ({
  exec: (cmd: string, cb: (e: Error | null, out?: unknown) => void) => execImpl(cmd, cb),
}));

import { createBranch } from '../../src/core/tools/builtin/dev/github-integration.js';

beforeEach(() => {
  execImpl.mockReset();
});

describe('createBranch — existing-branch recovery', () => {
  it('creates a fresh branch normally', async () => {
    execImpl.mockImplementation((_cmd, cb) => cb(null, { stdout: '', stderr: '' }));
    const r = await createBranch('auto-fix/124-fresh');
    expect(r).not.toMatch(/^ERROR:/);
    expect(r).toMatch(/created and checked out/i);
  });

  it('reuses the branch (plain checkout) when it already exists, no ERROR', async () => {
    const cmds: string[] = [];
    execImpl.mockImplementation((cmd, cb) => {
      cmds.push(cmd);
      if (cmd.includes('checkout -b')) {
        cb(new Error("fatal: a branch named 'auto-fix/123-x' already exists"));
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });
    const r = await createBranch('auto-fix/123-x');
    expect(r).not.toMatch(/^ERROR:/);
    expect(r).toMatch(/already existed/i);
    // Attempted `checkout -b`, then fell back to a plain `checkout`.
    expect(cmds.some((c) => c.includes('checkout -b'))).toBe(true);
    expect(cmds.some((c) => /git checkout (?!-b)/.test(c))).toBe(true);
  });

  it('propagates a non-"already exists" error as ERROR', async () => {
    execImpl.mockImplementation((_cmd, cb) => cb(new Error('fatal: not a git repository')));
    const r = await createBranch('auto-fix/125-z');
    expect(r).toMatch(/^ERROR:/);
    expect(r).toMatch(/not a git repository/);
  });

  it('surfaces ERROR if the fallback checkout also fails', async () => {
    execImpl.mockImplementation((cmd, cb) => {
      if (cmd.includes('checkout -b')) cb(new Error("a branch named 'x' already exists"));
      else cb(new Error('error: pathspec did not match (worktree conflict)'));
    });
    const r = await createBranch('auto-fix/126-w');
    expect(r).toMatch(/^ERROR:/);
    expect(r).toMatch(/pathspec/);
  });
});
