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
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import {
  withAutoFixWorktree,
  pruneAutoFixWorktrees,
  acquireLaneLock,
  WorktreeSetupError,
  WorktreeBusyError,
  WORKTREE_PREFIX,
  LANE_LOCK_NAME,
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

const liveChildren: Array<{ kill(): void }> = [];

/** A REAL live process, so liveness checks are not mocked into agreeing. */
function spawnLiveProcess(): number {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  liveChildren.push(child);
  return child.pid!;
}

/** A REAL pid that has exited — the "owner died" case. */
async function spawnDeadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((r) => child.on('exit', () => r()));
  // The pid is reaped by the time 'exit' fires; kill(pid, 0) now throws ESRCH.
  return pid;
}

async function writeOwnerSidecar(target: string, pid: number, startedAt = Date.now()): Promise<void> {
  await fs.writeFile(target, JSON.stringify({ pid, host: os.hostname(), startedAt }), 'utf8');
}

afterEach(async () => {
  for (const child of liveChildren.splice(0)) child.kill();
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
  it('reclaims an abandoned worktree with no owner, older than the stale window', async () => {
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

  it('MEASURED BUG: keeps a LIVE run\'s worktree even when it is older than the stale window', async () => {
    // The old guard compared directory mtime to a 60-minute window, so a slow or
    // hung run (mtime does not advance while it waits on `gh`) had its worktree
    // deleted out from under it by the next tick. Liveness, not age, decides.
    const dir = path.join(baseDir, `${WORKTREE_PREFIX}997-slow`);
    await fs.mkdir(baseDir, { recursive: true });
    await sh(`git worktree add "${dir}" -b auto-fix/997-slow`, { cwd: repoRoot });
    await writeOwnerSidecar(`${dir}.owner.json`, spawnLiveProcess());
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await fs.utimes(dir, old, old);

    const removed = await pruneAutoFixWorktrees({ repoRoot, baseDir });

    expect(removed).toBe(0);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    await sh(`git worktree remove "${dir}" --force`, { cwd: repoRoot });
  });

  it('reclaims a fresh worktree whose owner process is dead (no waiting for a timeout)', async () => {
    const dir = path.join(baseDir, `${WORKTREE_PREFIX}996-crashed`);
    await fs.mkdir(baseDir, { recursive: true });
    await sh(`git worktree add "${dir}" -b auto-fix/996-crashed`, { cwd: repoRoot });
    await writeOwnerSidecar(`${dir}.owner.json`, await spawnDeadPid());

    const removed = await pruneAutoFixWorktrees({ repoRoot, baseDir });

    expect(removed).toBe(1);
    await expect(fs.stat(dir)).rejects.toThrow();
    await expect(fs.stat(`${dir}.owner.json`)).rejects.toThrow();
    const { stdout: list } = await sh('git worktree list', { cwd: repoRoot });
    expect(list).not.toContain(WORKTREE_PREFIX);
  });

  it('is a no-op when the base dir does not exist', async () => {
    await expect(
      pruneAutoFixWorktrees({ repoRoot, baseDir: path.join(baseDir, 'nope') }),
    ).resolves.toBe(0);
  });
});

describe('lane lock (overlapping cron ticks)', () => {
  it('refuses a genuinely concurrent second run while the first is inside its body', async () => {
    let inside = 0;
    let maxConcurrent = 0;
    let firstEntered!: () => void;
    const entered = new Promise<void>((r) => (firstEntered = r));
    let releaseFirst!: () => void;
    const hold = new Promise<void>((r) => (releaseFirst = r));

    const body = async () => {
      inside++;
      maxConcurrent = Math.max(maxConcurrent, inside);
      firstEntered();
      await hold;
      inside--;
      return 'ok';
    };

    const first = withAutoFixWorktree('auto-fix/20-first', body, { repoRoot, baseDir });
    await entered;

    // Second tick fires while the first is demonstrably still running.
    await expect(
      withAutoFixWorktree('auto-fix/21-second', body, { repoRoot, baseDir }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);

    releaseFirst();
    await expect(first).resolves.toBe('ok');
    expect(maxConcurrent).toBe(1);

    // Exactly one worktree ever existed, and it is gone now.
    const left = (await fs.readdir(baseDir)).filter((e) => e.startsWith(WORKTREE_PREFIX));
    expect(left).toEqual([]);
  });

  it('races two invocations: exactly one wins, the loser is WorktreeBusyError', async () => {
    const started: string[] = [];
    const run = (n: number) =>
      withAutoFixWorktree(
        `auto-fix/3${n}-race`,
        async () => {
          started.push(`r${n}`);
          await new Promise((r) => setTimeout(r, 150));
          return n;
        },
        { repoRoot, baseDir },
      );

    const results = await Promise.allSettled([run(1), run(2)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorktreeBusyError);
    expect(started).toHaveLength(1);
  });

  it('a lock held by a LIVE foreign process blocks', async () => {
    const lockDir = path.join(baseDir, LANE_LOCK_NAME);
    await fs.mkdir(lockDir, { recursive: true });
    await writeOwnerSidecar(path.join(lockDir, 'owner.json'), spawnLiveProcess());

    await expect(acquireLaneLock(baseDir)).rejects.toBeInstanceOf(WorktreeBusyError);
    await expect(
      withAutoFixWorktree('auto-fix/40-blocked', async () => 'nope', { repoRoot, baseDir }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);
  });

  it('a lock held by a DEAD process does not wedge the lane', async () => {
    const lockDir = path.join(baseDir, LANE_LOCK_NAME);
    await fs.mkdir(lockDir, { recursive: true });
    await writeOwnerSidecar(path.join(lockDir, 'owner.json'), await spawnDeadPid());

    const out = await withAutoFixWorktree('auto-fix/41-after-crash', async () => 'recovered', {
      repoRoot,
      baseDir,
    });
    expect(out).toBe('recovered');
    await expect(fs.stat(lockDir)).rejects.toThrow(); // released, not leaked
  });

  it('releases the lock when the body throws, so the next tick can run', async () => {
    await expect(
      withAutoFixWorktree('auto-fix/42-boom', async () => {
        throw new Error('kaboom');
      }, { repoRoot, baseDir }),
    ).rejects.toThrow(/kaboom/);

    const out = await withAutoFixWorktree('auto-fix/43-next', async () => 'next ran', {
      repoRoot,
      baseDir,
    });
    expect(out).toBe('next ran');
  });

  it('holds across REAL processes: a live child blocks, and SIGKILLing it unwedges the lane', async () => {
    // Two OS processes, not two promises: the lock must live on the filesystem.
    const require_ = createRequire(import.meta.url);
    // `--import tsx` keeps the lock owner in THIS child pid; `tsx <file>` would
    // fork a grandchild and the recorded pid would survive killing the wrapper.
    const tsxEntry = require_.resolve('tsx');
    const moduleUrl = new URL('../../src/core/self-build/git-worktree.ts', import.meta.url).href;
    const script = path.join(path.dirname(repoRoot), 'holder.mts');
    await fs.writeFile(
      script,
      `const { acquireLaneLock } = await import(${JSON.stringify(moduleUrl)});\n` +
        `await acquireLaneLock(process.argv[2]);\n` +
        `process.stdout.write('ACQUIRED\\n');\n` +
        `await new Promise(() => {});\n`,
      'utf8',
    );

    const child = spawn(process.execPath, ['--import', pathToFileURL(tsxEntry).href, script, baseDir], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    liveChildren.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child never acquired the lock')), 30_000);
      child.stdout.on('data', (b: Buffer) => {
        if (b.toString().includes('ACQUIRED')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`holder exited early: ${code}`)));
    });

    // Live holder in another process -> this process must NOT get the lane.
    await expect(
      withAutoFixWorktree('auto-fix/50-cross-process', async () => 'nope', { repoRoot, baseDir }),
    ).rejects.toBeInstanceOf(WorktreeBusyError);

    // SIGKILL: no release() runs, the lock file stays behind with a dead pid.
    child.removeAllListeners('exit');
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    child.kill('SIGKILL');
    await exited;
    expect((await fs.stat(path.join(baseDir, LANE_LOCK_NAME))).isDirectory()).toBe(true);

    await expect(
      withAutoFixWorktree('auto-fix/51-after-kill', async () => 'unwedged', { repoRoot, baseDir }),
    ).resolves.toBe('unwedged');
  }, 60_000);

  it('releases the lock when worktree SETUP fails', async () => {
    await expect(
      withAutoFixWorktree('main', async () => 'unreachable', { repoRoot, baseDir }),
    ).rejects.toBeInstanceOf(WorktreeSetupError);
    await expect(fs.stat(path.join(baseDir, LANE_LOCK_NAME))).rejects.toThrow();
    await expect(
      withAutoFixWorktree('auto-fix/44-after-setup-failure', async () => 'ok', { repoRoot, baseDir }),
    ).resolves.toBe('ok');
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
