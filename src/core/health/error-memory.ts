/**
 * @file error-memory.ts
 * @description Error Memory — "Have I seen this before? What fixed it?"
 *
 * Stores normalized error signatures in mind.db so repeated errors can be
 * recognized and previously-working fixes can be suggested automatically.
 *
 * Table: error_memory (id, error_signature, error_message, category,
 *   fix_applied, fix_worked, occurrences, first_seen, last_seen)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'api_rate_limit'
  | 'auth_expired'
  | 'network'
  | 'disk'
  | 'code_bug'
  | 'unknown';

export interface PastError {
  id: number;
  errorSignature: string;
  errorMessage: string;
  category: ErrorCategory;
  fixApplied: string | null;
  fixWorked: boolean;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface ErrorMemoryRow {
  id: number;
  error_signature: string;
  error_message: string;
  category: string;
  fix_applied: string | null;
  fix_worked: number;
  occurrences: number;
  first_seen: string;
  last_seen: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH = '/root/sudo-ai-v4/data/mind.db';

/**
 * Tokens that vary between occurrences of the same logical error.
 * Stripping them yields a stable "signature" for dedup matching.
 *
 * Examples: file paths, line numbers, hex addresses, UUIDs, timestamps,
 * HTTP status codes embedded in messages, numeric IDs.
 */
const VOLATILE_PATTERNS: RegExp[] = [
  /0x[0-9a-fA-F]+/g,                           // hex addresses
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // UUIDs
  /\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g,             // ISO timestamps
  /\b\d{10,}\b/g,                               // unix timestamps / large IDs
  /(?:\/[^/\s]+)+/g,                            // absolute file paths
  /\bline\s+\d+\b/gi,                           // "line 42"
  /\bcol(?:umn)?\s+\d+\b/gi,                    // "col 12"
  /\b\d+\s*ms\b/gi,                             // "340ms"
  /\bport\s+\d+\b/gi,                           // "port 3000"
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,   // IP addresses
  /\b\d+\b/g,                                   // bare numbers (last — broadest)
];

const log = createLogger('health:error-memory');

// ---------------------------------------------------------------------------
// ErrorMemory
// ---------------------------------------------------------------------------

export class ErrorMemory {
  private readonly db: Database.Database;

  constructor(dbPath = DB_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._ensureSchema();

    log.info({ dbPath }, 'ErrorMemory initialised');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record an error occurrence. If an identical signature already exists,
   * increments occurrences and updates last_seen instead of inserting a new row.
   *
   * @param error    The Error object to remember.
   * @param category Broad category for grouping/routing fixes.
   * @param fix      Optional description of the fix that was attempted.
   */
  remember(error: Error, category: ErrorCategory, fix?: string): void {
    if (!(error instanceof Error)) {
      log.warn('ErrorMemory.remember called with non-Error value');
      return;
    }

    const sig = this._signature(error);
    const now = new Date().toISOString();

    const existing = this.db
      .prepare<{ sig: string }, ErrorMemoryRow>(
        'SELECT * FROM error_memory WHERE error_signature = :sig',
      )
      .get({ sig });

    if (existing) {
      this.db
        .prepare(`
          UPDATE error_memory
          SET occurrences  = occurrences + 1,
              last_seen    = :now,
              fix_applied  = COALESCE(:fix, fix_applied)
          WHERE id = :id
        `)
        .run({ now, fix: fix ?? null, id: existing.id });

      log.debug({ id: existing.id, occurrences: existing.occurrences + 1 }, 'Error occurrence incremented');
    } else {
      this.db
        .prepare(`
          INSERT INTO error_memory
            (error_signature, error_message, category, fix_applied, first_seen, last_seen)
          VALUES
            (:sig, :msg, :cat, :fix, :now, :now)
        `)
        .run({
          sig,
          msg: error.message.slice(0, 2000),
          cat: category,
          fix: fix ?? null,
          now,
        });

      log.debug({ category, sig }, 'New error signature recorded');
    }
  }

  /**
   * Find the most recent past error whose signature matches this one.
   * Returns null when no match exists.
   */
  findSimilar(error: Error): PastError | null {
    if (!(error instanceof Error)) return null;

    const sig = this._signature(error);
    const row = this.db
      .prepare<{ sig: string }, ErrorMemoryRow>(
        'SELECT * FROM error_memory WHERE error_signature = :sig ORDER BY last_seen DESC LIMIT 1',
      )
      .get({ sig });

    return row ? this._rowToModel(row) : null;
  }

  /**
   * Return a suggested fix string if a similar error was previously fixed.
   * Returns null when no working fix is on record.
   */
  suggestFix(error: Error): string | null {
    if (!(error instanceof Error)) return null;

    const sig = this._signature(error);

    // Prefer a fix that was previously confirmed to work.
    const worked = this.db
      .prepare<{ sig: string }, ErrorMemoryRow>(`
        SELECT * FROM error_memory
        WHERE error_signature = :sig
          AND fix_worked = 1
          AND fix_applied IS NOT NULL
        ORDER BY last_seen DESC
        LIMIT 1
      `)
      .get({ sig });

    if (worked?.fix_applied) return worked.fix_applied;

    // Fall back to any recorded fix even if not confirmed.
    const fallback = this.db
      .prepare<{ sig: string }, ErrorMemoryRow>(`
        SELECT * FROM error_memory
        WHERE error_signature = :sig
          AND fix_applied IS NOT NULL
        ORDER BY occurrences DESC, last_seen DESC
        LIMIT 1
      `)
      .get({ sig });

    return fallback?.fix_applied ?? null;
  }

  /**
   * Mark a previously recorded error's fix as having worked.
   * @param id The `id` of the error_memory row (from PastError.id).
   */
  markFixWorked(id: number): void {
    if (!Number.isInteger(id) || id < 1) {
      log.warn({ id }, 'markFixWorked: invalid id');
      return;
    }

    const info = this.db
      .prepare<{ id: number }>('UPDATE error_memory SET fix_worked = 1 WHERE id = :id')
      .run({ id });

    if (info.changes === 0) {
      log.warn({ id }, 'markFixWorked: no row found');
    } else {
      log.info({ id }, 'Fix marked as worked');
    }
  }

  /** Close the underlying DB connection. */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Create the error_memory table if it does not exist. */
  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS error_memory (
        id              INTEGER PRIMARY KEY,
        error_signature TEXT    NOT NULL,
        error_message   TEXT    NOT NULL,
        category        TEXT    NOT NULL,
        fix_applied     TEXT,
        fix_worked      INTEGER NOT NULL DEFAULT 0,
        occurrences     INTEGER NOT NULL DEFAULT 1,
        first_seen      TEXT    NOT NULL,
        last_seen       TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_error_memory_sig ON error_memory(error_signature);
      CREATE INDEX IF NOT EXISTS idx_error_memory_cat ON error_memory(category);

      CREATE TABLE IF NOT EXISTS auto_fix_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_number INTEGER NOT NULL,
        error_signature TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        fixed_at TEXT,
        commit_sha TEXT,
        pr_number INTEGER,
        deployment_sha TEXT,
        deployed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auto_fix_issue ON auto_fix_log(issue_number);
      CREATE INDEX IF NOT EXISTS idx_auto_fix_signature ON auto_fix_log(error_signature);
      CREATE INDEX IF NOT EXISTS idx_auto_fix_status ON auto_fix_log(status);

      CREATE TABLE IF NOT EXISTS auto_fix_rate_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        executed_at TEXT NOT NULL,
        issue_number INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_log_time ON auto_fix_rate_log(executed_at);
    `);
  }

  /**
   * Compute a stable, normalized signature from an error message by stripping
   * volatile tokens (IDs, timestamps, paths, numbers).
   */
  private _signature(error: Error): string {
    let msg = (error.message ?? String(error)).toLowerCase().trim();
    for (const pattern of VOLATILE_PATTERNS) {
      msg = msg.replace(pattern, '_');
    }
    // Collapse repeated underscores / whitespace
    return msg.replace(/[_\s]+/g, '_').slice(0, 500);
  }

  /** Convert a DB row to the public PastError model. */
  private _rowToModel(row: ErrorMemoryRow): PastError {
    return {
      id:             row.id,
      errorSignature: row.error_signature,
      errorMessage:   row.error_message,
      category:       row.category as ErrorCategory,
      fixApplied:     row.fix_applied,
      fixWorked:      row.fix_worked === 1,
      occurrences:    row.occurrences,
      firstSeen:      row.first_seen,
      lastSeen:       row.last_seen,
    };
  }
}
