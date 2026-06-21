/**
 * repo-allowlist — the gate for running commands against the REAL repo
 * (PROJECT_ROOT) outside the bubblewrap sandbox, via system.exec target:'repo'.
 *
 * This is the narrow, gated alternative to unsandboxing system.exec wholesale.
 * It is default-deny and read-and-verify ONLY: the daemon's autonomous loop may
 * run the test/build/lint and read-only inspection commands it needs to verify
 * its own changes — and nothing that mutates the repo, the service, or the
 * network. Mutating/service commands (git write ops, pm2 restart, installs) are
 * intentionally absent; granting those is a separate, deliberate decision.
 *
 * Safety model (mirrors security/approval/allowlist.ts):
 *   1. Reject ANY shell metacharacter first — no chaining/expansion/redirection.
 *   2. Tokenize on whitespace (safe once metachars are gone).
 *   3. argv[0] must be a bare command name (no path → no symlink/binary swap).
 *   4. No argument may escape the repo (absolute path or `..`).
 *   5. argv[0] + its args must match an explicit read/verify rule.
 * Commands are then executed via execFile arg-array (NO shell), so even a
 * matched command cannot expand or chain.
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT, DATA_DIR } from '../../shared/paths.js';

const log = createLogger('security:repo-allowlist');

/**
 * Any of these in the command string aborts the match immediately. Covers
 * chaining (; & |), substitution ($ ` ()), redirection (< >), globbing (* ? ~),
 * braces, quotes, escapes, and newlines.
 */
const SHELL_METACHARS = /[;&|`$(){}<>\\!*?~\n\r'"]/;

/** A repo command rule: bare command name → validator for the remaining args. */
interface RepoRule {
  cmd: string;
  ok: (rest: string[]) => boolean;
}

const SCRIPT_VERBS = new Set(['build', 'lint', 'test']);

/**
 * The allowlist. Read-and-verify ONLY. Deliberately excludes:
 *   - git WRITE ops (checkout/reset/clean/commit/restore/stash/rm/add/merge/rebase/push/pull/fetch)
 *   - git show (HEAD:.env reads committed secrets)
 *   - pm2 restart/reload/delete (bounces or kills prod — separate slice)
 *   - cat/head/tail/grep (credential reads — use rg, or self-modify read-file)
 *   - npx/node (can fetch/run arbitrary code)
 */
const RULES: readonly RepoRule[] = [
  { cmd: 'pnpm', ok: r => ['test', 'lint', 'build'].includes(r[0] ?? '') || (r[0] === 'run' && SCRIPT_VERBS.has(r[1] ?? '')) },
  { cmd: 'npm',  ok: r => r[0] === 'test' || (r[0] === 'run' && SCRIPT_VERBS.has(r[1] ?? '')) },
  // Read-only git only.
  { cmd: 'git',  ok: r => ['status', 'log', 'diff', 'branch', 'rev-parse', 'describe', 'blame', 'shortlog'].includes(r[0] ?? '') },
  // Read-only inspection.
  { cmd: 'rg',   ok: () => true },
  { cmd: 'ls',   ok: () => true },
  { cmd: 'wc',   ok: () => true },
  // Read-only pm2 status/logs for our app only — NO restart/reload/delete.
  { cmd: 'pm2',  ok: r => ['list', 'status', 'jlist', 'prettylist'].includes(r[0] ?? '') || (['logs', 'describe'].includes(r[0] ?? '') && r[1] === 'sudo-ai-v5') },
];

export interface RepoMatch {
  allowed: boolean;
  /** Tokenized command (argv) — only meaningful when allowed. */
  argv: string[];
  reason?: string;
}

/** True when repo-exec is enabled by the operator (default OFF). */
export function repoExecEnabled(): boolean {
  return process.env['SUDO_REPO_EXEC'] === '1';
}

/**
 * Decide whether `command` may run against the real repo, and return its argv.
 * Pure — no execution, no env beyond the rules. Exported for unit testing.
 */
export function checkRepoCommand(command: string): RepoMatch {
  const cmd = (command ?? '').trim();
  if (!cmd) return { allowed: false, argv: [], reason: 'empty command' };

  if (SHELL_METACHARS.test(cmd)) {
    return { allowed: false, argv: [], reason: 'shell metacharacters are not allowed in repo-exec' };
  }

  const argv = cmd.split(/\s+/).filter(Boolean);
  const head = argv[0]!;

  if (head.includes('/')) {
    return { allowed: false, argv, reason: 'command must be a bare name (no path prefix)' };
  }

  for (const arg of argv.slice(1)) {
    if (arg.startsWith('/') || arg.split('/').includes('..')) {
      return { allowed: false, argv, reason: `argument escapes the repo: ${arg}` };
    }
  }

  const rule = RULES.find(r => r.cmd === head.toLowerCase());
  if (!rule) return { allowed: false, argv, reason: `'${head}' is not a repo-allowlisted command` };
  if (!rule.ok(argv.slice(1))) {
    return { allowed: false, argv, reason: `'${command}' is not an allowed form of '${head}'` };
  }

  return { allowed: true, argv };
}

// ---------------------------------------------------------------------------
// Audit (mirrors github/safety.ts auditGitHub)
// ---------------------------------------------------------------------------

const AUDIT_FILE = path.join(DATA_DIR, 'exec-audit.jsonl');

export interface ExecAuditEntry {
  session?: string;
  command: string;
  allowed: boolean;
  exitCode?: number;
  reason?: string;
}

/** Append a repo-exec attempt (allowed or refused) to data/exec-audit.jsonl. Best-effort. */
export function auditExec(entry: ExecAuditEntry): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    try { if (statSync(AUDIT_FILE).size > 5 * 1024 * 1024) renameSync(AUDIT_FILE, AUDIT_FILE + '.1'); } catch { /* no file yet */ }
    appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    log.warn({ err: String(err) }, 'exec audit append failed (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// Execution — execFile arg-array in the real repo, NO shell
// ---------------------------------------------------------------------------

export interface RepoRunResult { stdout: string; stderr: string; exitCode: number }

/**
 * Run an already-allowlisted argv against PROJECT_ROOT via execFile (no shell).
 * Caller MUST have validated via checkRepoCommand first.
 */
export function runRepoArgv(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<RepoRunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      argv[0]!,
      argv.slice(1),
      { cwd: PROJECT_ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env, signal },
      (err, stdout, stderr) => {
        if (!err) { resolve({ stdout, stderr, exitCode: 0 }); return; }
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : err.message,
          exitCode: code,
        });
      },
    );
    if (signal) signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}
