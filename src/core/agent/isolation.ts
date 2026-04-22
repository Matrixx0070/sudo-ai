/**
 * @file isolation.ts
 * @description Agent workspace isolation for SUDO-AI sub-agents.
 *
 * Based on Claude Code's worktree isolation for parallel sub-agents.
 * Provides three isolation modes:
 *
 *   shared     — sub-agent shares the main process working directory (default)
 *   sandboxed  — sub-agent gets a fresh /tmp directory with restricted scope
 *   worktree   — sub-agent gets a dedicated git worktree branch (full git history,
 *                isolated file changes, merged or discarded on cleanup)
 *
 * Usage:
 *   const agent = await createIsolatedAgent('sandboxed');
 *   // ... run sub-agent using agent.workdir as its cwd ...
 *   await agent.cleanup();
 */

import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:isolation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Workspace isolation mode for a sub-agent.
 *
 * - shared    No isolation. Sub-agent uses process.cwd(). Fastest, no overhead.
 * - sandboxed Creates a fresh /tmp directory. Good for read-only or ephemeral work.
 * - worktree  Creates a git worktree branch. Full isolation with git history.
 *             Requires the current directory to be inside a git repository.
 */
export type IsolationMode = 'shared' | 'sandboxed' | 'worktree';

/** Handle returned by createIsolatedAgent. */
export interface IsolatedAgent {
  /** Unique identifier for this isolated environment. */
  id: string;
  /** Isolation mode used. */
  mode: IsolationMode;
  /** Absolute path the sub-agent should use as its working directory. */
  workdir: string;
  /**
   * Cleanup function — must be called after the sub-agent finishes.
   * Removes the sandbox directory or git worktree as appropriate.
   * Safe to call multiple times (idempotent).
   */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a shell command synchronously, capturing stdout.
 * Returns empty string on failure instead of throwing.
 *
 * @param cmd     - Shell command string.
 * @param cwd     - Working directory for the command.
 */
function tryExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    log.debug({ cmd, cwd, err: String(err) }, 'tryExec: command failed (non-fatal)');
    return '';
  }
}

/**
 * Detect whether the given directory is inside a git repository.
 *
 * @param dir - Directory to test.
 */
function isInsideGitRepo(dir: string): boolean {
  const out = tryExec('git rev-parse --is-inside-work-tree', dir);
  return out === 'true';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an isolated environment for a sub-agent.
 *
 * @param mode - Desired isolation level.
 * @returns An IsolatedAgent handle with workdir + cleanup().
 * @throws Error if 'worktree' mode is requested but the cwd is not a git repo.
 */
export async function createIsolatedAgent(mode: IsolationMode): Promise<IsolatedAgent> {
  if (!['shared', 'sandboxed', 'worktree'].includes(mode)) {
    throw new Error(`createIsolatedAgent: unknown mode "${mode}"`);
  }

  switch (mode) {
    case 'worktree': {
      return _createWorktreeAgent();
    }
    case 'sandboxed': {
      return _createSandboxedAgent();
    }
    default: {
      return _createSharedAgent();
    }
  }
}

// ---------------------------------------------------------------------------
// Mode implementations
// ---------------------------------------------------------------------------

function _createSharedAgent(): IsolatedAgent {
  const id = 'shared';
  const workdir = process.cwd();
  log.debug({ id, workdir }, 'Shared isolation agent created');

  return {
    id,
    mode: 'shared',
    workdir,
    cleanup: async () => {
      log.debug({ id }, 'Shared agent cleanup (no-op)');
    },
  };
}

function _createSandboxedAgent(): IsolatedAgent {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const id = `sandbox-${ts}-${rand}`;
  const workdir = `/tmp/sudo-sandbox-${id}`;

  if (!existsSync('/tmp')) {
    throw new Error('createIsolatedAgent: /tmp does not exist on this system');
  }

  try {
    mkdirSync(workdir, { recursive: true });
  } catch (err) {
    throw new Error(`createIsolatedAgent: failed to create sandbox dir ${workdir}: ${String(err)}`);
  }

  log.info({ id, workdir }, 'Sandboxed isolation agent created');

  let cleaned = false;
  return {
    id,
    mode: 'sandboxed',
    workdir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (existsSync(workdir)) {
          rmSync(workdir, { recursive: true, force: true });
          log.info({ id, workdir }, 'Sandbox directory removed');
        }
      } catch (err) {
        log.warn({ id, workdir, err: String(err) }, 'Sandbox cleanup failed — directory may remain');
      }
    },
  };
}

function _createWorktreeAgent(): IsolatedAgent {
  const cwd = process.cwd();

  if (!isInsideGitRepo(cwd)) {
    throw new Error(
      `createIsolatedAgent: 'worktree' mode requires the process to run inside a git repository. ` +
      `Current directory "${cwd}" is not tracked by git.`,
    );
  }

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const branch = `agent-${ts}-${rand}`;
  const workdir = `/tmp/sudo-agent-${branch}`;

  // Create the worktree — adds a new branch and checks it out in workdir.
  // We create the branch from HEAD so the sub-agent starts with a full copy.
  try {
    execSync(`git worktree add -b ${branch} ${workdir} HEAD`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`createIsolatedAgent: git worktree add failed: ${String(err)}`);
  }

  log.info({ branch, workdir }, 'Git worktree isolation agent created');

  let cleaned = false;
  return {
    id: branch,
    mode: 'worktree',
    workdir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        // Remove the worktree — this also deletes the directory.
        tryExec(`git worktree remove --force ${workdir}`, cwd);
        // Delete the branch (best-effort — it may already be gone).
        tryExec(`git branch -D ${branch}`, cwd);
        log.info({ branch, workdir }, 'Git worktree removed');
      } catch (err) {
        log.warn({ branch, workdir, err: String(err) }, 'Worktree cleanup failed — manual cleanup may be needed');
      }
    },
  };
}
