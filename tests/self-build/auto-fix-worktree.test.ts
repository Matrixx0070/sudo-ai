/**
 * @file auto-fix-worktree.test.ts
 * @description Regression: the unattended auto-fix flow must never move the
 * shared working tree's HEAD. It used to call `createBranch()` → `git checkout -b`
 * in the main checkout while running on a half-hourly cron; observed live, a
 * branch switch 48s into a 145s test run corrupted it, and an earlier auto-fix
 * checkout destroyed an in-progress merge.
 *
 * These tests drive REAL git against a scratch repo — the HEAD assertion is the
 * actual bug and is worthless against a mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import {
  withAutoFixWorktree,
  pruneAutoFixWorktrees,
  WorktreeSetupError,
  WORKTREE_PREFIX,
} from '../../src/core/self-build/git-worktree.js';

const sh = promisify(exec);

let repoRoot: string;
let baseDir: string;

async function head(): Promise<string> {
  const { stdout } = await sh('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
  return stdout.trim();
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-wt-test-'));
  repoRoot = path.join(root, 'repo');
  baseDir = path.join(root, 'worktrees');
  await fs.mkdir(repoRoot, { recursive: true });
  await sh('git init -b main', { cwd: repoRoot });
  await sh('git config user.email t@t.t && git config user.name t', { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'seed\n');
  await sh('git add -A && git commit -m seed', { cwd: repoRoot });
});

afterEach(async () => {
  await fs.rm(path.dirname(repoRoot), { recursive: true, force: true }).catch(() => undefined);
});

describe('withAutoFixWorktree', () => {
  it('creates a worktree on the requested branch and leaves main HEAD untouched', async () => {
    const before = await head();
    let seen = '';
    let seenDir = '';

    await withAutoFixWorktree(
      'auto-fix/123-some-bug',
      async ({ dir, branch }) => {
        seenDir = dir;
        expect(branch).toBe('auto-fix/123-some-bug');
        const { stdout } = await sh('git rev-parse --abbrev-ref HEAD', { cwd: dir });
        seen = stdout.trim();
        // The main checkout must NOT have moved while the worktree is live.
        expect(await head()).toBe(before);
      },
      { repoRoot, baseDir },
    );

    expect(seen).toBe('auto-fix/123-some-bug');
    expect(await head()).toBe(before);
    // Cleaned up.
    await expect(fs.stat(seenDir)).rejects.toThrow();
    const { stdout: list } = await sh('git worktree list', { cwd: repoRoot });
    expect(list).not.toContain(WORKTREE_PREFIX);
  });

  it('removes the worktree even when the body throws, and still leaves HEAD alone', async () => {
    const before = await head();
    let seenDir = '';

    await expect(
      withAutoFixWorktree(
        'auto-fix/9-boom',
        async ({ dir }) => {
          seenDir = dir;
          throw new Error('fix application blew up');
        },
        { repoRoot, baseDir },
      ),
    ).rejects.toThrow(/blew up/);

    expect(seenDir).not.toBe('');
    await expect(fs.stat(seenDir)).rejects.toThrow();
    expect(await head()).toBe(before);
    const { stdout: list } = await sh('git worktree list --porcelain', { cwd: repoRoot });
    expect(list).not.toContain(WORKTREE_PREFIX);
  });

  it('reuses an existing branch instead of dead-ending, without checking it out in main', async () => {
    await sh('git branch auto-fix/7-existing', { cwd: repoRoot });
    const before = await head();

    const out = await withAutoFixWorktree(
      'auto-fix/7-existing',
      async ({ dir }) => (await sh('git rev-parse --abbrev-ref HEAD', { cwd: dir })).stdout.trim(),
      { repoRoot, baseDir },
    );

    expect(out).toBe('auto-fix/7-existing');
    expect(await head()).toBe(before);
  });

  it('throws WorktreeSetupError (not a generic throw) when the branch is unusable', async () => {
    // A branch already checked out in the main worktree cannot be checked out again.
    await expect(
      withAutoFixWorktree('main', async () => 'unreachable', { repoRoot, baseDir }),
    ).rejects.toBeInstanceOf(WorktreeSetupError);
    expect(await head()).toBe('main');
  });
});

describe('pruneAutoFixWorktrees', () => {
  it('reclaims an abandoned worktree older than the stale window', async () => {
    // Simulate a crash: create the worktree and leave it registered.
    const dir = path.join(baseDir, `${WORKTREE_PREFIX}999-abandoned`);
    await fs.mkdir(baseDir, { recursive: true });
    await sh(`git worktree add "${dir}" -b auto-fix/999-crashed`, { cwd: repoRoot });
    // Age it past the 60-minute stale window.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await fs.utimes(dir, old, old);

    const removed = await pruneAutoFixWorktrees({ repoRoot, baseDir });

    expect(removed).toBe(1);
    await expect(fs.stat(dir)).rejects.toThrow();
    const { stdout: list } = await sh('git worktree list', { cwd: repoRoot });
    expect(list).not.toContain(WORKTREE_PREFIX);
  });

  it('leaves a fresh worktree (a concurrent run) alone', async () => {
    const dir = path.join(baseDir, `${WORKTREE_PREFIX}998-live`);
    await fs.mkdir(baseDir, { recursive: true });
    await sh(`git worktree add "${dir}" -b auto-fix/998-live`, { cwd: repoRoot });

    const removed = await pruneAutoFixWorktrees({ repoRoot, baseDir });

    expect(removed).toBe(0);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    await sh(`git worktree remove "${dir}" --force`, { cwd: repoRoot });
  });

  it('is a no-op when the base dir does not exist', async () => {
    await expect(
      pruneAutoFixWorktrees({ repoRoot, baseDir: path.join(baseDir, 'nope') }),
    ).resolves.toBe(0);
  });
});

describe('AutoFixTrigger call site', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../src/core/tools/builtin/dev/github-integration.js');
  });

  it('opens the PR from inside the worktree and never checks out in the main tree', async () => {
    const prCalls: Array<{ branch: string; cwd?: string }> = [];
    vi.doMock('../../src/core/tools/builtin/dev/github-integration.js', () => ({
      createPR: async (pr: { branch: string; cwd?: string }) => {
        prCalls.push({ branch: pr.branch, cwd: pr.cwd });
        // The PR must be created from a live worktree checked out on the branch.
        const { stdout } = await sh('git rev-parse --abbrev-ref HEAD', { cwd: pr.cwd });
        expect(stdout.trim()).toBe(pr.branch);
        return 'https://github.com/o/r/pull/4242';
      },
      getRepoInfo: async () => null,
      createBranch: async () => {
        throw new Error('createBranch must not be used by the unattended flow');
      },
    }));

    const { AutoFixTrigger } = await import('../../src/core/self-build/auto-fix-trigger.js');
    const trigger = new AutoFixTrigger({
      errorMemory: { suggestFix: () => 'apply the known patch' } as never,
      metricsCollector: { increment: () => {}, gauge: () => {} },
      worktreeOptions: { repoRoot, baseDir },
    });

    const before = await head();
    const issue = {
      number: 77,
      title: 'Null deref in loop',
      body: 'CRITICAL failure at src/core/agent/loop.ts:10',
      labels: [{ name: 'auto-fix' }],
      state: 'open',
      createdAt: '',
      updatedAt: '',
    };

    const res = await (
      trigger as unknown as {
        _triggerFix: (
          i: unknown,
          s: string,
          e: string,
          p: string,
          f: string,
        ) => Promise<{ success: boolean; reason?: string }>;
      }
    )._triggerFix(issue, 'CRITICAL', 'TypeError: x', 'src/core/agent/loop.ts', 'patch');

    expect(res.success).toBe(true);
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0].branch).toBe('auto-fix/77-null-deref-in-loop');
    expect(prCalls[0].cwd).toContain(WORKTREE_PREFIX);
    // THE bug: the shared checkout's HEAD is unchanged across the whole flow.
    expect(await head()).toBe(before);
    await expect(fs.stat(prCalls[0].cwd!)).rejects.toThrow();
  });
});
