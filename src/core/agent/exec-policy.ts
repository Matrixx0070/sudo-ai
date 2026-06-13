/**
 * @file exec-policy.ts
 * @description Persistent exec-policy rules (gap #16).
 *
 * Today every dangerous tool call prompts the user — there is no
 * "always allow" that survives the next session. This module adds:
 *
 *   1. A hardcoded DANGEROUS_PREFIXES list that is force-denied regardless
 *      of any user rule (`rm -rf /`, `dd if=`, fork bomb, etc.). The list
 *      cannot be overridden by a user-stored allow rule — that is the
 *      whole point of the ban.
 *   2. An SQLite-backed `ExecPolicyStore` of user rules. A rule binds a
 *      tool name (optionally with a command_prefix substring) to a
 *      decision of `allow` or `deny`. Rules persist across sessions and
 *      restarts; ApprovalManager checks the store before prompting.
 *   3. A small "smart prefix" extractor — given a shell command line, the
 *      first two whitespace tokens become the default rule prefix. The
 *      model can later store finer-grained rules via the store API; the
 *      reply parser uses the smart-prefix default.
 *
 * Design choices (verifier-anticipated):
 *   - deny rules beat allow rules on a tie. If a user has both
 *     `always allow git` and `always deny git push`, `git push` denies.
 *   - The store accepts a duck-typed `better-sqlite3` Database so tests
 *     can construct `new Database(':memory:')` without touching disk.
 *   - rule.expires_at is OPTIONAL — null means "until removed".
 *   - The DANGEROUS_PREFIXES check is a SEPARATE function from the rule
 *     lookup so a caller can short-circuit before any DB I/O.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

// ---------------------------------------------------------------------------
// Dangerous-prefix ban — hardcoded, NEVER overridable
// ---------------------------------------------------------------------------

interface BannedEntry {
  /** Literal substring to scan for. Case-sensitive after leading-WS trim. */
  match: string;
  /**
   * - 'literal': match anywhere as a substring (fork bomb, mkfs.*, dd to dev).
   * - 'terminated': match only when the char after `match` is end-of-string
   *   or a shell terminator (space, tab, ;, &, |, \n, *). Used for filesystem-
   *   root bans so `rm -rf /` doesn't match `rm -rf /home/me`.
   * - 'pipe-shell': match only when the command also pipes to a shell.
   */
  mode: 'literal' | 'terminated' | 'pipe-shell';
}

/**
 * Commands matching any of these entries are force-denied at the policy
 * layer regardless of user rules. This is a "you almost certainly didn't
 * mean to ship this" list, not a full bash-AST audit (that lives in
 * `core/security/bash-ast`). Add with care: every entry here is a hard
 * "no" that even an explicit `always allow` rule will not override.
 */
export const DANGEROUS_PREFIXES: ReadonlyArray<BannedEntry> = Object.freeze([
  { match: 'rm -rf /', mode: 'terminated' },
  // `rm -rf /*` is `terminated` for consistency with the root-slash form
  // — verifier MED #1. Drops `rm -rf /*/subdir` from the ban but still
  // catches `rm -rf /* && ...`, `rm -rf /*;`, and a bare `rm -rf /*`.
  { match: 'rm -rf /*', mode: 'terminated' },
  { match: 'rm -rf ~', mode: 'literal' },
  { match: 'rm -rf $HOME', mode: 'literal' },
  { match: 'rm -fr /', mode: 'terminated' },
  { match: 'rm -fr /*', mode: 'terminated' },
  { match: 'rm --recursive --force /', mode: 'terminated' },
  // GNU coreutils explicit-confirmation bypass.
  { match: 'rm -rf --no-preserve-root /', mode: 'terminated' },
  { match: ':(){:|:&};:', mode: 'literal' },          // classic fork bomb
  { match: ':(){ :|:& };:', mode: 'literal' },        // spaced fork bomb
  { match: 'dd if=/dev/zero of=/dev/', mode: 'literal' },
  { match: 'dd if=/dev/random of=/dev/', mode: 'literal' },
  { match: 'dd if=/dev/urandom of=/dev/', mode: 'literal' },
  { match: 'mkfs.', mode: 'literal' },
  { match: 'mkfs -', mode: 'literal' },
  { match: 'chmod -R 777 /', mode: 'terminated' },
  { match: 'chown -R root /', mode: 'terminated' },
  // Block-device redirection — verifier MED #2 (broader than `> /dev/sda`).
  // Covers `> /dev/sda`, `>/dev/sda`, `>> /dev/sda`, `> /dev/nvme0n1`, etc.
  // Pulled out into its own regex below since the mode dispatch only does
  // literal substring matching.
  { match: '> /dev/sda', mode: 'literal' },
  { match: '>/dev/sda', mode: 'literal' },
  { match: '> /dev/nvme', mode: 'literal' },
  { match: '>/dev/nvme', mode: 'literal' },
  { match: 'curl http', mode: 'pipe-shell' },
  { match: 'curl https', mode: 'pipe-shell' },
  { match: 'wget http', mode: 'pipe-shell' },
  { match: 'wget https', mode: 'pipe-shell' },
] as const);

/**
 * Substring check that succeeds only when the char following the match is a
 * shell terminator — end-of-string, whitespace, or one of `; & | \n *`.
 * Prevents `rm -rf /` from matching `rm -rf /home/me`, while still matching
 * `rm -rf / && echo done`, `rm -rf /;`, and a bare `rm -rf /`.
 */
function isTerminated(haystack: string, banned: string, idx: number): boolean {
  const end = idx + banned.length;
  if (end >= haystack.length) return true;
  const next = haystack.charCodeAt(end);
  // NB: `*` was previously a terminator so `rm -rf /` would catch
  // `rm -rf /*`, but that also caught `rm -rf /*/subdir` (a path with a
  // wildcard segment). The explicit `rm -rf /*` ban entry now handles the
  // wildcard form, so `*` is intentionally NOT a terminator here.
  return (
    next === 0x20 || // space
    next === 0x09 || // tab
    next === 0x3b || // ;
    next === 0x26 || // &
    next === 0x7c || // |
    next === 0x0a    // \n
  );
}

const PIPE_TO_SHELL_RE = /\|\s*(sh|bash|zsh|sudo\s+sh|sudo\s+bash)\b/;

/**
 * Return true when the (tool, params) pair contains a banned command. The
 * pipe-to-shell check is only fired if the command also pipes to sh/bash/
 * sudo sh so legitimate one-off fetches (e.g. `curl https://x -o page.html`)
 * are not blocked.
 */
export function isDangerousCommand(toolName: string, params: Record<string, unknown>): boolean {
  const command = typeof params['command'] === 'string'
    ? (params['command'] as string).replace(/^\s+/, '')
    : '';
  if (!command) return false;

  for (const entry of DANGEROUS_PREFIXES) {
    const idx = command.indexOf(entry.match);
    if (idx === -1) continue;
    if (entry.mode === 'pipe-shell') {
      if (PIPE_TO_SHELL_RE.test(command)) return true;
      continue;
    }
    if (entry.mode === 'terminated') {
      if (!isTerminated(command, entry.match, idx)) continue;
    }
    return true;
  }
  // Tool-name-only bans could live here; today the list is empty but the
  // seam is here for future additions (e.g. ban `system.exec` outright).
  void toolName;
  return false;
}

// ---------------------------------------------------------------------------
// Rule shape
// ---------------------------------------------------------------------------

export type PolicyDecision = 'allow' | 'deny';

export interface PolicyRule {
  /** Row id (SQLite rowid). Present only on rules read back from the store. */
  id?: number;
  /** Exact tool name match (e.g. "system.exec"). */
  toolName: string;
  /**
   * Optional command-prefix substring. When set, the rule matches only
   * when params.command (trimmed) startsWith this value. When null, the
   * rule matches any params on the named tool.
   */
  commandPrefix: string | null;
  decision: PolicyDecision;
  /** ISO-8601 timestamp; auto-set by addRule(). */
  createdAt?: string;
  /** ISO-8601 timestamp; rule is treated as absent past this point. */
  expiresAt?: string | null;
  /** Where the rule came from (e.g. "user_reply", "manual"). */
  source?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS exec_policy_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    command_prefix TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_exec_policy_rules_tool_name ON exec_policy_rules (tool_name);
`;

export class ExecPolicyStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    if (!db || typeof db.prepare !== 'function') {
      throw new TypeError('ExecPolicyStore: db must be a better-sqlite3 Database');
    }
    this.db = db;
    this.db.exec(CREATE_TABLE_SQL);
  }

  /**
   * Persist a rule. Returns the inserted rule's row id. Duplicate
   * (toolName, commandPrefix, decision) is allowed — multiple sources can
   * record the same rule and removal is row-scoped via removeRule(id).
   */
  addRule(rule: PolicyRule): number {
    if (!rule.toolName || typeof rule.toolName !== 'string') {
      throw new TypeError('addRule: toolName must be non-empty');
    }
    if (rule.decision !== 'allow' && rule.decision !== 'deny') {
      throw new TypeError(`addRule: decision must be 'allow' or 'deny', got ${rule.decision}`);
    }
    const stmt = this.db.prepare(
      'INSERT INTO exec_policy_rules (tool_name, command_prefix, decision, created_at, expires_at, source) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
    );
    const createdAt = rule.createdAt ?? new Date().toISOString();
    const info = stmt.run(
      rule.toolName,
      rule.commandPrefix ?? null,
      rule.decision,
      createdAt,
      rule.expiresAt ?? null,
      rule.source ?? null,
    );
    return Number(info.lastInsertRowid);
  }

  /** Remove a single rule by id. Returns true if a row was removed. */
  removeRule(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM exec_policy_rules WHERE id = ?');
    return stmt.run(id).changes > 0;
  }

  /** List all rules (newest first). Expired rules are filtered out. */
  listRules(): PolicyRule[] {
    const nowIso = new Date().toISOString();
    const rows = this.db
      .prepare(
        'SELECT id, tool_name, command_prefix, decision, created_at, expires_at, source ' +
        'FROM exec_policy_rules ' +
        'WHERE expires_at IS NULL OR expires_at > ? ' +
        'ORDER BY id DESC',
      )
      .all(nowIso) as Array<{
        id: number;
        tool_name: string;
        command_prefix: string | null;
        decision: PolicyDecision;
        created_at: string;
        expires_at: string | null;
        source: string | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      toolName: r.tool_name,
      commandPrefix: r.command_prefix,
      decision: r.decision,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      source: r.source ?? undefined,
    }));
  }

  /**
   * Resolve the effective decision for (toolName, params), or null when no
   * rule matches. Rule precedence:
   *   1. Drop expired rules.
   *   2. Of all rules with matching toolName + matching prefix (or null
   *      prefix), return the most specific one (longest prefix wins).
   *   3. If two rules tie on prefix length, deny beats allow.
   */
  findMatchingRule(toolName: string, params: Record<string, unknown>): PolicyRule | null {
    const command = typeof params['command'] === 'string'
      ? (params['command'] as string).replace(/^\s+/, '')
      : '';
    const candidates = this.listRules().filter((r) => r.toolName === toolName);
    let best: PolicyRule | null = null;
    let bestLen = -1;
    for (const r of candidates) {
      if (r.commandPrefix !== null) {
        if (!command.startsWith(r.commandPrefix)) continue;
      }
      const prefixLen = r.commandPrefix?.length ?? 0;
      if (prefixLen > bestLen) {
        best = r;
        bestLen = prefixLen;
      } else if (prefixLen === bestLen && r.decision === 'deny' && best?.decision === 'allow') {
        // deny wins on tie
        best = r;
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Smart prefix extraction
// ---------------------------------------------------------------------------

/**
 * Derive a "smart" command prefix from the params of a tool call. The intent
 * is that the user replying "ALWAYS" once gets a useful, narrow rule —
 * "always allow git status" rather than "always allow every shell command".
 *
 * Heuristic: first two whitespace-separated tokens of params.command,
 * trimmed. If the command has only one token, that token is used. If
 * params.command is missing or empty, returns null so the rule matches the
 * whole tool.
 */
export function extractSmartPrefix(params: Record<string, unknown>): string | null {
  const raw = typeof params['command'] === 'string' ? (params['command'] as string) : '';
  const trimmed = raw.replace(/^\s+/, '');
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/, 3);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return tokens[0]!;
  return `${tokens[0]} ${tokens[1]}`;
}
