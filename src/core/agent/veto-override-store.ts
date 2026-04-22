/**
 * agent/veto-override-store.ts — SQLite-backed store for manual veto overrides.
 *
 * Allows operators to pre-register APPROVE or DENY decisions for known
 * tool-call decisionIds before the veto gate runs in the agent loop.
 *
 * Schema v2: adds content_hash column for content-addressable overrides.
 */

import type { Database, Statement } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:veto-override-store');

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VetoOverride {
  id:           string;          // UUID
  decisionId:   string;          // per-tool-call decisionId from loop.ts
  contentHash?: string | null;   // schema v2 — nullable/absent for legacy rows
  action:       'allow' | 'deny';
  reason:       string;          // operator-provided justification
  createdAt:    string;          // ISO-8601 timestamp
  createdBy:    string;          // auth identity or literal 'admin'
}

// Internal row shape from SQLite (snake_case)
interface VetoOverrideRow {
  id:           string;
  decision_id:  string;
  content_hash: string | null;  // schema v2
  action:       string;
  reason:       string;
  created_at:   string;
  created_by:   string;
}

// ---------------------------------------------------------------------------
// VetoOverrideStore
// ---------------------------------------------------------------------------

export class VetoOverrideStore {
  private readonly db: Database;

  // Prepared statements — cached at class level (A2: statement caching)
  private readonly _stmtRecord:           Statement;
  private readonly _stmtGet:              Statement;
  private readonly _stmtGetByContentHash: Statement;
  private readonly _stmtList:             Statement;

  constructor(db: Database) {
    this.db = db;
    this._initSchema();

    this._stmtRecord = this.db.prepare(
      `INSERT INTO veto_overrides (id, decision_id, content_hash, action, reason, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this._stmtGet = this.db.prepare(
      `SELECT id, decision_id, content_hash, action, reason, created_at, created_by
       FROM veto_overrides WHERE decision_id = ?`,
    );
    this._stmtGetByContentHash = this.db.prepare(
      `SELECT id, decision_id, content_hash, action, reason, created_at, created_by
       FROM veto_overrides WHERE content_hash = ? LIMIT 1`,
    );
    this._stmtList = this.db.prepare(
      `SELECT id, decision_id, content_hash, action, reason, created_at, created_by
       FROM veto_overrides ORDER BY created_at DESC LIMIT ?`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Persist a new override. Throws if decisionId already exists (UNIQUE constraint).
   * Optional contentHash enables content-addressable pre-approval.
   */
  recordOverride(override: Omit<VetoOverride, 'id' | 'createdAt'>): VetoOverride {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const contentHash = override.contentHash ?? null;

    try {
      this._stmtRecord.run(
        id,
        override.decisionId,
        contentHash,
        override.action,
        override.reason,
        createdAt,
        override.createdBy,
      );
    } catch (err: unknown) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), decisionId: override.decisionId },
        'VetoOverrideStore: recordOverride failed',
      );
      throw err;
    }

    const stored: VetoOverride = {
      id,
      decisionId:  override.decisionId,
      contentHash,
      action:      override.action,
      reason:      override.reason,
      createdAt,
      createdBy:   override.createdBy,
    };

    log.info(
      { id, decisionId: override.decisionId, contentHash, action: override.action },
      'VetoOverrideStore: override recorded',
    );

    return stored;
  }

  /**
   * Returns the stored override for this decisionId, or null if absent.
   */
  getOverride(decisionId: string): VetoOverride | null {
    try {
      const row = this._stmtGet.get(decisionId) as VetoOverrideRow | undefined;
      if (!row) return null;
      return this._rowToOverride(row);
    } catch (err: unknown) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), decisionId },
        'VetoOverrideStore: getOverride failed',
      );
      return null;
    }
  }

  /**
   * Returns the first stored override with matching content_hash, or null if absent.
   * Fail-open: logs and returns null on DB error.
   */
  getOverrideByContentHash(contentHash: string): VetoOverride | null {
    try {
      const row = this._stmtGetByContentHash.get(contentHash) as VetoOverrideRow | undefined;
      if (!row) return null;
      return this._rowToOverride(row);
    } catch (err: unknown) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), contentHash },
        'VetoOverrideStore: getOverrideByContentHash failed',
      );
      return null;
    }
  }

  /**
   * Return all overrides, newest first. Limit clamped to [1, 500].
   */
  listOverrides(limit?: number): VetoOverride[] {
    const clampedLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);

    try {
      const rows = this._stmtList.all(clampedLimit) as VetoOverrideRow[];
      return rows.map((r) => this._rowToOverride(r));
    } catch (err: unknown) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'VetoOverrideStore: listOverrides failed',
      );
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _initSchema(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS veto_overrides (
          id          TEXT PRIMARY KEY,
          decision_id TEXT NOT NULL UNIQUE,
          action      TEXT NOT NULL CHECK(action IN ('allow','deny')),
          reason      TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          created_by  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_veto_overrides_decision_id
          ON veto_overrides(decision_id);
      `);
    } catch (err: unknown) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'VetoOverrideStore: schema init failed',
      );
      throw err;
    }

    // Schema v2: add content_hash column idempotently.
    try {
      this.db.exec(`ALTER TABLE veto_overrides ADD COLUMN content_hash TEXT`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) throw err;
      // column already exists — no-op
    }

    // Unique index on content_hash (excluding NULLs so legacy rows don't conflict).
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_veto_overrides_content_hash
        ON veto_overrides(content_hash)
        WHERE content_hash IS NOT NULL;
    `);
  }

  private _rowToOverride(row: VetoOverrideRow): VetoOverride {
    return {
      id:          row.id,
      decisionId:  row.decision_id,
      contentHash: row.content_hash ?? null,
      action:      row.action as 'allow' | 'deny',
      reason:      row.reason,
      createdAt:   row.created_at,
      createdBy:   row.created_by,
    };
  }
}
