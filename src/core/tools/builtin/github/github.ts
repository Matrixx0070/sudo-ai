/**
 * github.* — GitHub connector tools (commit, push, open PR, merge PR, status).
 *
 * Wraps the local `git` binary and the already-authenticated `gh` CLI via
 * runCmd (execFile — no shell, no sandbox), so they inherit the daemon's
 * credentials (gh credential helper in ~/.gitconfig, token in ~/.config/gh).
 *
 * Safety model (zero-risk — see safety.ts):
 *  - The whole group is registered only when SUDO_GITHUB_TOOLS is enabled
 *    (see index.ts) — default OFF, so the tools do not exist unless opted in.
 *  - PROTECTED PATHS: commit refuses to write/stage, and merge_pr refuses to
 *    merge, any change to critical files (CI, config, secrets, manifests, the
 *    connector + router themselves).
 *  - FEATURE BRANCHES ONLY: commit refuses to commit onto the default/protected
 *    branch — the agent must work on a feature branch.
 *  - github.merge_pr will NOT merge unless the PR's required CI checks are
 *    green and the PR is conflict-free (operator policy: "merge only after CI
 *    green"). It refuses (does not wait) on pending/failing checks.
 *  - No destructive primitives are exposed (no force-push / reset / history
 *    rewrite / --admin merge). Every mutating action is appended to the audit
 *    log (data/github-audit.jsonl).
 *
 * All commands use execFile argument arrays — caller strings (commit messages,
 * PR titles/bodies) are passed as discrete args and never shell-interpolated.
 */

import * as nodePath from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { runCmd } from '../system/exec.js';
import { isProtectedBranch, protectedHits, defaultBranch, auditGitHub } from './safety.js';

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
  changedFiles: string[]; // repo-relative paths the PR touches (for protected-path gate)
  checks: { passing: number; pending: number; failing: number; total: number; failingNames: string[]; pendingNames: string[] };
  green: boolean;       // total>0 && failing==0 && pending==0
}

/** Fetch + summarise a PR. prRef may be a number/url/branch, or undefined for the current branch. */
async function getPrSummary(cwd: string, prRef: string | undefined, signal?: AbortSignal): Promise<PrSummary> {
  const args = ['pr', 'view'];
  if (prRef) args.push(prRef);
  args.push('--json', 'number,title,state,mergeable,url,statusCheckRollup,files');
  const res = await gh(args, cwd, signal);
  if (res.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${res.stderr || res.stdout || 'no PR found for this branch'}`);
  }
  const json = JSON.parse(res.stdout) as {
    number: number; title: string; state: string; mergeable: string; url: string;
    statusCheckRollup?: Array<Record<string, unknown>>;
    files?: Array<{ path?: string }>;
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
  const changedFiles = Array.isArray(json.files)
    ? json.files.map((f) => String(f.path ?? '')).filter(Boolean) : [];
  return {
    number: json.number, title: json.title, state: json.state, mergeable: json.mergeable, url: json.url,
    changedFiles,
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

/** Keep the last n chars of s (for trimming long command output). */
function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
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
  category: 'github',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    message: { type: 'string', description: 'Commit message.', required: true },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
    branch: { type: 'string', description: 'If set, create/switch to this branch (git checkout -B) before committing — use a feature branch to open a PR off it.', required: false },
    files: { type: 'array', description: 'Files to write/edit then commit; each {path, content?} to write a whole file, OR {path, edits:[{find,replace,all?}]} for targeted find/replace on the existing file (read it first with github.read_file). Only these paths are staged.', required: false, items: { type: 'object', description: 'A file to write or edit', properties: { path: { type: 'string', description: 'Repo-relative path' }, content: { type: 'string', description: 'Full file content (whole-file write)' }, edits: { type: 'array', description: 'Targeted edits applied to the existing file content', items: { type: 'object', description: 'find/replace', properties: { find: { type: 'string', description: 'Exact substring to find' }, replace: { type: 'string', description: 'Replacement text' }, all: { type: 'boolean', description: 'Replace all occurrences (default: first only)' } } } } } } },
    paths: { type: 'array', description: 'Specific existing paths to stage (ignored when `files` is given). Omit to stage all changes (git add -A).', required: false, items: { type: 'string', description: 'Path to stage' } },
  },
  async execute(params, ctx): Promise<ToolResult> {
    const sess = ctx.sessionId;
    const deny = (msg: string, data?: unknown): ToolResult => {
      auditGitHub({ action: 'commit', session: sess, ok: false, detail: msg });
      return fail(msg, data);
    };
    try {
      const cwd = resolveCwd(params, ctx);
      const message = asString(params['message'], 'message');
      const paths = Array.isArray(params['paths']) ? (params['paths'] as unknown[]).map(String) : null;
      const branch = typeof params['branch'] === 'string' && (params['branch'] as string).trim()
        ? (params['branch'] as string).trim() : null;
      const files = Array.isArray(params['files'])
        ? (params['files'] as Array<{ path?: unknown; content?: unknown }>) : null;

      // Zero-risk: never write/commit protected paths (declared up front).
      const declaredHits = protectedHits([
        ...(files ? files.map((f) => String(f?.path ?? '')) : []),
        ...(paths ?? []),
      ].filter(Boolean));
      if (declaredHits.length > 0) {
        return deny(`Refused — the agent may not commit protected path(s): ${declaredHits.join(', ')}`);
      }

      // Zero-risk: feature branches only — never commit onto a protected/default branch.
      if (branch) {
        if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return deny(`invalid branch name: ${branch}`);
        if (isProtectedBranch(branch)) return deny(`Refused — '${branch}' is a protected branch; use a feature branch.`);
        const co = await git(['checkout', '-B', branch], cwd, ctx.signal);
        if (co.exitCode !== 0) return deny(`git checkout -B ${branch} failed: ${co.stderr || co.stdout}`);
      } else {
        const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, ctx.signal)).stdout.trim();
        const def = await defaultBranch(cwd, ctx.signal);
        if (cur === def || isProtectedBranch(cur)) {
          return deny(`Refused — won't commit directly on '${cur}'. Pass branch='feature/...' to use a feature branch.`);
        }
      }

      // Optional: write/edit files into the repo, then stage exactly those.
      let stagePaths: string[] | null = paths;
      if (files && files.length > 0) {
        const written: string[] = [];
        for (const f of files) {
          const rel = String(f?.path ?? '');
          const abs = validateRepoRelPath(cwd, rel);
          if (!abs) return deny(`invalid or repo-escaping file path: ${rel}`);
          const edits = Array.isArray((f as { edits?: unknown }).edits)
            ? ((f as { edits?: unknown }).edits as Array<{ find?: unknown; replace?: unknown; all?: unknown }>) : null;
          if (edits && edits.length > 0) {
            // Targeted edit: apply find/replace to the file's CURRENT content.
            let cur: string;
            try { cur = readFileSync(abs, 'utf8'); }
            catch { return deny(`cannot edit non-existent file (pass content to create it): ${rel}`); }
            for (const e of edits) {
              const find = typeof e?.find === 'string' ? e.find : '';
              const replace = typeof e?.replace === 'string' ? e.replace : '';
              if (!find) return deny(`edit for ${rel} is missing 'find'`);
              if (!cur.includes(find)) return deny(`edit target not found in ${rel}: "${find.slice(0, 60)}"`);
              cur = e?.all === true ? cur.split(find).join(replace) : cur.replace(find, () => replace);
            }
            writeFileSync(abs, cur);
          } else {
            mkdirSync(nodePath.dirname(abs), { recursive: true });
            writeFileSync(abs, typeof f?.content === 'string' ? f.content : '');
          }
          written.push(rel);
        }
        stagePaths = written;
      }

      // Stage.
      const stageArgs = stagePaths && stagePaths.length > 0 ? ['add', '--', ...stagePaths] : ['add', '-A'];
      const staged = await git(stageArgs, cwd, ctx.signal);
      if (staged.exitCode !== 0) return deny(`git add failed: ${staged.stderr || staged.stdout}`);

      // Zero-risk: re-check what is ACTUALLY staged (covers add -A) — never commit protected files.
      const stagedList = (await git(['diff', '--cached', '--name-only'], cwd, ctx.signal))
        .stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const stagedHits = protectedHits(stagedList);
      if (stagedHits.length > 0) {
        await git(['reset', '-q'], cwd, ctx.signal); // unstage everything; working tree untouched
        return deny(`Refused — staged changes include protected path(s): ${stagedHits.join(', ')}`);
      }
      if (stagedList.length === 0) return deny('Nothing to commit — working tree clean.');

      const committed = await git(['commit', '-m', message], cwd, ctx.signal);
      if (committed.exitCode !== 0) return deny(`git commit failed: ${committed.stderr || committed.stdout}`);

      const sha = (await git(['rev-parse', 'HEAD'], cwd, ctx.signal)).stdout.trim();
      const currentBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, ctx.signal)).stdout.trim();
      logger.info({ sha, branch: currentBranch, session: sess }, 'github.commit');
      auditGitHub({ action: 'commit', session: sess, ok: true, data: { sha, branch: currentBranch, files: stagedList.length } });
      return { success: true, output: `Committed ${sha.slice(0, 8)} on ${currentBranch}`, data: { sha, branch: currentBranch } };
    } catch (err) {
      return deny(`github.commit error: ${err instanceof Error ? err.message : String(err)}`);
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
  category: 'github',
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
      auditGitHub({ action: 'push', session: ctx.sessionId, ok: true, data: { branch } });
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
  category: 'github',
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
      auditGitHub({ action: 'open_pr', session: ctx.sessionId, ok: true, data: { number: num, branch, base } });
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
  category: 'github',
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
  category: 'github',
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
    const sess = ctx.sessionId;
    const deny = (msg: string, data?: unknown): ToolResult => {
      auditGitHub({ action: 'merge_pr', session: sess, ok: false, detail: msg });
      return fail(msg, data);
    };
    try {
      const cwd = resolveCwd(params, ctx);
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const method = ['squash', 'merge', 'rebase'].includes(String(params['method'])) ? String(params['method']) : 'squash';
      const deleteBranch = params['delete_branch'] !== false;
      const allowNoChecks = params['allow_no_checks'] === true;

      // --- CI-green gate ---
      const s = await getPrSummary(cwd, prRef, ctx.signal);
      if (s.state !== 'OPEN') return deny(`PR #${s.number} is ${s.state}, not OPEN — cannot merge.`, s);
      if (s.mergeable === 'CONFLICTING') return deny(`PR #${s.number} has merge conflicts — resolve before merging.`, s);
      // --- Zero-risk: never merge a PR that touches protected paths ---
      const protHits = protectedHits(s.changedFiles);
      if (protHits.length > 0) {
        return deny(`PR #${s.number} changes protected path(s): ${protHits.join(', ')} — refusing to merge (human review required).`, s);
      }
      if (s.checks.total === 0 && !allowNoChecks) {
        return deny(`PR #${s.number} has no CI checks. Pass allow_no_checks=true to merge anyway.`, s);
      }
      if (s.checks.failing > 0) return deny(`PR #${s.number} has ${s.checks.failing} failing check(s): ${s.checks.failingNames.join(', ')} — refusing to merge.`, s);
      if (s.checks.pending > 0) return deny(`PR #${s.number} has ${s.checks.pending} pending check(s): ${s.checks.pendingNames.join(', ')} — CI not finished, refusing to merge (retry later).`, s);

      // --- Merge ---
      const args = ['pr', 'merge', String(s.number), `--${method}`];
      if (deleteBranch) args.push('--delete-branch');
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) return deny(`gh pr merge failed: ${res.stderr || res.stdout}`, s);
      logger.info({ pr: s.number, method, session: sess }, 'github.merge_pr');
      auditGitHub({ action: 'merge_pr', session: sess, ok: true, data: { number: s.number, method, checks: s.checks.passing } });
      return { success: true, output: `Merged PR #${s.number} (${method}) — CI was green (${s.checks.passing} checks).`, data: { number: s.number, method, url: s.url } };
    } catch (err) {
      return deny(`github.merge_pr error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.read_file (readonly)
// ---------------------------------------------------------------------------

export const githubReadFileTool: ToolDefinition = {
  name: 'github.read_file',
  description:
    'Read a file from the repository working tree so you can see its CURRENT content before making a '
    + 'targeted edit. Repo-relative path. Read-only; refuses protected paths (CI/config/secrets).',
  category: 'github',
  safety: 'readonly',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    path: { type: 'string', description: 'Repo-relative file path.', required: true },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const rel = asString(params['path'], 'path');
      if (protectedHits([rel]).length > 0) {
        return fail(`Refused — '${rel}' is a protected path and cannot be read by the agent.`);
      }
      const abs = validateRepoRelPath(cwd, rel);
      if (!abs) return fail(`invalid or repo-escaping path: ${rel}`);
      let content: string;
      try { content = readFileSync(abs, 'utf8'); }
      catch (e) { return fail(`cannot read ${rel}: ${e instanceof Error ? e.message : String(e)}`); }
      const MAX = 256 * 1024;
      const truncated = content.length > MAX;
      return {
        success: true,
        output: truncated ? content.slice(0, MAX) + `\n…[truncated ${content.length - MAX} bytes]` : content,
        data: { path: rel, bytes: content.length, truncated },
      };
    } catch (err) {
      return fail(`github.read_file error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.verify (readonly) — run lint / tests on the working tree before a PR
// ---------------------------------------------------------------------------

export const githubVerifyTool: ToolDefinition = {
  name: 'github.verify',
  description:
    'Validate the working tree BEFORE opening a PR: run lint (tsc --noEmit) and, optionally, the test suite. '
    + 'Returns pass/fail per check plus the tail of any failure output, so you can fix issues before pushing.',
  category: 'github',
  safety: 'readonly',
  timeout: 300_000,
  parameters: {
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
    lint: { type: 'boolean', description: 'Run tsc --noEmit (type check). Default true.', required: false },
    tests: { type: 'boolean', description: 'Run the full test suite (slower, ~minutes). Default false.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const doLint = params['lint'] !== false;
      const doTests = params['tests'] === true;
      const parts: string[] = [];
      let ok = true;
      if (doLint) {
        const r = await runCmd(nodePath.join(cwd, 'node_modules/.bin/tsc'), ['--noEmit'], { cwd, signal: ctx.signal, allowFailure: true });
        const lintOk = r.exitCode === 0;
        ok = ok && lintOk;
        parts.push(`lint (tsc --noEmit): ${lintOk ? 'PASS' : 'FAIL'}${lintOk ? '' : '\n' + tail(r.stdout || r.stderr, 2000)}`);
      }
      if (doTests) {
        const r = await runCmd(nodePath.join(cwd, 'node_modules/.bin/vitest'), ['run'], { cwd, signal: ctx.signal, allowFailure: true });
        const testOk = r.exitCode === 0;
        ok = ok && testOk;
        parts.push(`tests (vitest run): ${testOk ? 'PASS' : 'FAIL'}${testOk ? '' : '\n' + tail(r.stdout || r.stderr, 2000)}`);
      }
      logger.info({ ok, lint: doLint, tests: doTests, session: ctx.sessionId }, 'github.verify');
      return { success: ok, output: parts.join('\n\n') || 'nothing to verify (lint=false, tests=false)', data: { ok } };
    } catch (err) {
      return fail(`github.verify error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.list_prs / pr_diff (readonly)
// ---------------------------------------------------------------------------

export const githubListPrsTool: ToolDefinition = {
  name: 'github.list_prs',
  description: 'List pull requests (number, title, state, branch, draft flag). Read-only.',
  category: 'github',
  safety: 'readonly',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    state: { type: 'string', description: 'Filter by state. Default open.', required: false, enum: ['open', 'closed', 'merged', 'all'] },
    limit: { type: 'number', description: 'Max PRs to return (≤100). Default 20.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const state = ['open', 'closed', 'merged', 'all'].includes(String(params['state'])) ? String(params['state']) : 'open';
      const n = Number(params['limit']);
      const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
      const res = await gh(['pr', 'list', '--state', state, '--limit', String(limit), '--json', 'number,title,state,headRefName,isDraft'], cwd, ctx.signal);
      if (res.exitCode !== 0) return fail(`gh pr list failed: ${res.stderr || res.stdout}`);
      const prs = JSON.parse(res.stdout || '[]') as Array<{ number: number; title: string; state: string; headRefName: string; isDraft: boolean }>;
      const lines = prs.map((p) => `#${p.number} [${p.state}${p.isDraft ? ',draft' : ''}] ${p.title} (${p.headRefName})`);
      return { success: true, output: lines.join('\n') || `No ${state} PRs.`, data: { prs } };
    } catch (err) {
      return fail(`github.list_prs error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const githubPrDiffTool: ToolDefinition = {
  name: 'github.pr_diff',
  description: 'Show a pull request\'s diff (or only changed file paths with name_only=true). Read-only. Omit `pr` for the current branch.',
  category: 'github',
  safety: 'readonly',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    pr: { type: 'string', description: 'PR number/url/branch. Omit for the current branch.', required: false },
    name_only: { type: 'boolean', description: 'Return only changed file paths. Default false.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    try {
      const cwd = resolveCwd(params, ctx);
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const args = ['pr', 'diff'];
      if (prRef) args.push(prRef);
      if (params['name_only'] === true) args.push('--name-only');
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) return fail(`gh pr diff failed: ${res.stderr || res.stdout}`);
      const MAX = 32 * 1024;
      const out = res.stdout;
      return { success: true, output: out.length > MAX ? out.slice(0, MAX) + '\n…[diff truncated]' : (out || '(no diff)'), data: { bytes: out.length } };
    } catch (err) {
      return fail(`github.pr_diff error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// github.pr_comment / update_branch / pr_ready / close_pr (mutating, audited)
// ---------------------------------------------------------------------------

export const githubPrCommentTool: ToolDefinition = {
  name: 'github.pr_comment',
  description: 'Post a comment on a pull request. Omit `pr` for the current branch.',
  category: 'github',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    body: { type: 'string', description: 'Comment body (markdown).', required: true },
    pr: { type: 'string', description: 'PR number/url/branch. Omit for the current branch.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    const sess = ctx.sessionId;
    try {
      const cwd = resolveCwd(params, ctx);
      const body = asString(params['body'], 'body');
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const args = ['pr', 'comment'];
      if (prRef) args.push(prRef);
      args.push('--body', body);
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) { auditGitHub({ action: 'pr_comment', session: sess, ok: false, detail: res.stderr || res.stdout }); return fail(`gh pr comment failed: ${res.stderr || res.stdout}`); }
      auditGitHub({ action: 'pr_comment', session: sess, ok: true, data: { pr: prRef ?? 'current' } });
      return { success: true, output: `Commented on PR ${prRef ?? '(current branch)'}`, data: { url: res.stdout.trim() } };
    } catch (err) {
      auditGitHub({ action: 'pr_comment', session: sess, ok: false, detail: String(err) });
      return fail(`github.pr_comment error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const githubUpdateBranchTool: ToolDefinition = {
  name: 'github.update_branch',
  description: 'Update a PR\'s branch with the latest base (non-destructive merge of base into the head branch) — use when a PR is BEHIND. Omit `pr` for the current branch.',
  category: 'github',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    pr: { type: 'string', description: 'PR number/url/branch. Omit for the current branch.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    const sess = ctx.sessionId;
    try {
      const cwd = resolveCwd(params, ctx);
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const args = ['pr', 'update-branch'];
      if (prRef) args.push(prRef);
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) { auditGitHub({ action: 'update_branch', session: sess, ok: false, detail: res.stderr || res.stdout }); return fail(`gh pr update-branch failed: ${res.stderr || res.stdout}`); }
      auditGitHub({ action: 'update_branch', session: sess, ok: true, data: { pr: prRef ?? 'current' } });
      return { success: true, output: `Updated PR ${prRef ?? '(current branch)'} branch with base`, data: {} };
    } catch (err) {
      auditGitHub({ action: 'update_branch', session: sess, ok: false, detail: String(err) });
      return fail(`github.update_branch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const githubPrReadyTool: ToolDefinition = {
  name: 'github.pr_ready',
  description: 'Mark a draft PR ready for review, or (with draft=true) convert a PR back to draft. Omit `pr` for the current branch.',
  category: 'github',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    pr: { type: 'string', description: 'PR number/url/branch. Omit for the current branch.', required: false },
    draft: { type: 'boolean', description: 'If true, convert to draft instead of ready. Default false.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    const sess = ctx.sessionId;
    try {
      const cwd = resolveCwd(params, ctx);
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const toDraft = params['draft'] === true;
      const args = ['pr', 'ready'];
      if (prRef) args.push(prRef);
      if (toDraft) args.push('--undo');
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) { auditGitHub({ action: 'pr_ready', session: sess, ok: false, detail: res.stderr || res.stdout }); return fail(`gh pr ready failed: ${res.stderr || res.stdout}`); }
      auditGitHub({ action: 'pr_ready', session: sess, ok: true, data: { pr: prRef ?? 'current', draft: toDraft } });
      return { success: true, output: `PR ${prRef ?? '(current branch)'} marked ${toDraft ? 'draft' : 'ready'}`, data: { draft: toDraft } };
    } catch (err) {
      auditGitHub({ action: 'pr_ready', session: sess, ok: false, detail: String(err) });
      return fail(`github.pr_ready error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const githubClosePrTool: ToolDefinition = {
  name: 'github.close_pr',
  description: 'Close a pull request WITHOUT merging (reversible — it can be reopened). Optionally delete the head branch and/or leave a comment. Omit `pr` for the current branch.',
  category: 'github',
  safety: 'destructive',
  timeout: DEFAULT_TIMEOUT_MS,
  parameters: {
    pr: { type: 'string', description: 'PR number/url/branch. Omit for the current branch.', required: false },
    comment: { type: 'string', description: 'Optional closing comment.', required: false },
    delete_branch: { type: 'boolean', description: 'Delete the head branch on close. Default false.', required: false },
    cwd: { type: 'string', description: 'Absolute path to the repo. Defaults to the session working dir.', required: false },
  },
  async execute(params, ctx): Promise<ToolResult> {
    const sess = ctx.sessionId;
    try {
      const cwd = resolveCwd(params, ctx);
      const prRef = typeof params['pr'] === 'string' && params['pr'] ? (params['pr'] as string) : undefined;
      const args = ['pr', 'close'];
      if (prRef) args.push(prRef);
      if (typeof params['comment'] === 'string' && params['comment']) args.push('--comment', params['comment'] as string);
      if (params['delete_branch'] === true) args.push('--delete-branch');
      const res = await gh(args, cwd, ctx.signal);
      if (res.exitCode !== 0) { auditGitHub({ action: 'close_pr', session: sess, ok: false, detail: res.stderr || res.stdout }); return fail(`gh pr close failed: ${res.stderr || res.stdout}`); }
      auditGitHub({ action: 'close_pr', session: sess, ok: true, data: { pr: prRef ?? 'current' } });
      return { success: true, output: `Closed PR ${prRef ?? '(current branch)'} (not merged)`, data: {} };
    } catch (err) {
      auditGitHub({ action: 'close_pr', session: sess, ok: false, detail: String(err) });
      return fail(`github.close_pr error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const GITHUB_TOOLS: readonly ToolDefinition[] = [
  githubReadFileTool,
  githubCommitTool,
  githubPushTool,
  githubOpenPrTool,
  githubListPrsTool,
  githubPrDiffTool,
  githubPrStatusTool,
  githubVerifyTool,
  githubPrCommentTool,
  githubUpdateBranchTool,
  githubPrReadyTool,
  githubMergePrTool,
  githubClosePrTool,
] as const;
