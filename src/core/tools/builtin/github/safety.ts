/**
 * github safety layer — zero-risk guardrails for the github.* connector.
 *
 * Operator directive: SUDO-AI must have full git mastery with ZERO risk, so
 * every mutating github.* action passes through these gates:
 *  - PROTECTED PATHS — the agent may never commit or merge changes to critical
 *    files (CI workflows, runtime/env config, secrets, dependency manifests, the
 *    connector + router themselves). Enforced at commit AND merge.
 *  - DEFAULT-BRANCH guard — never commit directly to main/master; feature
 *    branches only.
 *  - AUDIT LOG — every mutating action and every refusal is appended to
 *    data/github-audit.jsonl for full traceability.
 *
 * The connector exposes no destructive primitives (no force-push, history
 * rewrite, --admin merge, or hard reset); this layer adds the path/branch gates.
 */

import * as nodePath from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { DATA_DIR } from '../../../shared/paths.js';
import { runCmd } from '../system/exec.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('github-safety');

// ---------------------------------------------------------------------------
// Protected paths
// ---------------------------------------------------------------------------

/** Glob patterns the agent must never commit/merge. Strong zero-risk default. */
const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  '.github/**',                 // CI/CD workflows + actions
  '.githooks/**',               // git hooks
  'ecosystem.config.cjs',       // PM2 runtime: env flags, ports, secret passthrough
  'config/**',                  // daemon config + .env loading
  '.env', '.env.*', '**/.env', '**/.env.*',          // secrets
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', // deps / supply chain
  'tsconfig.json', 'tsconfig.*.json',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.*.yml',
  // The connector + router themselves — so the agent cannot disable its own guardrails.
  'src/core/tools/builtin/github/**',
  'src/core/agent/tool-router.ts',
];

/** Reserved branch names the agent must never create/reset or commit onto. */
const PROTECTED_BRANCHES = new Set([
  'main', 'master', 'develop', 'release', 'production', 'prod', 'gh-pages',
]);

/** Operator-supplied extra protected globs (comma-separated). */
function extraGlobs(): string[] {
  const raw = process.env['SUDO_GITHUB_PROTECTED_PATHS'];
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Convert a simple glob (supports `**` and `*`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` also matches zero dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '/') {
      re += '/';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function protectedRegexes(): RegExp[] {
  return [...DEFAULT_PROTECTED_GLOBS, ...extraGlobs()].map(globToRegExp);
}

/** Normalise to posix, strip leading ./ and /. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** True if `relPath` matches any protected glob. */
export function isProtectedPath(relPath: string): boolean {
  const p = norm(relPath);
  if (!p) return false;
  return protectedRegexes().some((re) => re.test(p));
}

/** Return the (normalised) protected paths within `paths` (empty if none). */
export function protectedHits(paths: string[]): string[] {
  const res = protectedRegexes();
  return paths.map(norm).filter((p) => p && res.some((re) => re.test(p)));
}

/** True if branch is a protected/reserved branch name. */
export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Default branch
// ---------------------------------------------------------------------------

/** Best-effort default branch for the repo at cwd (origin/HEAD → main fallback). */
export async function defaultBranch(cwd: string, signal?: AbortSignal): Promise<string> {
  const r = await runCmd('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd, signal, allowFailure: true });
  if (r.exitCode === 0 && r.stdout.trim()) {
    const b = r.stdout.trim();
    return b.includes('/') ? b.slice(b.lastIndexOf('/') + 1) : b;
  }
  return 'main';
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const AUDIT_FILE = nodePath.join(DATA_DIR, 'github-audit.jsonl');

export interface AuditEntry {
  action: string;
  session?: string;
  ok: boolean;
  detail?: string;
  data?: Record<string, unknown>;
}

/** Append a github.* action (success or refusal) to the audit log. Best-effort. */
export function auditGitHub(entry: AuditEntry): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    log.warn({ err: String(err) }, 'github audit append failed (non-fatal)');
  }
}
