/**
 * @file worktree-manager.ts
 * @description Manages git worktree-based session isolation for SUDO-AI sub-agents.
 *
 * Each session that needs worktree isolation gets its own directory under
 * `.claude/worktrees/` with a dedicated git branch. This provides full git
 * history, isolated file changes, and the ability to merge or discard changes
 * independently per session.
 *
 * Usage:
 *   const mgr = new WorktreeManager(repoRoot);
 *   const info = await mgr.createWorktree('session-abc');
 *   // ... sub-agent uses info.path as cwd ...
 *   await mgr.removeWorktree('session-abc');
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('agent:worktree-manager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata tracked for each managed worktree. */
export interface WorktreeInfo {
  /** Session identifier that owns this worktree. */
  sessionId: string;
  /** Absolute filesystem path to the worktree directory. */
  path: string;
  /** Git branch name checked out in this worktree. */
  branch: string;
  /** ISO-8601 timestamp when this worktree was created. */
  createdAt: string;
  /** True if this represents the main worktree (the original repo checkout). */
  isMainWorktree: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a git command synchronously, returning trimmed stdout.
 * Throws on non-zero exit code.
 */
function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Execute a git command synchronously, returning trimmed stdout or empty
 * string on failure (never throws).
 */
function gitTry(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/**
 * Detect whether the given directory is inside a git repository.
 */
function isInsideGitRepo(dir: string): boolean {
  return gitTry('git rev-parse --is-inside-work-tree', dir) === 'true';
}

/**
 * Resolve the git repository root for a given directory.
 * Returns empty string if not inside a git repo.
 */
function gitRepoRoot(dir: string): string {
  return gitTry('git rev-parse --show-toplevel', dir);
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

/** Default directory name under the repo root where worktrees are stored. */
const WORKTREES_DIR = '.claude/worktrees';

/** Maximum age in milliseconds before a worktree is considered stale for pruning. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Manages git worktree lifecycle for SUDO-AI sessions.
 *
 * Worktrees are stored under `<repoRoot>/.claude/worktrees/<sessionId>/`.
 * Each worktree gets a dedicated branch named `wt/<sessionId>` (or a
 * caller-supplied branch name). The manager tracks metadata in memory
 * and provides pruning of stale entries.
 */
export class WorktreeManager {
  /** Absolute path to the git repository root. */
  private readonly repoRoot: string;

  /** Absolute path to the worktrees base directory. */
  private readonly worktreesDir: string;

  /** In-memory registry of active worktrees, keyed by sessionId. */
  private readonly registry: Map<string, WorktreeInfo> = new Map();

  constructor(repoRoot?: string) {
    const resolved = repoRoot ?? process.cwd();

    if (!isInsideGitRepo(resolved)) {
      throw new Error(
        `WorktreeManager: "${resolved}" is not inside a git repository. ` +
        'Worktree isolation requires a git repo.',
      );
    }

    this.repoRoot = gitRepoRoot(resolved) || resolved;
    this.worktreesDir = join(this.repoRoot, WORKTREES_DIR);

    // Ensure the worktrees directory exists.
    if (!existsSync(this.worktreesDir)) {
      mkdirSync(this.worktreesDir, { recursive: true });
    }

    log.debug({ repoRoot: this.repoRoot, worktreesDir: this.worktreesDir }, 'WorktreeManager initialized');
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Create a new worktree for the given session.
   *
   * @param sessionId  - Unique session identifier.
   * @param branchName - Optional branch name. Defaults to `wt/<sessionId>`.
   * @returns WorktreeInfo for the newly created worktree.
   * @throws Error if a worktree already exists for this session, or if git
   *         commands fail.
   */
  createWorktree(sessionId: string, branchName?: string): WorktreeInfo {
    if (this.registry.has(sessionId)) {
      throw new Error(`WorktreeManager: worktree already exists for session "${sessionId}"`);
    }

    const branch = branchName ?? `wt/${sessionId}`;
    const worktreePath = join(this.worktreesDir, sessionId);

    // Prevent overwriting an existing directory on disk that we don't track.
    if (existsSync(worktreePath)) {
      // If it's a leftover from a previous process, try to prune it first.
      gitTry(`git worktree remove --force ${worktreePath}`, this.repoRoot);
      gitTry(`git branch -D ${branch}`, this.repoRoot);
      try {
        if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    // Ensure the parent directory exists.
    if (!existsSync(this.worktreesDir)) {
      mkdirSync(this.worktreesDir, { recursive: true });
    }

    // Create the git worktree with a new branch from HEAD.
    try {
      gitExec(`git worktree add -b ${branch} ${worktreePath} HEAD`, this.repoRoot);
    } catch (err) {
      throw new Error(
        `WorktreeManager: failed to create worktree for session "${sessionId}": ${String(err)}`,
      );
    }

    const info: WorktreeInfo = {
      sessionId,
      path: worktreePath,
      branch,
      createdAt: new Date().toISOString(),
      isMainWorktree: false,
    };

    this.registry.set(sessionId, info);
    log.info({ sessionId, branch, path: worktreePath }, 'Worktree created');

    return info;
  }

  /**
   * Remove the worktree associated with the given session.
   *
   * Removes the git worktree, deletes the branch, and clears the registry entry.
   * Idempotent -- no error if the session has no worktree.
   *
   * @param sessionId - Session identifier whose worktree to remove.
   */
  removeWorktree(sessionId: string): void {
    const info = this.registry.get(sessionId);
    if (!info) {
      log.debug({ sessionId }, 'removeWorktree: no worktree found (no-op)');
      return;
    }

    // Remove the git worktree (force to handle uncommitted changes).
    const rmResult = gitTry(`git worktree remove --force ${info.path}`, this.repoRoot);
    if (rmResult === '' && existsSync(info.path)) {
      // git worktree remove may silently fail -- fall back to rmSync.
      try {
        rmSync(info.path, { recursive: true, force: true });
      } catch (err) {
        log.warn({ sessionId, path: info.path, err: String(err) }, 'Failed to remove worktree directory');
      }
    }

    // Delete the branch (best-effort -- may already be gone after worktree removal).
    gitTry(`git branch -D ${info.branch}`, this.repoRoot);

    this.registry.delete(sessionId);
    log.info({ sessionId, branch: info.branch, path: info.path }, 'Worktree removed');
  }

  /**
   * Get the worktree filesystem path for the given session.
   *
   * @param sessionId - Session identifier.
   * @returns Absolute path to the worktree, or empty string if no worktree exists.
   */
  getWorktreePath(sessionId: string): string {
    const info = this.registry.get(sessionId);
    return info?.path ?? '';
  }

  /**
   * Check whether a given session has an active worktree.
   *
   * @param sessionId - Session identifier.
   * @returns True if a worktree exists for this session.
   */
  isWorktreeSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /**
   * List all currently tracked worktrees.
   *
   * @returns Array of WorktreeInfo objects for all active worktrees.
   */
  listWorktrees(): WorktreeInfo[] {
    return Array.from(this.registry.values());
  }

  /**
   * Prune stale worktrees that exceed the age threshold.
   *
   * A worktree is considered stale if its `createdAt` timestamp is older than
   * STALE_THRESHOLD_MS (24 hours). Stale worktrees are removed automatically.
   *
   * @param maxAgeMs - Optional override for the stale threshold in milliseconds.
   * @returns Array of session IDs that were pruned.
   */
  pruneStale(maxAgeMs?: number): string[] {
    const threshold = maxAgeMs ?? STALE_THRESHOLD_MS;
    const now = Date.now();
    const pruned: string[] = [];

    for (const [sessionId, info] of this.registry) {
      const ageMs = now - new Date(info.createdAt).getTime();
      if (ageMs > threshold) {
        log.info({ sessionId, ageMs, threshold }, 'Pruning stale worktree');
        this.removeWorktree(sessionId);
        pruned.push(sessionId);
      }
    }

    // Also scan the worktrees directory for orphaned directories not in the registry.
    if (existsSync(this.worktreesDir)) {
      try {
        const entries = readdirSync(this.worktreesDir);
        for (const entry of entries) {
          const entryPath = join(this.worktreesDir, entry);
          try {
            const stat = statSync(entryPath);
            if (!stat.isDirectory()) continue;

            const ageMs = now - stat.mtimeMs;
            if (ageMs > threshold && !this.registry.has(entry)) {
              // Orphaned directory -- remove it and the associated worktree/branch.
              gitTry(`git worktree remove --force ${entryPath}`, this.repoRoot);
              gitTry(`git branch -D wt/${entry}`, this.repoRoot);
              try {
                if (existsSync(entryPath)) rmSync(entryPath, { recursive: true, force: true });
              } catch { /* best effort */ }
              log.info({ sessionId: entry, path: entryPath }, 'Pruned orphaned worktree directory');
              pruned.push(entry);
            }
          } catch { /* skip entries we can't stat */ }
        }
      } catch (err) {
        log.warn({ err: String(err) }, 'Failed to scan worktrees directory during pruning');
      }
    }

    return pruned;
  }
}