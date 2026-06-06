/**
 * @file tests/agent/worktree-manager.test.ts
 * @description Tests for WorktreeManager — git worktree-based session isolation.
 *
 * Since there is no real git repo in the test context, all git commands are
 * mocked via vi.mock of node:child_process. Filesystem operations use /tmp.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Mock child_process so we never invoke real git
// vi.hoisted ensures the mock function is available before vi.mock factory runs.
// ---------------------------------------------------------------------------

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn((_cmd: string, _opts: unknown) => ''),
}));

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

// Import after mock setup so WorktreeManager sees the mock.
import { WorktreeManager, type WorktreeInfo } from '../../src/core/agent/worktree-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fake repo root in /tmp used by each test. */
let fakeRepoRoot: string;

/**
 * Configure the mock to behave as if `fakeRepoRoot` is a git repo.
 * - `git rev-parse --is-inside-work-tree` => "true"
 * - `git rev-parse --show-toplevel` => fakeRepoRoot
 * - `git worktree add ...` => "" (success)
 * - `git worktree remove ...` => "" (success)
 * - `git branch -D ...` => "" (success)
 */
function setupGitMocks(repoRoot: string): void {
  mockExecSync.mockImplementation((cmd: string, opts: any) => {
    const cwd = opts?.cwd ?? process.cwd();

    if (cmd === 'git rev-parse --is-inside-work-tree') {
      return cwd.startsWith(repoRoot) ? 'true\n' : 'fatal: not a git repository\n';
    }
    if (cmd === 'git rev-parse --show-toplevel') {
      return cwd.startsWith(repoRoot) ? `${repoRoot}\n` : '';
    }
    // git worktree add -b <branch> <path> HEAD
    if (cmd.startsWith('git worktree add')) {
      const pathMatch = cmd.match(/git worktree add -b (\S+) (\S+) HEAD/);
      if (pathMatch) {
        const worktreePath = pathMatch[2];
        mkdirSync(worktreePath, { recursive: true });
      }
      return '';
    }
    // git worktree remove --force <path>
    if (cmd.startsWith('git worktree remove')) {
      const pathMatch = cmd.match(/git worktree remove --force (\S+)/);
      if (pathMatch) {
        try { rmSync(pathMatch[1], { recursive: true, force: true }); } catch { /* ok */ }
      }
      return '';
    }
    // git branch -D <branch>
    if (cmd.startsWith('git branch -D')) {
      return '';
    }
    return '';
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorktreeManager', () => {
  beforeEach(() => {
    // Create a fresh fake repo root for each test.
    fakeRepoRoot = `/tmp/sudo-ai-test-wt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    mkdirSync(fakeRepoRoot, { recursive: true });
    mockExecSync.mockReset();
    setupGitMocks(fakeRepoRoot);
  });

  afterEach(() => {
    try {
      if (existsSync(fakeRepoRoot)) rmSync(fakeRepoRoot, { recursive: true, force: true });
    } catch { /* best effort */ }
    mockExecSync.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  it('WM-1: throws if constructed outside a git repository', () => {
    mockExecSync.mockImplementation(() => 'fatal: not a git repository\n');
    expect(() => new WorktreeManager('/tmp/not-a-repo')).toThrow('not inside a git repository');
  });

  it('WM-2: constructs successfully inside a git repo and creates worktrees dir', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    const expectedDir = join(fakeRepoRoot, '.claude/worktrees');
    expect(existsSync(expectedDir)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // createWorktree
  // -----------------------------------------------------------------------

  it('WM-3: createWorktree returns WorktreeInfo with correct fields', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    const info = mgr.createWorktree('sess-1');

    expect(info.sessionId).toBe('sess-1');
    expect(info.branch).toBe('wt/sess-1');
    expect(info.path).toBe(join(fakeRepoRoot, '.claude/worktrees/sess-1'));
    expect(info.isMainWorktree).toBe(false);
    expect(info.createdAt).toBeTruthy();
    // Validate ISO-8601 timestamp
    expect(() => new Date(info.createdAt)).not.toThrow();
  });

  it('WM-4: createWorktree uses a custom branch name when provided', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    const info = mgr.createWorktree('sess-2', 'feature/custom-branch');

    expect(info.branch).toBe('feature/custom-branch');
  });

  it('WM-5: createWorktree throws if session already has a worktree', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    mgr.createWorktree('sess-dup');
    expect(() => mgr.createWorktree('sess-dup')).toThrow('worktree already exists');
  });

  // -----------------------------------------------------------------------
  // removeWorktree
  // -----------------------------------------------------------------------

  it('WM-6: removeWorktree clears the registry and is idempotent', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    mgr.createWorktree('sess-rm');

    expect(mgr.isWorktreeSession('sess-rm')).toBe(true);
    mgr.removeWorktree('sess-rm');
    expect(mgr.isWorktreeSession('sess-rm')).toBe(false);
    expect(mgr.getWorktreePath('sess-rm')).toBe('');

    // Idempotent -- calling again does not throw.
    expect(() => mgr.removeWorktree('sess-rm')).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // getWorktreePath + isWorktreeSession
  // -----------------------------------------------------------------------

  it('WM-7: getWorktreePath returns empty string for unknown sessions', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    expect(mgr.getWorktreePath('nonexistent')).toBe('');
  });

  it('WM-8: isWorktreeSession returns false for unknown sessions', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    expect(mgr.isWorktreeSession('nonexistent')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // listWorktrees
  // -----------------------------------------------------------------------

  it('WM-9: listWorktrees returns all tracked worktrees', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    mgr.createWorktree('sess-a');
    mgr.createWorktree('sess-b');

    const list = mgr.listWorktrees();
    expect(list).toHaveLength(2);
    const ids = list.map((w) => w.sessionId).sort();
    expect(ids).toEqual(['sess-a', 'sess-b']);
  });

  // -----------------------------------------------------------------------
  // pruneStale
  // -----------------------------------------------------------------------

  it('WM-10: pruneStale removes worktrees older than the threshold', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    const info = mgr.createWorktree('sess-stale');

    // Use a negative threshold so any worktree (even just-created) is stale.
    const pruned = mgr.pruneStale(-1);

    expect(pruned).toContain('sess-stale');
    expect(mgr.isWorktreeSession('sess-stale')).toBe(false);
  });

  it('WM-11: pruneStale keeps worktrees younger than the threshold', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);
    mgr.createWorktree('sess-fresh');

    // 1-hour threshold -- a just-created worktree should survive.
    const pruned = mgr.pruneStale(60 * 60 * 1000);

    expect(pruned).not.toContain('sess-fresh');
    expect(mgr.isWorktreeSession('sess-fresh')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Multiple worktrees lifecycle
  // -----------------------------------------------------------------------

  it('WM-12: full lifecycle — create, query, list, remove, verify empty', () => {
    const mgr = new WorktreeManager(fakeRepoRoot);

    // Create two worktrees.
    const info1 = mgr.createWorktree('sess-x');
    const info2 = mgr.createWorktree('sess-y', 'custom-branch-y');

    // Query individual.
    expect(mgr.getWorktreePath('sess-x')).toBe(info1.path);
    expect(mgr.isWorktreeSession('sess-y')).toBe(true);

    // List.
    expect(mgr.listWorktrees()).toHaveLength(2);

    // Remove one.
    mgr.removeWorktree('sess-x');
    expect(mgr.listWorktrees()).toHaveLength(1);
    expect(mgr.isWorktreeSession('sess-x')).toBe(false);
    expect(mgr.isWorktreeSession('sess-y')).toBe(true);

    // Remove the other.
    mgr.removeWorktree('sess-y');
    expect(mgr.listWorktrees()).toHaveLength(0);
    expect(mgr.getWorktreePath('sess-y')).toBe('');
  });
});