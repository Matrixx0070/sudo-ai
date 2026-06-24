/**
 * Upgrade 58: GitHub Integration
 *
 * Wrapper utilities around the `gh` CLI and `git` for common GitHub operations:
 * creating PRs, listing/creating branches, and reading repo metadata.
 *
 * Requires the `gh` CLI to be authenticated and `git` to be available on PATH.
 * All shell errors are caught and returned as error strings rather than thrown.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:github');
const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubPR {
  title: string;
  body: string;
  /** Source branch name */
  branch: string;
  /** Target branch (defaults to 'main') */
  base?: string;
}

export interface GitHubRepo {
  owner: string;
  repo: string;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip or escape shell-unsafe characters from a branch name. */
function sanitizeBranchName(name: string): string {
  // Git branch names must not contain spaces, tildes, carets, colons, etc.
  return name.replace(/[^a-zA-Z0-9._\-/]/g, '-').replace(/^[-./]+/, '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a pull request using the `gh` CLI.
 *
 * @returns The PR URL on success, or an error string prefixed with "ERROR:".
 */
export async function createPR(pr: GitHubPR): Promise<string> {
  if (!pr.title?.trim()) return 'ERROR: PR title is required';
  if (!pr.body?.trim()) return 'ERROR: PR body is required';
  if (!pr.branch?.trim()) return 'ERROR: PR branch is required';

  const base = pr.base?.trim() || 'main';
  const safeTitle = pr.title.replace(/"/g, '\\"');
  const safeBody = pr.body.replace(/"/g, '\\"');
  const safeBranch = sanitizeBranchName(pr.branch);

  log.info({ title: pr.title, branch: safeBranch, base }, 'Creating PR');

  try {
    const { stdout } = await execAsync(
      `gh pr create --title "${safeTitle}" --body "${safeBody}" --head "${safeBranch}" --base "${base}"`,
    );
    const url = stdout.trim();
    log.info({ url }, 'PR created');
    return url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ branch: safeBranch, error: message }, 'PR creation failed');
    return `ERROR: ${message}`;
  }
}

/**
 * Return all local branch names.
 */
export async function listBranches(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git branch --list --format="%(refname:short)"');
    const branches = stdout
      .trim()
      .split('\n')
      .map((b) => b.replace(/^"|"$/g, '').trim())
      .filter(Boolean);
    log.debug({ count: branches.length }, 'Listed branches');
    return branches;
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'listBranches failed');
    return [];
  }
}

/**
 * Create and check out a new local branch.
 *
 * @returns A success message or an error string prefixed with "ERROR:".
 */
export async function createBranch(name: string): Promise<string> {
  if (!name?.trim()) return 'ERROR: branch name is required';

  const safeName = sanitizeBranchName(name);
  if (!safeName) return 'ERROR: branch name contained only invalid characters';

  log.info({ name: safeName }, 'Creating branch');

  try {
    await execAsync(`git checkout -b ${safeName}`);
    log.info({ name: safeName }, 'Branch created');
    return `Branch ${safeName} created and checked out`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The branch may already exist — branch names here are semantic (e.g.
    // `auto-fix/<issue>-<slug>`), so a retry of the same fix collides. Failing
    // outright blocks the whole flow forever (observed live: 3× "fatal: a branch
    // named '...' already exists"). Recover by switching onto the existing branch
    // so the caller can continue and commit its changes on top.
    if (/already exists/i.test(message)) {
      try {
        await execAsync(`git checkout ${safeName}`);
        log.info({ name: safeName }, 'Branch already existed — checked out existing');
        return `Branch ${safeName} already existed; checked out existing branch`;
      } catch (coErr) {
        const coMsg = coErr instanceof Error ? coErr.message : String(coErr);
        log.error({ name: safeName, error: coMsg }, 'Existing-branch checkout failed');
        return `ERROR: ${coMsg}`;
      }
    }
    log.error({ name: safeName, error: message }, 'Branch creation failed');
    return `ERROR: ${message}`;
  }
}

/**
 * Retrieve owner, repo name, and default branch from the remote via `gh`.
 * Returns null if the working directory is not a GitHub repository or if
 * `gh` is not authenticated.
 */
export async function getRepoInfo(): Promise<GitHubRepo | null> {
  try {
    const { stdout } = await execAsync(
      'gh repo view --json owner,name,defaultBranchRef',
    );
    const data = JSON.parse(stdout) as {
      owner: { login: string };
      name: string;
      defaultBranchRef?: { name: string };
    };

    const info: GitHubRepo = {
      owner: data.owner.login,
      repo: data.name,
      branch: data.defaultBranchRef?.name,
    };

    log.debug({ owner: info.owner, repo: info.repo }, 'Repo info fetched');
    return info;
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'getRepoInfo failed — not a GitHub repo or gh not authenticated');
    return null;
  }
}
