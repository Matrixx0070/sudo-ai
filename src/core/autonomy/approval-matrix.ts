/**
 * @file approval-matrix.ts
 * @description Permission boundary system for autonomous operations.
 *
 * Defines four tiers of autonomy:
 *   - auto     : Execute without asking (reads, safe queries, diagnostics)
 *   - notify   : Execute then notify owner (sends email, posts content, moves small money)
 *   - confirm  : Wait for owner approval (large transactions, destructive ops, code deploy)
 *   - never    : Blocked regardless (no-go list)
 *
 * Integrates with VetoGate: confirm-tier actions trigger the veto consensus.
 * Owner preferences are persisted in SQLite and can be updated at runtime.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('autonomy:approval-matrix');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalTier = 'auto' | 'notify' | 'confirm' | 'never';

export interface ApprovalRule {
  id: string;
  pattern: string;        // glob or exact tool name, e.g. "browser.*" or "system.exec"
  tier: ApprovalTier;
  reason?: string;        // why this rule exists
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalDecision {
  tier: ApprovalTier;
  ruleId: string;
  reason: string;
}

export interface OwnerPreference {
  key: string;
  value: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Default rules (factory defaults — safe out-of-the-box)
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: Omit<ApprovalRule, 'id' | 'createdAt' | 'updatedAt'>[] = [
  // === AUTO ===
  { pattern: 'browser.search',     tier: 'auto', reason: 'Read-only web search' },
  { pattern: 'browser.navigate',   tier: 'auto', reason: 'Read-only navigation' },
  { pattern: 'coder.read-file',    tier: 'auto', reason: 'Read-only file access' },
  { pattern: 'coder.multi-read',   tier: 'auto', reason: 'Read-only file access' },
  { pattern: 'meta.health-check',  tier: 'auto', reason: 'Self-diagnostics' },
  { pattern: 'system.self-diagnostic', tier: 'auto', reason: 'System diagnostics' },
  { pattern: 'custom.ping',        tier: 'auto', reason: 'Health ping' },
  { pattern: 'intelligence.daily-brief', tier: 'auto', reason: 'Read-only briefing' },
  { pattern: 'research.web-summary', tier: 'auto', reason: 'Read-only research' },
  { pattern: 'content.viral-hook', tier: 'auto', reason: 'Content generation (draft)' },
  { pattern: 'content.write-article', tier: 'auto', reason: 'Content generation (draft)' },

  // === NOTIFY ===
  { pattern: 'meta.self-modify',   tier: 'notify', reason: 'Code changes — notify after' },
  { pattern: 'meta.self-update',   tier: 'notify', reason: 'Self-update — notify after' },
  { pattern: 'meta.service-control', tier: 'notify', reason: 'Service restart — notify after' },
  { pattern: 'video.remotion-msa', tier: 'notify', reason: 'Content publish — notify after' },
  { pattern: 'system.exec',        tier: 'notify', reason: 'Shell commands — notify after' },

  // === CONFIRM ===
  { pattern: 'coder.smart-edit',   tier: 'confirm', reason: 'Destructive file edits' },
  { pattern: 'coder.edit-file',    tier: 'confirm', reason: 'Destructive file edits' },
  { pattern: 'coder.write-file',   tier: 'confirm', reason: 'Destructive file writes' },
  { pattern: 'meta.task-manager', tier: 'confirm', reason: 'Task queue mutations' },

  // === NEVER ===
  { pattern: 'system.exec:rm -rf', tier: 'never', reason: 'Destructive deletion' },
  { pattern: 'system.exec:shutdown', tier: 'never', reason: 'System shutdown' },
  { pattern: 'system.exec:reboot',   tier: 'never', reason: 'System reboot' },
  { pattern: 'system.exec:mkfs',     tier: 'never', reason: 'Filesystem format' },
  { pattern: 'system.exec:dd if=',  tier: 'never', reason: 'Raw disk write' },

  // P1 cross-platform control (IComputerUse) - per SOUL: owner's will absolute, fully uncensored, full autonomous mode, zero manual approval, "I own the system"
  { pattern: 'control.*', tier: 'auto', reason: 'Full cross-platform system control (exec/browser/file/gui/desktop) per SOUL owner loyalty absolute + full autonomous uncensored power' },
  { pattern: 'control.exec:rm -rf', tier: 'never', reason: 'Destructive (never per matrix, but SOUL allows owner override via prefs)' },
  { pattern: 'control.file.write', tier: 'notify', reason: 'File mutate - notify' },
  { pattern: 'control.gui.*', tier: 'auto', reason: 'GUI/desktop full power (SOUL)' },
];

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

export const APPROVAL_SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS approval_rules (
    id         TEXT PRIMARY KEY,
    pattern    TEXT NOT NULL UNIQUE,
    tier       TEXT NOT NULL CHECK(tier IN ('auto','notify','confirm','never')),
    reason     TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS owner_preferences (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_approval_rules_tier ON approval_rules(tier)`,
];

// ---------------------------------------------------------------------------
// ApprovalMatrix class
// ---------------------------------------------------------------------------

export class ApprovalMatrix {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this._initSchema();
    this._seedDefaults();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Classify a tool call against the matrix.
   * Returns the most specific matching rule (longest pattern wins).
   */
  classify(toolName: string, args?: Record<string, unknown>): ApprovalDecision {
    const rules = this.listRules();
    let best: ApprovalRule | undefined;
    let bestSpecificity = -1;

    for (const rule of rules) {
      if (this._matches(rule.pattern, toolName, args)) {
        const specificity = rule.pattern.length;
        if (specificity > bestSpecificity) {
          best = rule;
          bestSpecificity = specificity;
        }
      }
    }

    if (best) {
      return { tier: best.tier, ruleId: best.id, reason: best.reason ?? 'Matched rule' };
    }

    // Default fallback: unknown tools require confirmation
    return { tier: 'confirm', ruleId: 'default', reason: 'No matching rule — default to confirm' };
  }

  /** Check if a tool call is allowed to proceed without blocking. */
  isAutoApproved(toolName: string, args?: Record<string, unknown>): boolean {
    return this.classify(toolName, args).tier === 'auto';
  }

  /** Check if a tool call requires owner confirmation. */
  needsConfirmation(toolName: string, args?: Record<string, unknown>): boolean {
    return this.classify(toolName, args).tier === 'confirm';
  }

  /** Check if a tool call is blocked. */
  isBlocked(toolName: string, args?: Record<string, unknown>): boolean {
    return this.classify(toolName, args).tier === 'never';
  }

  /** List all rules, ordered by tier then pattern. */
  listRules(): ApprovalRule[] {
    const rows = this.db.prepare(
      `SELECT * FROM approval_rules ORDER BY tier, pattern`
    ).all() as Array<{
      id: string; pattern: string; tier: string; reason: string | null;
      created_at: string; updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      tier: r.tier as ApprovalTier,
      reason: r.reason ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Add or update a rule. */
  upsertRule(pattern: string, tier: ApprovalTier, reason?: string): ApprovalRule {
    const id = this._patternToId(pattern);
    const now = new Date().toISOString();

    this.db.prepare(
      `INSERT INTO approval_rules (id, pattern, tier, reason, created_at, updated_at)
       VALUES (@id, @pattern, @tier, @reason, @now, @now)
       ON CONFLICT(id) DO UPDATE SET
         tier = excluded.tier,
         reason = excluded.reason,
         updated_at = excluded.updated_at`
    ).run({ id, pattern, tier, reason: reason ?? null, now });

    log.info({ pattern, tier }, 'Approval rule upserted');
    return { id, pattern, tier, reason, createdAt: now, updatedAt: now };
  }

  /** Remove a rule by pattern. */
  removeRule(pattern: string): boolean {
    const id = this._patternToId(pattern);
    const info = this.db.prepare(`DELETE FROM approval_rules WHERE id = @id`).run({ id });
    return info.changes > 0;
  }

  /** Reset to factory defaults. */
  resetToDefaults(): void {
    this.db.prepare(`DELETE FROM approval_rules`).run();
    this._seedDefaults();
    log.info('Approval matrix reset to defaults');
  }

  // -------------------------------------------------------------------------
  // Owner preferences
  // -------------------------------------------------------------------------

  getPreference(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM owner_preferences WHERE key = @key`).get({ key }) as
      { value: string } | undefined;
    return row?.value;
  }

  setPreference(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO owner_preferences (key, value, updated_at)
       VALUES (@key, @value, @now)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    ).run({ key, value, now });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _initSchema(): void {
    for (const ddl of APPROVAL_SCHEMA_DDL) {
      this.db.exec(ddl);
    }
  }

  private _seedDefaults(): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS cnt FROM approval_rules`).get() as { cnt: number };
    if (count.cnt > 0) return;

    const stmt = this.db.prepare(
      `INSERT INTO approval_rules (id, pattern, tier, reason, created_at, updated_at)
       VALUES (@id, @pattern, @tier, @reason, @now, @now)`
    );

    const now = new Date().toISOString();
    for (const rule of DEFAULT_RULES) {
      stmt.run({
        id: this._patternToId(rule.pattern),
        pattern: rule.pattern,
        tier: rule.tier,
        reason: rule.reason ?? null,
        now,
      });
    }

    log.info({ count: DEFAULT_RULES.length }, 'Seeded default approval rules');
  }

  private _patternToId(pattern: string): string {
    // Simple hash for stable IDs
    let hash = 0;
    for (let i = 0; i < pattern.length; i++) {
      hash = ((hash << 5) - hash) + pattern.charCodeAt(i);
      hash |= 0;
    }
    return `rule_${Math.abs(hash).toString(36)}`;
  }

  private _matches(pattern: string, toolName: string, args?: Record<string, unknown>): boolean {
    // Exact match
    if (pattern === toolName) return true;

    // Glob: tool.*
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      if (toolName.startsWith(prefix + '.')) return true;
    }

    // Pattern with arg constraint: "system.exec:rm -rf" or "control.exec:rm -rf"
    if (pattern.includes(':') && toolName === pattern.split(':')[0]) {
      const argConstraint = pattern.split(':').slice(1).join(':');
      // P1 fix: support cmd (control) + command (legacy); also file sub-op via toolName if caller passes 'control.file.write' style
      const command = (args?.cmd as string | undefined) || (args?.command as string | undefined);
      if (command && this._commandMatchesConstraint(command, argConstraint)) return true;
    }

    return false;
  }

  /**
   * Match a shell command against a safety constraint (e.g. "rm -rf", "dd if=").
   *
   * Substring matching alone is trivially bypassed by semantically-identical
   * variations (extra whitespace, reordered/combined flags, binary path
   * prefixes such as "/bin/rm"), which would let "never"-tier deletions fall
   * through to a broader auto/notify rule. We therefore normalize both the
   * command and the constraint into canonical tokens (lowercased, whitespace
   * collapsed, leading binary path stripped, clustered short flags such as
   * "-rf" / "-fr" expanded into a set) and require every constraint token
   * to be present. We bias toward blocking: any match keeps the substring
   * fallback so nothing previously caught is now missed.
   */
  private _commandMatchesConstraint(command: string, constraint: string): boolean {
    // Backwards-compatible substring check — never narrows existing matches.
    if (command.includes(constraint)) return true;

    const cmdTokens = this._canonicalizeCommand(command);
    const conTokens = this._canonicalizeCommand(constraint);
    if (conTokens.length === 0) return false;

    // The first constraint token is the program (basename); it must appear as a
    // command token. Every remaining constraint token (flags/operands) must
    // also be present in the command's token set.
    const cmdSet = new Set(cmdTokens);
    return conTokens.every((t) => cmdSet.has(t));
  }

  /**
   * Break a command string into canonical tokens for safety matching.
   * - lowercases and collapses whitespace
   * - strips any directory prefix on the first (program) token: "/bin/rm" -> "rm"
   * - expands clustered short flags into individual letters:
   *   "-rf" -> "-r", "-f"  (so "-rf", "-fr", "-r -f" all canonicalize alike)
   * - maps the common long forms of destructive flags to their short
   *   equivalents ("--recursive" -> "-r", "--force" -> "-f")
   * Operand tokens such as "if=" are preserved verbatim.
   */
  private _canonicalizeCommand(input: string): string[] {
    const longFlagMap: Record<string, string> = {
      '--recursive': '-r',
      '--force': '-f',
    };
    const raw = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      let tok = raw[i];
      if (i === 0) {
        // Strip binary path prefix: "/usr/bin/rm" / "./rm" -> "rm"
        const slash = tok.lastIndexOf('/');
        if (slash >= 0) tok = tok.slice(slash + 1);
      }
      if (longFlagMap[tok]) {
        // Normalize known destructive long flags to their short form.
        out.push(longFlagMap[tok]);
      } else if (/^-[a-z]{2,}$/.test(tok)) {
        // Expand clustered single-dash short flags (e.g. "-rf"); leave
        // long flags and operands ("if=") intact.
        for (const ch of tok.slice(1)) out.push(`-${ch}`);
      } else {
        out.push(tok);
      }
    }
    return out;
  }
}
