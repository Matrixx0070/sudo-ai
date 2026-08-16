/**
 * @file git-worktree.ts
 * @description Isolated git worktrees for the unattended auto-fix flow.
 *
 * The autonomous self-build path used to call `createBranch()`, which runs
 * `git checkout -b <name>` in the SHARED working tree. `system.self-build` runs
 * on a half-hourly cron, so that switched branches underneath whatever a human (or
 * another session) was doing — observed live: a branch switch 48s into a 145s
 * test run corrupted it, and an earlier auto-fix checkout destroyed an
 * in-progress merge.
 *
 * Unattended work therefore gets its own linked worktree:
 *
 *   git worktree add <dir> -b auto-fix/<n>-<slug>
 *   ...work, commit, push FROM <dir>...
 *   git worktree remove <dir> --force        (always, in a finally)
 *
 * `git worktree add` never moves the main checkout's HEAD, which is the whole
 * point. In-place checkout stays legitimate for the interactive `createBranch`
 * tool — only the background job is wrong to use it.
 *
 * ## Concurrency
 *
 * The cron can overlap itself (a slow tick is still inside `gh pr create` when
 * the next one fires), so the lane is serialised by a **lockfile**, not by a
 * check-then-act heuristic:
 *
 * - acquire: `mkdir <baseDir>/.autofix-lane.lock` — atomic, exactly one winner;
 *   the loser gets {@link WorktreeBusyError} and skips its tick.
 * - liveness: the lock records `{pid, host}`. A lock whose owner process is gone
 *   is reclaimed (atomic `rename`-then-delete, so only one reaper wins), so a
 *   crashed run cannot wedge the lane forever.
 * - prune: reclaims a worktree only when its recorded owner is **dead**. The
 *   previous version compared directory mtime against a 60-minute window, which
 *   measured elapsed time rather than liveness and deleted a still-running
 *   run's worktree out from under it (measured — see tests).
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createLogger } from '../shared/logger.js';

const log = createLogger('self-build:git-worktree');
const execAsync = promisify(exec);

/** Directory-name prefix identifying worktrees this module owns. */
export const WORKTREE_PREFIX = 'sudo-autofix-';

/** Sidecar suffix recording who owns a worktree (kept OUTSIDE the worktree). */
const OWNER_SUFFIX = '.owner.json';

/** Lane lock directory name, inside `baseDir`. */
export const LANE_LOCK_NAME = '.autofix-lane.lock';

/**
 * Fallback staleness window, used only where liveness is unknowable: a worktree
 * with no owner sidecar (pre-upgrade leftover, or a crash between `worktree add`
 * and the sidecar write) and a lock owned by a *different host*.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

/** Grace for the mkdir -> write-owner window before a meta-less lock looks dead. */
const LOCK_META_GRACE_MS = 30 * 1000;

interface OwnerInfo {
  pid: number;
  host: string;
  startedAt: number;
}

export interface WorktreeSession {
  /** Absolute path of the linked worktree. Run all git/gh commands with this cwd. */
  dir: string;
  /** Branch checked out in the worktree. */
  branch: string;
}

export interface WorktreeOptions {
  /** Repository root to link from. Defaults to `git rev-parse --show-toplevel`. */
  repoRoot?: string;
  /** Parent directory holding worktrees. Defaults to a dir under the OS temp dir. */
  baseDir?: string;
}

/** Raised when the worktree could not be created; never when the body throws. */
export class WorktreeSetupError extends Error {
  override readonly name = 'WorktreeSetupError';
}

/** Raised when another live run already holds the auto-fix lane. */
export class WorktreeBusyError extends Error {
  override readonly name = 'WorktreeBusyError';
}

// ---------------------------------------------------------------------------
// Ownership / liveness
// ---------------------------------------------------------------------------

function selfOwner(): OwnerInfo {
  return { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
}

async function writeOwner(file: string, owner: OwnerInfo): Promise<void> {
  await fs.writeFile(file, JSON.stringify(owner), 'utf8');
}

async function readOwner(file: string): Promise<OwnerInfo | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<OwnerInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') return null;
    return { pid: parsed.pid, host: parsed.host, startedAt: Number(parsed.startedAt) || 0 };
  } catch {
    return null;
  }
}

/**
 * Is the process that recorded `owner` still running?
 *
 * `process.kill(pid, 0)` sends no signal — it only asks the kernel whether the
 * pid exists. `EPERM` means it exists but belongs to another user (alive).
 * Owners on another host are unjudgeable, so they are treated as alive until the
 * fallback staleness window passes — never deadlocking the lane forever.
 */
export function isOwnerAlive(owner: OwnerInfo | null, now = Date.now()): boolean {
  if (!owner) return false;
  if (owner.host !== os.hostname()) return now - owner.startedAt < STALE_AFTER_MS;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Lane lock
// ---------------------------------------------------------------------------

export interface LaneLock {
  /** Absolute path of the lock directory. */
  dir: string;
  /** Release the lock. Safe to call twice; never removes someone else's lock. */
  release(): Promise<void>;
}

/** Atomically claim the right to delete a lock we judged dead. */
async function reapDeadLock(lockDir: string): Promise<void> {
  const reap = `${lockDir}.reap-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    // rename() is atomic: if two reapers race, only one moves the directory and
    // the loser gets ENOENT — so a lock is never deleted twice.
    await fs.rename(lockDir, reap);
  } catch {
    return;
  }
  await fs.rm(reap, { recursive: true, force: true }).catch(() => undefined);
  log.warn({ lockDir }, 'lane lock: reclaimed a lock whose owner process is gone');
}

/**
 * Serialise the unattended auto-fix lane.
 *
 * `mkdir` is the atomic primitive: it either creates the directory or fails with
 * `EEXIST`, with no check-then-act window. A lock held by a live process makes
 * this throw {@link WorktreeBusyError}; a lock held by a dead process is
 * reclaimed and acquisition retried.
 */
export async function acquireLaneLock(baseDir: string): Promise<LaneLock> {
  await fs.mkdir(baseDir, { recursive: true });
  const lockDir = path.join(baseDir, LANE_LOCK_NAME);
  const ownerFile = path.join(lockDir, 'owner.json');
  const mine = selfOwner();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.mkdir(lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = await readOwner(ownerFile);
      if (holder === null) {
        // No metadata yet: either the winner has not written it (grace window)
        // or it died in between. Do not steal a lock that may be seconds old.
        const age = await fs
          .stat(lockDir)
          .then((st) => Date.now() - st.mtimeMs)
          .catch(() => Number.POSITIVE_INFINITY);
        if (age < LOCK_META_GRACE_MS) {
          throw new WorktreeBusyError('auto-fix lane is locked by a run that just started');
        }
      } else if (isOwnerAlive(holder)) {
        throw new WorktreeBusyError(
          `auto-fix lane is locked by pid ${holder.pid} on ${holder.host} — skipping this run`,
        );
      }
      await reapDeadLock(lockDir);
      continue;
    }

    await writeOwner(ownerFile, mine);
    let released = false;
    return {
      dir: lockDir,
      release: async () => {
        if (released) return;
        released = true;
        const holder = await readOwner(ownerFile);
        if (holder && holder.pid === mine.pid && holder.startedAt === mine.startedAt) {
          await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  }

  throw new WorktreeBusyError('auto-fix lane lock is contended — skipping this run');
}

/** Same rules as the github-integration branch sanitizer. */
function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-/]/g, '-').replace(/^[-./]+/, '');
}

function defaultBaseDir(): string {
  return path.join(os.tmpdir(), 'sudo-ai-autofix-worktrees');
}

async function resolveRepoRoot(opts?: WorktreeOptions): Promise<string> {
  if (opts?.repoRoot) return opts.repoRoot;
  const { stdout } = await execAsync('git rev-parse --show-toplevel');
  return stdout.trim();
}

/**
 * Reclaim worktrees left behind by a crash: drop git's stale registrations and
 * delete any of OUR directories whose **owner process is dead**.
 *
 * Liveness, not age: the previous version deleted anything older than an hour,
 * which pulled a still-running (slow or hung) run's worktree out from under it.
 * A worktree with no owner sidecar cannot be judged, so it falls back to the
 * {@link STALE_AFTER_MS} window — that only covers pre-upgrade leftovers and a
 * crash inside the `worktree add` → sidecar-write window.
 *
 * @returns number of directories removed.
 */
export async function pruneAutoFixWorktrees(opts?: WorktreeOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(opts);
  const baseDir = opts?.baseDir ?? defaultBaseDir();

  try {
    await execAsync('git worktree prune', { cwd: repoRoot });
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'prune: `git worktree prune` failed');
  }

  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return 0; // base dir does not exist yet — nothing to reclaim
  }

  let removed = 0;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(WORKTREE_PREFIX) || entry.endsWith(OWNER_SUFFIX)) continue;
    const dir = path.join(baseDir, entry);
    const owner = await readOwner(dir + OWNER_SUFFIX);

    if (owner) {
      if (isOwnerAlive(owner, now)) continue; // a live run — never touch it
    } else {
      // Unknown owner: fall back to the age window rather than guessing.
      try {
        const st = await fs.stat(dir);
        if (now - st.mtimeMs < STALE_AFTER_MS) continue;
      } catch {
        continue;
      }
    }

    await removeWorktree(repoRoot, dir);
    removed++;
  }

  if (removed > 0) log.info({ removed, baseDir }, 'prune: reclaimed abandoned auto-fix worktrees');
  return removed;
}

/** Best-effort teardown: `git worktree remove --force`, then rm -rf, then prune. */
async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  try {
    await execAsync(`git worktree remove "${dir}" --force`, { cwd: repoRoot });
  } catch (err) {
    log.warn({ dir, err: (err as Error).message }, 'worktree remove failed — forcing rm');
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(dir + OWNER_SUFFIX, { force: true }).catch(() => undefined);
  await execAsync('git worktree prune', { cwd: repoRoot }).catch(() => undefined);
}

/**
 * Run `fn` inside a freshly created linked worktree on `branch`, and remove the
 * worktree unconditionally afterwards (including when `fn` throws).
 *
 * The main checkout's HEAD is never touched. The auto-fix lane is serialised by
 * {@link acquireLaneLock}, so an overlapping cron tick skips instead of racing.
 *
 * @throws {WorktreeSetupError} if the worktree could not be created.
 * @throws {WorktreeBusyError} if another live run holds the lane.
 */
export async function withAutoFixWorktree<T>(
  branch: string,
  fn: (session: WorktreeSession) => Promise<T>,
  opts?: WorktreeOptions,
): Promise<T> {
  const safeBranch = sanitizeBranchName(branch);
  if (!safeBranch) throw new WorktreeSetupError('branch name contained only invalid characters');

  const repoRoot = await resolveRepoRoot(opts);
  const baseDir = opts?.baseDir ?? defaultBaseDir();

  // One unattended run at a time. Throws WorktreeBusyError if a live run holds it.
  const lock = await acquireLaneLock(baseDir);
  try {
    return await runInWorktree(repoRoot, baseDir, safeBranch, fn);
  } finally {
    await lock.release();
  }
}

async function runInWorktree<T>(
  repoRoot: string,
  baseDir: string,
  safeBranch: string,
  fn: (session: WorktreeSession) => Promise<T>,
): Promise<T> {
  // Disk is not free: reclaim abandoned worktrees before adding another.
  await pruneAutoFixWorktrees({ repoRoot, baseDir }).catch(() => 0);

  const dir = path.join(
    baseDir,
    `${WORKTREE_PREFIX}${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
  );

  try {
    await execAsync(`git worktree add "${dir}" -b ${safeBranch}`, { cwd: repoRoot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Branch names are semantic (`auto-fix/<issue>-<slug>`), so a retry of the
    // same fix collides. Re-use the existing branch instead of dead-ending.
    if (/already exists/i.test(message)) {
      try {
        await execAsync(`git worktree add "${dir}" ${safeBranch}`, { cwd: repoRoot });
      } catch (reuseErr) {
        const reuseMsg = reuseErr instanceof Error ? reuseErr.message : String(reuseErr);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw new WorktreeSetupError(reuseMsg);
      }
    } else {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new WorktreeSetupError(message);
    }
  }

  // Sidecar (outside the worktree, so it never shows up in `git status`) telling
  // a future prune who owns this directory.
  await writeOwner(dir + OWNER_SUFFIX, selfOwner()).catch(() => undefined);
  log.info({ dir, branch: safeBranch }, 'worktree created');

  try {
    return await fn({ dir, branch: safeBranch });
  } finally {
    await removeWorktree(repoRoot, dir);
    log.info({ dir, branch: safeBranch }, 'worktree removed');
  }
}
