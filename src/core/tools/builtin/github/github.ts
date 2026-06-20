/**
 * github.* — GitHub connector tools (commit, push, open PR, merge PR, status).
 *
 * Wraps the local `git` binary and the already-authenticated `gh` CLI via
 * runCmd (execFile — no shell, no sandbox), so they inherit the daemon's
 * credentials (gh credential helper in ~/.gitconfig, token in ~/.config/gh).
 *
 * Safety model:
 *  - The whole group is registered only when SUDO_GITHUB_TOOLS is enabled
 *    (see index.ts) — default OFF, so the tools do not exist unless opted in.
 *  - github.merge_pr will NOT merge unless the PR's required CI checks are
 *    green and the PR is conflict-free (operator policy: "merge only after CI
 *    green"). It refuses (does not wait) on pending/failing checks.
 *
 * All commands use execFile argument arrays — caller strings (commit messages,
 * PR titles/bodies) are passed as discrete args and never shell-interpolated.
 */

import * as nodePath from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd } from '../system/exec.js';

const logger = createLogger('github-tools');

const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

/** True when the github.* tool group is opted in via SUDO_GITHUB_TOOLS. */
export function gitHubToolsEnabled(): boolean {
  const v = (process.env['SUDO_GITHUB_TOOLS'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve an absolute repo cwd from params, falling back to the session dir. */
function resolveCwd(params: Record<string, unknown>, ctx: ToolContext): string {
  const raw = params['cwd'];
  if (raw === undefined || raw === null || raw === '') {
    return ctx.workingDir || process.cwd();
  }
  if (typeof raw !== 'string' || !nodePath.isAbsolute(raw)) {
    throw new Error(`cwd must be an absolute path (got: ${String(raw)})`);
  }
  return nodePath.resolve(raw);
}

interface CmdOut { stdout: string; stderr: string; exitCode: number; }

function git(args: string[], cwd: string, signal?: AbortSignal): Promise<CmdOut> {
  return runCmd('git', args, { cwd, signal, allowFailure: true });
}

function gh(args: string[], cwd: string, signal?: AbortSignal): Promise<CmdOut> {
  return runCmd('gh', args, { cwd, signal, allowFailure: true });
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
  return v;
}

/** Normalise one statusCheckRollup node to passing | pending | failing. */
function classifyCheck(node: Record<string, unknown>): 'passing' | 'pending' | 'failing' {
  // CheckRun: { status, conclusion }. StatusContext: { state }.
  const status = typeof node['status'] === 'string' ? (node['status'] as string).toUpperCase() : undefined;
  const conclusion = typeof node['conclusion'] === 'string' ? (node['conclusion'] as string).toUpperCase() : undefined;
  const state = typeof node['state'] === 'string' ? (node['state'] as string).toUpperCase() : undefined;

  if (status !== undefined) {
    if (status !== 'COMPLETED') return 'pending';
    if (conclusion && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) return 'passing';
    return 'failing';
  }
  if (state !== undefined) {
    if (state === 'SUCCESS') return 'passing';
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
    return 'failing';
  }
  // Unknown shape — treat conservatively as pending.
  return 'pending';
}

export interface PrSummary {
  number: number;
  title: string;
  state: string;        // OPEN | MERGED | CLOSED
  mergeable: string;    // MERGEABLE | CONFLICTING | UNKNOWN
  url: string;
  checks: { passing: number; pending: number; failing: number; total: number; failingNames: string[]; pendingNames: string[] };
  green: boolean;       // total>0 && failing==0 && pending==0
}

/** Fetch + summarise a PR. prRef may be a number/url/branch, or undefined for the current branch. */
async function getPrSummary(cwd: string, prRef: string | undefined, signal?: AbortSignal): Promise<PrSummary> {
  const args = ['pr', 'view'];
  if (prRef) args.push(prRef);
  args.push('--json', 'number,title,state,mergeable,url,statusCheckRollup');
  const res = await gh(args, cwd, signal);
  if (res.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${res.stderr || res.stdout || 'no PR found for this branch'}`);
  }
  const json = JSON.parse(res.stdout) as {
    number: number; title: string; state: string; mergeable: string; url: string;
    statusCheckRollup?: Array<Record<string, unknown>>;
  };
  const rollup = Array.isArray(json.statusCheckRollup) ? json.statusCheckRollup : [];
  let passing = 0, pending = 0, failing = 0;
  const failingNames: string[] = [], pendingNames: string[] = [];
  for (const node of rollup) {
    const name = String(node['name'] ?? node['context'] ?? 'check');
    const k = classifyCheck(node);
    if (k === 'passing') passing++;
    else if (k === 'pending') { pending++; pendingNames.push(name); }
    else { failing++; failingNames.push(name); }
  }
  const total = rollup.length;
  return {
    number: json.number, title: json.title, state: json.state, mergeable: json.mergeable, url: json.url,
    checks: { passing, pending, failing, total, failingNames, pendingNames },
    green: total > 0 && failing === 0 && pending === 0,
  };
}

function fail(output: string, data?: unknown): ToolResult {
  return { success: false, output, data };
}

/**
 * Resolve a repo-relative path to an absolute path strictly inside cwd.
 * Returns null for absolute paths or any path that escapes the repo (e.g. `..`).
 */
function validateRepoRelPath(cwd: string, rel: string): string | null {
  if (!rel || nodePath.isAbsolute(rel)) return null;
  const abs = nodePath.resolve(cwd, rel);
  const root = nodePath.resolve(cwd) + nodePath.sep;
  return abs.startsWith(root) ? abs : null;
}

// ---------------------------------------------------------------------------
// github.commit
// ---------------------------------------------------------------------------

export const githubCommitTool: ToolDefinition = {
  name: 'github.commit',
  description:
    'Stage and commit changes in a git repo. Optionally create/switch to `branch` first, and write `files` '
    + '([{path,content}]) into the repo before committing (only those files are staged); otherwise stages all '
    + 'changes (or only `paths`). Refuses if there is nothing to commit. Returns the new commit SHA + branch. '
    + 'Use branch+files together to author a change for a new PR.',
  category: 'dev',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    message: { type: 'string', description: 'Commit message.', required: true },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
    branch: { type: 'string', description: 'If set, create/switch to this branch (git checkout -B) before committing — use a feature branch to open a PR off it.', required: false },
    files: { type: 'array', description: 'Files to write into the repo then commit; each {path (repo-relative), content}. When given, only these paths are staged.', required: false, items: { type: 'object', description: 'A file to write', properties: { path: { type: 'string', description: 'Repo-relative path' }, content: { type: 'string', description: 'Full file content' } } } },
    paths: { type: 'array', description: 'Specific existing paths to stage (ignored when `files` is given). Omit to stage all changes (git add -A).', required: false, items: { type: 'string', description: 'Path to stage' } },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const message = asString(params['message'], 'message');
      const paths = Array.isArray(params['paths']) ? (params['paths'] as unknown[]).map(String) : null;
      const branch = typeof params['branch'] === 'string' && (params['branch'] as string).trim()
        ? (params['branch'] as string).trim() : null;
      const files = Array.isArray(params['files'])
        ? (params['files'] as Array<{ path?: unknown; content?: unknown }>) : null;

      // Optional: create/switch to a feature branch first (idempotent -B).
      if (branch) {
        if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return fail(`invalid branch name: ${branch}`);
        const co = await git(['checkout', '-B', branch], cwd, ctx.signal);
        if (co.exitCode !== 0) return fail(`git checkout -B ${branch} failed: ${co.stderr || co.stdout}`);
      }

      // Optional: write files into the repo, then stage exactly those.
      let stagePaths: string[] | null = paths;
      if (files && files.length > 0) {
        const written: string[] = [];
        for (const f of files) {
          const rel = String(f?.path ?? '');
          const abs = validateRepoRelPath(cwd, rel);
          if (!abs) return fail(`invalid or repo-escaping file path: ${rel}`);
          mkdirSync(nodePath.dirname(abs), { recursive: true });
          writeFileSync(abs, typeof f?.content === 'string' ? f.content : '');
          written.push(rel);
        }
        stagePaths = written;
      }

      // Stage.
      const stageArgs = stagePaths && stagePaths.length > 0 ? ['add', '--', ...stagePaths] : ['add', '-A'];
      const staged = await git(stageArgs, cwd, ctx.signal);
      if (staged.exitCode !== 0) return fail(`git add failed: ${staged.stderr || staged.stdout}`);

      // Anything to commit?
      const stat = await git(['status', '--porcelain'], cwd, ctx.signal);
      if (stat.stdout.trim() === '') return fail('Nothing to commit — working tree clean.', { clean: true });

      const committed = await git(['commit', '-m', message], cwd, ctx.signal);
      if (committed.exitCode !== 0) return fail(`git commit failed: ${committed.stderr || committed.stdout}`);

      const sha = (await git(['rev-parse', 'HEAD'], cwd, ctx.signal)).stdout.trim();
      const currentBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, ctx.signal)).stdout.trim();
      logger.info({ sha, branch: currentBranch, session: ctx.sessionId }, 'github.commit');
      return { success: true, output: `Committed ${sha.slice(0, 8)} on ${currentBranch}`, data: { sha, branch: currentBranch } };
    } catch (err) {
      return fail(`github.commit error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.push
// ---------------------------------------------------------------------------

export const githubPushTool: ToolDefinition = {
  name: 'github.push',
  description:
    'Push the current branch to origin, setting upstream. Use after github.commit and before github.open_pr.',
  category: 'dev',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, ctx.signal)).stdout.trim();
      if (branch === 'HEAD') return fail('Detached HEAD — checkout a branch before pushing.');
      const res = await git(['push', '-u', 'origin', 'HEAD'], cwd, ctx.signal);
      if (res.exitCode !== 0) return fail(`git push failed: ${res.stderr || res.stdout}`);
      logger.info({ branch, session: ctx.sessionId }, 'github.push');
      return { success: true, output: `Pushed ${branch} to origin`, data: { branch } };
    } catch (err) {
      return fail(`github.push error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.open_pr
// ---------------------------------------------------------------------------

export const githubOpenPrTool: ToolDefinition = {
  name: 'github.open_pr',
  description:
    'Open a pull request for the current branch (pushes it first unless push=false). Returns the PR number and URL.',
  category: 'dev',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    title: { type: 'string', description: 'PR title.', required: true },
    body: { type: 'string', description: 'PR body (markdown).', required: false },
    base: { type: 'string', description: 'Base branch to merge into. Defaults to "main".', required: false },
    draft: { type: 'boolean', description: 'Open as a draft PR. Defaults to false.', required: false },
    push: { type: 'boolean', description: 'Push the current branch before opening. Defaults to true.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const title = asString(params['title'], 'title');
      const body = typeof params['body'] === 'string' ? (params['body'] as string) : '';
      const base = typeof params['base'] === 'string' && params['base'] ? (params['base'] as string) : 'main';
      const draft = params['draft'] === true;
      const doPush = params['push'] !== false;

      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, ctx.signal)).stdout.trim();
      if (branch === 'HEAD') return fail('Detached HEAD — checkout a branch before opening a PR.');
      if (branch === base) return fail(`Current branch equals base (${base}) — create a feature branch first.`);

      if (doPush) {
        const pushed = await git(['push', '-u', 'origin', 'HEAD'], cwd, ctx.signal);
        if (pushed.exitCode !== 0) return fail(`git push failed: ${pushed.stderr || pushed.stdout}`);
      }

      const args = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body];
      if (draft) args.push('--draft');
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) return fail(`gh pr create failed: ${res.stderr || res.stdout}`);

      const url = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      const num = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
      logger.info({ branch, base, num, url, session: ctx.sessionId }, 'github.open_pr');
      return { success: true, output: `Opened PR #${num}: ${url}`, data: { number: num, url, branch, base } };
    } catch (err) {
      return fail(`github.open_pr error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.pr_status (readonly)
// ---------------------------------------------------------------------------

export const githubPrStatusTool: ToolDefinition = {
  name: 'github.pr_status',
  description:
    'Report a PR\'s state, mergeability, and CI check rollup (passing/pending/failing). '
    + 'Omit `pr` to use the current branch\'s PR. Read-only.',
  category: 'dev',
  safety: 'readonly',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    pr: { type: 'string', description: 'PR number, URL, or branch. Omit for the current branch.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const s = await getPrSummary(cwd, prRef, ctx.signal);
      const c = s.checks;
      const output = `PR #${s.number} [${s.state}] ${s.mergeable} — checks: ${c.passing} passing, ${c.pending} pending, ${c.failing} failing`
        + ` → ${s.green ? 'GREEN (mergeable)' : 'not green'}`;
      return { success: true, output, data: s };
    } catch (err) {
      return fail(`github.pr_status error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.merge_pr (CI-green gated)
// ---------------------------------------------------------------------------

export const githubMergePrTool: ToolDefinition = {
  name: 'github.merge_pr',
  description:
    'Merge a pull request — ONLY if its required CI checks are green and it is conflict-free. '
    + 'Refuses (does not wait) when checks are pending or failing. Omit `pr` to use the current branch. '
    + 'Default method is squash with branch deletion.',
  category: 'dev',
  safety: 'destructive',
  requiresConfirmation: false,
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    pr: { type: 'string', description: 'PR number, URL, or branch. Omit for the current branch.', required: false },
    method: { type: 'string', description: 'Merge method.', required: false, enum: ['squash', 'merge', 'rebase'] },
    delete_branch: { type: 'boolean', description: 'Delete the head branch after merge. Defaults to true.', required: false },
    allow_no_checks: { type: 'boolean', description: 'Allow merging a PR that has zero CI checks. Defaults to false.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const method = ['squash', 'merge', 'rebase'].includes(String(params['method'])) ? String(params['method']) : 'squash';
      const deleteBranch = params['delete_branch'] !== false;
      const allowNoChecks = params['allow_no_checks'] === true;

      // --- CI-green gate ---
      const s = await getPrSummary(cwd, prRef, ctx.signal);
      if (s.state !== 'OPEN') return fail(`PR #${s.number} is ${s.state}, not OPEN — cannot merge.`, s);
      if (s.mergeable === 'CONFLICTING') return fail(`PR #${s.number} has merge conflicts — resolve before merging.`, s);
      if (s.checks.total === 0 && !allowNoChecks) {
        return fail(`PR #${s.number} has no CI checks. Pass allow_no_checks=true to merge anyway.`, s);
      }
      if (s.checks.failing > 0) return fail(`PR #${s.number} has ${s.checks.failing} failing check(s): ${s.checks.failingNames.join(', ')} — refusing to merge.`, s);
      if (s.checks.pending > 0) return fail(`PR #${s.number} has ${s.checks.pending} pending check(s): ${s.checks.pendingNames.join(', ')} — CI not finished, refusing to merge (retry later).`, s);

      // --- Merge ---
      const args = ['pr', 'merge', String(s.number), `--${method}`];
      if (deleteBranch) args.push('--delete-branch');
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) return fail(`gh pr merge failed: ${res.stderr || res.stdout}`, s);
      logger.info({ pr: s.number, method, session: ctx.sessionId }, 'github.merge_pr');
      return { success: true, output: `Merged PR #${s.number} (${method}) — CI was green (${s.checks.passing} checks).`, data: { number: s.number, method, url: s.url } };
    } catch (err) {
      return fail(`github.merge_pr error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const GITHUB_TOOLS: readonly ToolDefinition[] = [
  githubCommitTool,
  githubPushTool,
  githubOpenPrTool,
  githubPrStatusTool,
  githubMergePrTool,
] as const;
