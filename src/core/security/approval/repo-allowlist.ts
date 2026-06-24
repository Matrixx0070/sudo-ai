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
 *   1. Quote-aware tokenize: split on unquoted whitespace, honor '…'/"…"
 *      quoting, and reject any UNQUOTED shell operator (chaining/redirection/
 *      substitution/globbing). Quotes are structural and their contents are
 *      literal — safe because step 6 runs via execFile (no shell), so a quoted
 *      `|`/`(` in an rg regex is just argument text, never interpreted.
 *   2. argv[0] must be a bare command name (no path → no symlink/binary swap).
 *   3. No argument may escape the repo (absolute path or `..`) — applied to the
 *      TOKENIZED argv, so a quoted absolute path is still caught.
 *   4. argv[0] + its args must match an explicit read/verify rule.
 *   5. Commands are executed via execFile arg-array (NO shell), so even a
 *      matched command cannot expand or chain.
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT, DATA_DIR } from '../../shared/paths.js';

const log = createLogger('security:repo-allowlist');

/**
 * Operators that imply chaining / redirection / substitution / globbing the
 * execFile path cannot honor. Rejected only when UNQUOTED — inside '…'/"…" they
 * are literal argument content (e.g. an rg regex `"a|b\(\)"`), which is safe
 * because execution never goes through a shell.
 */
const UNQUOTED_OPERATORS = new Set([';', '&', '|', '<', '>', '$', '`', '(', ')', '{', '}', '*', '?', '~', '!', '\\', '\n', '\r']);

interface TokenizeResult { argv?: string[]; error?: string }

/**
 * Shell-like tokenizer WITHOUT expansion. Splits on unquoted whitespace, honors
 * single quotes (fully literal) and double quotes (literal except \" and \\),
 * and rejects any unquoted operator from {@link UNQUOTED_OPERATORS}. Returns the
 * argv, or an error reason. Pure.
 */
function tokenize(cmd: string): TokenizeResult {
  const argv: string[] = [];
  let cur = '';
  let has = false; // current token has content (incl. an explicit empty "")
  let q: '"' | "'" | null = null;

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q === "'") { // single quote — everything literal until the closing '
      if (c === "'") q = null; else cur += c;
      continue;
    }
    if (q === '"') { // double quote — literal except escaped \" and \\
      if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) cur += cmd[++i]!;
      else if (c === '"') q = null;
      else cur += c;
      continue;
    }
    // unquoted
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === ' ' || c === '\t') { if (has) { argv.push(cur); cur = ''; has = false; } continue; }
    if (UNQUOTED_OPERATORS.has(c)) {
      return { error: 'shell operators (pipe/redirect/chaining/substitution/glob) are not allowed in repo-exec — quote them as an argument, or run one plain command' };
    }
    cur += c; has = true;
  }
  if (q) return { error: 'unbalanced quote in repo-exec command' };
  if (has) argv.push(cur);
  return { argv };
}

/** A repo command rule: bare command name → validator for the remaining args. */
interface RepoRule {
  cmd: string;
  ok: (rest: string[]) => boolean;
}

const SCRIPT_VERBS = new Set(['build', 'lint', 'test']);

/**
 * ripgrep flags that spawn an ARBITRARY process — they defeat the no-exec repo
 * boundary as surely as a shell pipe would. `--pre <cmd>` runs a preprocessor
 * per file; `--hostname-bin <cmd>` runs a command to resolve the hostname.
 * Neither has any read/verify use here.
 */
/** rg flags that spawn an arbitrary process (long-only). */
const RG_EXEC_FLAGS = new Set(['--pre', '--hostname-bin']);
/**
 * rg flags that break the repo boundary another way (long forms):
 *   --follow      can follow an in-repo symlink OUT of the repo and read it
 *   --search-zip  spawns external decompressors (gzip/xz/zstd/…) on archives
 * Their short forms -L / -z are handled by the cluster scan below. The safe
 * negations (--no-follow) are NOT in this set, so they stay allowed.
 */
const RG_ESCAPE_LONG = new Set(['--follow', '--search-zip']);

/**
 * Validate rg args: allow read-only search, but reject command-execution and
 * boundary-breaking flags. A flag only counts before a bare `--` operand
 * separator, so searching for the literal text "--pre" still works as
 * `rg -- "--pre" src`. Short-flag clusters (e.g. -Ln, -nz) are scanned for the
 * uppercase L (--follow) and lowercase z (--search-zip) chars — the common
 * lowercase -l (--files-with-matches) is deliberately left alone.
 */
function rgArgsOk(rest: string[]): boolean {
  for (const a of rest) {
    if (a === '--') break;            // everything after `--` is an operand, not a flag
    if (!a.startsWith('-')) continue; // operand (pattern/path), not a flag
    const flag = a.split('=')[0]!;
    if (RG_EXEC_FLAGS.has(flag) || RG_ESCAPE_LONG.has(flag)) return false;
    // Single-dash short cluster: block -L (follow) / -z (search-zip), case-sensitive.
    if (!a.startsWith('--')) {
      const cluster = flag.slice(1); // chars after the single '-'
      if (cluster.includes('L') || cluster.includes('z')) return false;
    }
  }
  return true;
}

/**
 * True if an argument would read/write OUTSIDE the repo: a bare absolute path or
 * `..` operand, OR an absolute/traversal path smuggled in a `--flag=value` form
 * (e.g. `rg --file=/etc/passwd`) which the bare-token check would miss.
 */
function escapesRepo(arg: string): boolean {
  if (arg.startsWith('/') || arg.split('/').includes('..')) return true;
  if (arg.startsWith('-')) {
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      const v = arg.slice(eq + 1);
      if (v.startsWith('/') || v.split('/').includes('..')) return true;
    }
  }
  return false;
}

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
  { cmd: 'git',  ok: r => ['status', 'log', 'diff', 'branch', 'rev-parse', 'describe', 'blame', 'shortlog', 'ls-files'].includes(r[0] ?? '') },
  // Read-only inspection — but reject rg flags that exec (--pre/--hostname-bin)
  // or break the repo boundary (--follow/-L symlink escape, --search-zip/-z).
  { cmd: 'rg',   ok: rgArgsOk },
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

  const tok = tokenize(cmd);
  if (tok.error) return { allowed: false, argv: [], reason: tok.error };
  const argv = tok.argv ?? [];
  if (argv.length === 0) return { allowed: false, argv: [], reason: 'empty command' };
  const head = argv[0]!;

  if (head.includes('/')) {
    return { allowed: false, argv, reason: 'command must be a bare name (no path prefix)' };
  }

  for (const arg of argv.slice(1)) {
    if (escapesRepo(arg)) {
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
 * Daemon runtime env keys that must NOT leak into a repo-exec command. Inheriting
 * the daemon's production env makes env-sensitive tests fail where CI (a clean
 * env) passes — e.g. the gateway suite asserts on `NODE_ENV=production` +
 * `WEB_CHAT_ENABLED`, and GATEWAY_PORT would point a test at the live :18900.
 */
const STRIP_ENV_KEYS: readonly string[] = [
  'NODE_ENV',
  'GATEWAY_PORT', 'GATEWAY_TOKEN',
  'WEB_CHAT_ENABLED', 'WEB_CHAT_TOKEN', 'WEB_CHAT_ALLOWED_ORIGINS',
  'SUDO_AI_CORS_ORIGINS',
];

/**
 * Build the environment for a repo-exec command so it runs CI-like, not in the
 * daemon's production runtime. The base shell env (PATH/HOME/…) is kept so
 * binaries resolve; the toolchain sets its own NODE_ENV (vitest → 'test'). We:
 *   - drop the infra keys above (NODE_ENV, web/gateway config);
 *   - drop ALL `SUDO_*` feature flags — tests assert clean defaults
 *     (e.g. "disabled by default (env flag absent)"), so an enabled flag in the
 *     daemon env makes them fail where CI passes.
 * NOTE: DATA_DIR is intentionally left as-is. Unsetting it aborts a native
 * module on process teardown (SIGABRT), and pinning it to one dir makes
 * DATA_DIR-derived test DBs collide. Tests that key off DATA_DIR (the few
 * DB-heavy suites) therefore aren't reliable via a FULL repo-exec run on a live
 * box — run scoped/file-level tests instead.
 * Exported for testing.
 */
export function repoExecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of STRIP_ENV_KEYS) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('SUDO_')) delete env[k];
  // Silence the app's own pino logger inside repo-exec. `pnpm test/build` import
  // app modules that log at TRACE level (VITEST is set and NODE_ENV is stripped
  // above → the logger picks dev/trace), which floods the command output and
  // buries the line the agent actually needs (e.g. vitest's "Tests N passed"
  // summary). None of the allowlisted commands (test/lint/build/git/rg/ls/wc/pm2)
  // need the app's own logs. Kill-switch: SUDO_REPO_EXEC_QUIET=0 keeps them.
  if (base['SUDO_REPO_EXEC_QUIET'] !== '0') env['LOG_LEVEL'] = 'silent';
  return env;
}

/**
 * Run an already-allowlisted argv against PROJECT_ROOT via execFile (no shell).
 * Caller MUST have validated via checkRepoCommand first.
 */
export function runRepoArgv(argv: string[], timeoutMs: number, signal?: AbortSignal): Promise<RepoRunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      argv[0]!,
      argv.slice(1),
      { cwd: PROJECT_ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: repoExecEnv(), signal },
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
