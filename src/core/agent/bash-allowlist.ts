/**
 * @file bash-allowlist.ts
 * @description Q2 — static safe-command fast-path that skips approval prompts.
 *
 * Opt-in via SUDO_BASH_ALLOWLIST_FASTPATH=1. When enabled, the ApprovalManager
 * runs every command-shaped tool call through this STATIC classifier before
 * either the persistent policy store or the user prompt. Eligibility is
 * deliberately CONSERVATIVE: false negatives (prompt the user) are fine; false
 * positives (skip the prompt for an unsafe command) are not.
 *
 * Rules (all must hold):
 *   1. No shell metacharacters at all — `;`, `&`, `|`, `<`, `>`, backticks,
 *      `$`, `(`, `)`. This rejects chaining, redirection, command
 *      substitution, subshells, piping, and variable expansion in one shot.
 *   2. First token (the program head) must be in ALLOWLIST_HEADS.
 *   3. For `git`, the subcommand must be in GIT_READONLY_SUBCMDS.
 *
 * Defense-in-depth: the dangerous-prefix check (DANGEROUS_PREFIXES in
 * exec-policy.ts) runs BEFORE this fast-path inside ApprovalManager — anything
 * force-denied stays force-denied. The fast-path never overrides a hard ban.
 *
 * Kill-switch: unset SUDO_BASH_ALLOWLIST_FASTPATH or set to '0'.
 *
 * Out of scope (deliberately): aliases, sourced functions, multi-line
 * scripts, and quoting-aware tokenization. The fast-path either matches a
 * trivially-safe single command or falls through to the prompt — there is no
 * partial-credit middle ground.
 */

/** Flag check at call time (not module load) so tests can toggle the env. */
export function isBashAllowlistFastPathEnabled(): boolean {
  return process.env['SUDO_BASH_ALLOWLIST_FASTPATH'] === '1';
}

/**
 * Separate opt-in for safe, reversible service restarts (`pm2 restart x`,
 * `systemctl restart x`). Mutating, so it is NOT part of the read-only
 * fast-path above and carries its own kill-switch. Enables the agent to
 * self-heal the daemon without a human prompt while keeping every other
 * mutating command gated.
 *
 * SUDO_BLOCK_AGENT_RESTART=1 (the #923 kill-switch) takes precedence: when the
 * operator blocks agent-initiated restarts, this fast-path is closed too.
 */
export function isServiceRestartFastPathEnabled(): boolean {
  // Master kill-switch: if agent-initiated restarts are blocked (#923), the bash
  // restart fast-path is closed too — otherwise `pm2 restart` via bash would
  // bypass SUDO_BLOCK_AGENT_RESTART (which only gates scheduleDetachedRestart).
  if (process.env['SUDO_BLOCK_AGENT_RESTART'] === '1') return false;
  return process.env['SUDO_EXEC_SAFE_RESTART'] === '1';
}

/**
 * Program heads whose default operation is read-only. Commands whose head is
 * not in this set fall through to the prompt — extending the allowlist is a
 * code change, not a config change, by design.
 */
const ALLOWLIST_HEADS: ReadonlySet<string> = new Set([
  // process / identity / system info
  'ls', 'pwd', 'whoami', 'id', 'uname', 'date', 'hostname', 'uptime',
  // file reading
  'cat', 'head', 'tail', 'wc', 'stat', 'file', 'tree',
  // search
  'grep', 'egrep', 'fgrep', 'rg',
  // text manipulation (read-only on stdin → stdout)
  'echo', 'printf', 'sort', 'uniq', 'cut',
  // resolution / introspection
  'which', 'type',
  // disk / process listing
  'df', 'du', 'ps', 'free',
  // env (read-only when no -u/=key arg, but `>` redirection is already vetoed)
  'env',
  // git — further constrained below
  'git',
  // systemctl — further constrained to read-only subcommands below
  'systemctl',
  // boolean / trivial
  'true', 'false',
]);

/**
 * Subcommands of `git` that are strictly read-only. `config` is excluded —
 * `git config foo bar` writes; the read-only variant `git config --get` would
 * need flag-aware checking, not worth it for v1.
 */
const GIT_READONLY_SUBCMDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
  'reflog', 'blame', 'shortlog', 'describe',
  'ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'rev-list',
]);

/**
 * Subcommands of `systemctl` that only read state. Excludes every mutating
 * verb (`start`, `stop`, `restart`, `enable`, `disable`, `mask`, …); safe
 * restarts go through the separate isSafeServiceRestart() path, not here.
 */
const SYSTEMCTL_READONLY_SUBCMDS: ReadonlySet<string> = new Set([
  'status', 'is-active', 'is-enabled', 'is-failed',
  'show', 'cat', 'list-units', 'list-unit-files', 'list-timers',
]);

/**
 * Any of these in the command body forces the fall-through path. Includes
 * shell separators, pipes, redirections, command/process substitution,
 * subshells, variable expansion, AND quote characters. A single occurrence
 * anywhere disqualifies.
 *
 * Why quotes are vetoed: token-splitting by `/\s+/` is not quote-aware, so a
 * command like `cat "file with space"` tokenizes to `['cat', '"file', 'with',
 * 'space"']` — the head check still passes, but the args are wrong. Rather
 * than ship quote-aware tokenization for a v1 fast-path, we reject any
 * quoted command and let it fall through to the prompt. False negative,
 * not a false positive — the right side of the safety tradeoff.
 */
const FORBIDDEN_METACHARS = /[;&|<>`$()"']/;

/**
 * Pure, static eligibility check — no side effects, no I/O, no parser state.
 */
export function isAllowlistEligible(command: string | undefined): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (FORBIDDEN_METACHARS.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  if (!head || !ALLOWLIST_HEADS.has(head)) return false;
  if (head === 'git') {
    const sub = tokens[1];
    if (!sub || !GIT_READONLY_SUBCMDS.has(sub)) return false;
  }
  if (head === 'systemctl') {
    const sub = tokens[1];
    if (!sub || !SYSTEMCTL_READONLY_SUBCMDS.has(sub)) return false;
  }
  return true;
}

/** Service managers whose restart/reload is a safe, reversible action. */
const RESTART_HEADS: ReadonlySet<string> = new Set(['pm2', 'systemctl']);
/** Only restart/reload — never start/stop/delete/kill/enable/disable. */
const RESTART_SUBCMDS: ReadonlySet<string> = new Set(['restart', 'reload']);
/**
 * A service/unit identifier: letters, digits, and `. _ @ : -` only. No slash
 * (no paths), no glob, no metacharacters (already vetoed). Rejects `all`-style
 * wildcards implicitly only if not a bare word — `all` itself is permitted for
 * pm2 since restarting all managed processes is still a reversible action.
 */
const SERVICE_TOKEN_RE = /^[A-Za-z0-9._@:-]+$/;

/**
 * Strictly match a safe service restart: exactly `<pm2|systemctl>
 * <restart|reload> <unit>`. Three tokens, no shell metacharacters, simple unit
 * token. Mutating but reversible — gated by isServiceRestartFastPathEnabled().
 * Anything outside this exact shape (extra args, flags, stop/delete) falls
 * through to the normal approval prompt.
 */
export function isSafeServiceRestart(command: string | undefined): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (FORBIDDEN_METACHARS.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 3) return false;
  const [head, sub, unit] = tokens;
  if (!head || !RESTART_HEADS.has(head)) return false;
  if (!sub || !RESTART_SUBCMDS.has(sub)) return false;
  if (!unit || !SERVICE_TOKEN_RE.test(unit)) return false;
  return true;
}

/**
 * Extract a command string from arbitrary tool params. Most command-shaped
 * tool calls land it on `params.command`; tools that don't carry a command
 * in that field opt out of the fast-path naturally (returns undefined).
 */
export function extractCommand(params: Record<string, unknown>): string | undefined {
  const cmd = params['command'];
  return typeof cmd === 'string' ? cmd : undefined;
}
