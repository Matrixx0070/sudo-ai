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
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createLogger } from '../shared/logger.js';

const log = createLogger('self-build:git-worktree');
/**
 * argv-array exec — NO shell. Every git invocation below passes user-influenced
 * values (branch names derived from GitHub issue titles, worktree directory names
 * read off disk with `readdir`) as separate argv entries, so shell metacharacters
 * are inert data rather than syntax. This runs unattended on a half-hourly cron;
 * it must not depend on a sanitiser regex staying correct forever.
 */
const execFileAsync = promisify(execFile);

/** Directory-name prefix identifying worktrees this module owns. */
export const WORKTREE_PREFIX = 'sudo-autofix-';

/** Abandoned worktrees older than this are reclaimed before a new one is made. */
const STALE_AFTER_MS = 60 * 60 * 1000;

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

/** Same rules as the github-integration branch sanitizer. */
function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-/]/g, '-').replace(/^[-./]+/, '');
}

function defaultBaseDir(): string {
  return path.join(os.tmpdir(), 'sudo-ai-autofix-worktrees');
}

async function resolveRepoRoot(opts?: WorktreeOptions): Promise<string> {
  if (opts?.repoRoot) return opts.repoRoot;
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

/**
 * Reclaim worktrees left behind by a crash: drop git's stale registrations and
 * delete any of OUR directories that are older than {@link STALE_AFTER_MS}.
 * Age-guarded so a concurrent run's live worktree is never pulled out from under it.
 *
 * @returns number of directories removed.
 */
export async function pruneAutoFixWorktrees(opts?: WorktreeOptions): Promise<number> {
  const repoRoot = await resolveRepoRoot(opts);
  const baseDir = opts?.baseDir ?? defaultBaseDir();

  try {
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot });
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
    if (!entry.startsWith(WORKTREE_PREFIX)) continue;
    const dir = path.join(baseDir, entry);
    try {
      const st = await fs.stat(dir);
      if (now - st.mtimeMs < STALE_AFTER_MS) continue;
    } catch {
      continue;
    }
    await removeWorktree(repoRoot, dir);
    removed++;
  }

  if (removed > 0) log.info({ removed, baseDir }, 'prune: reclaimed stale auto-fix worktrees');
  return removed;
}

/** Best-effort teardown: `git worktree remove --force`, then rm -rf, then prune. */
async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', dir, '--force'], { cwd: repoRoot });
  } catch (err) {
    log.warn({ dir, err: (err as Error).message }, 'worktree remove failed — forcing rm');
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => undefined);
}

/**
 * Run `fn` inside a freshly created linked worktree on `branch`, and remove the
 * worktree unconditionally afterwards (including when `fn` throws).
 *
 * The main checkout's HEAD is never touched.
 *
 * @throws {WorktreeSetupError} if the worktree could not be created.
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

  // Disk is not free: reclaim abandoned worktrees before adding another.
  await pruneAutoFixWorktrees({ repoRoot, baseDir }).catch(() => 0);
  await fs.mkdir(baseDir, { recursive: true });

  const dir = path.join(
    baseDir,
    `${WORKTREE_PREFIX}${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    await execFileAsync('git', ['worktree', 'add', dir, '-b', safeBranch], { cwd: repoRoot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Branch names are semantic (`auto-fix/<issue>-<slug>`), so a retry of the
    // same fix collides. Re-use the existing branch instead of dead-ending.
    if (/already exists/i.test(message)) {
      try {
        await execFileAsync('git', ['worktree', 'add', dir, safeBranch], { cwd: repoRoot });
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

  log.info({ dir, branch: safeBranch }, 'worktree created');

  try {
    return await fn({ dir, branch: safeBranch });
  } finally {
    await removeWorktree(repoRoot, dir);
    log.info({ dir, branch: safeBranch }, 'worktree removed');
  }
}
