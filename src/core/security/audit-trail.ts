/**
 * @file security/audit-trail.ts
 * @description AuditTrail — tamper-evident SQLite audit log for SUDO-AI.
 *
 * Records every security-relevant action with actor, resource, outcome, and
 * optional JSON metadata. Supports filtered queries for reporting and compliance.
 * Uses WAL mode for concurrent read safety.
 *
 * Cryptographic SHA-256 hash chaining via audit-chain.ts.
 * Each row stores prev_hash and hash, linking it to the previous row and
 * making any retrospective tampering detectable via verifyChain().
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import {
  computeHash,
  verifyChainRows,
} from './audit-chain.js';
import type {
  ChainVerifyResult,
  CommitmentTriple,
} from './audit-chain.js';

const log = createLogger('security:audit-trail');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id?: string;
  actor: string;
  action: string;
  resource: string;
  outcome: 'success' | 'failure' | 'denied' | 'error';
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  resource?: string;
  outcome?: AuditEntry['outcome'];
  since?: string;
  limit?: number;
}

// Re-export chain types so callers can import from a single location.
export type { ChainVerifyResult, CommitmentTriple };

// ---------------------------------------------------------------------------
// Internal row type (raw DB row with chain columns)
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  outcome: string;
  metadata_json: string | null;
  prev_hash: string;
  hash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical payload string for a given row's content fields.
 *
 * This MUST be used identically in record(), backfillHashes(), and
 * verifyChain() — it is the single source of truth for what gets hashed.
 *
 * metadata_json is the raw DB column value (a JSON string or null),
 * NOT the parsed object, to ensure byte-exact reproducibility across
 * all three call sites.
 */
function buildPayload(
  actor: string,
  action: string,
  resource: string,
  outcome: string,
  metadata_json: string | null,
): string {
  return JSON.stringify({ actor, action, resource, outcome, metadata_json });
}

// ---------------------------------------------------------------------------
// AuditTrail
// ---------------------------------------------------------------------------

export class AuditTrail {
  private readonly db: Database.Database;

  constructor(dbPath: string = path.join(DATA_DIR, 'audit.db')) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id            TEXT PRIMARY KEY,
        timestamp     TEXT NOT NULL,
        actor         TEXT NOT NULL,
        action        TEXT NOT NULL,
        resource      TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        metadata_json TEXT
      )
    `);

    // Add hash-chain columns and back-fill existing rows.
    this.addChainColumns();
    this.backfillHashes();

    log.info({ dbPath }, 'AuditTrail initialized');
  }

  // -------------------------------------------------------------------------
  // Schema migration (additive, idempotent)
  // -------------------------------------------------------------------------

  /**
   * Add prev_hash and hash TEXT columns to audit_log.
   * Each ALTER is in its own try/catch per the project migrateSchema pattern:
   * silence ONLY "already has a column named" | "duplicate column name" |
   * "no such table". All other errors re-throw (disk-full, SQLITE_BUSY, etc.).
   */
  private addChainColumns(): void {
    const alters = [
      "ALTER TABLE audit_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE audit_log ADD COLUMN hash      TEXT NOT NULL DEFAULT ''",
    ] as const;

    for (const sql of alters) {
      try {
        this.db.exec(sql);
        log.debug({ sql }, 'addChainColumns: column added');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes('already has a column named') ||
          msg.includes('duplicate column name') ||
          msg.includes('no such table')
        ) {
          log.debug({ sql }, 'addChainColumns: column already exists or table absent, skipping');
        } else {
          log.error({ err, sql }, 'addChainColumns: unexpected error');
          throw err;
        }
      }
    }
  }

  /**
   * Back-fill prev_hash and hash for any rows that were inserted before
   * the chain columns existed (hash = '' or NULL).
   *
   * Processing order: ascending rowid (chronological).
   * prevHash seed: the hash of the last preceding row that already has a hash,
   * or '' if no such row exists (i.e., back-filling from the very beginning).
   *
   * Runs inside a single db.transaction for atomicity.
   */
  private backfillHashes(): void {
    const rows = this.db.prepare(
      "SELECT rowid, id, timestamp, actor, action, resource, outcome, metadata_json, hash " +
      "FROM audit_log WHERE hash = '' OR hash IS NULL ORDER BY rowid ASC",
    ).all() as Array<{
      rowid: number; id: string; timestamp: string;
      actor: string; action: string; resource: string;
      outcome: string; metadata_json: string | null; hash: string;
    }>;

    if (rows.length === 0) {
      log.debug('backfillHashes: no rows to back-fill');
      return;
    }

    log.info({ rowCount: rows.length }, 'backfillHashes: starting back-fill');

    // Find the hash of the last row that already has a non-empty hash,
    // with rowid less than the first row to be back-filled.
    const firstRowid = rows[0]!.rowid;
    const seedRow = this.db.prepare(
      "SELECT hash FROM audit_log WHERE rowid < ? AND hash != '' AND hash IS NOT NULL ORDER BY rowid DESC LIMIT 1",
    ).get(firstRowid) as { hash: string } | undefined;

    const fill = this.db.transaction(() => {
      let prevHash = seedRow?.hash ?? '';

      for (const row of rows) {
        const payload = buildPayload(
          row.actor,
          row.action,
          row.resource,
          row.outcome,
          row.metadata_json,
        );
        const hash = computeHash(prevHash, row.timestamp, payload);
        this.db.prepare(
          'UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?',
        ).run(prevHash, hash, row.id);
        prevHash = hash;
      }
    });

    fill();
    log.info({ rowCount: rows.length }, 'backfillHashes: back-fill complete');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record a new audit entry.
   *
   * Wrapped in a db.transaction so that reading the previous hash and
   * inserting the new row are atomic — no concurrent insert can interleave
   * and produce a broken chain.
   *
   * @returns The generated (or provided) entry ID.
   */
  record(entry: AuditEntry): string {
    if (!entry.actor) throw new Error('AuditEntry.actor is required');
    if (!entry.action) throw new Error('AuditEntry.action is required');
    if (!entry.resource) throw new Error('AuditEntry.resource is required');
    if (!entry.outcome) throw new Error('AuditEntry.outcome is required');

    const id = entry.id ?? randomUUID();
    const timestamp = entry.timestamp ?? new Date().toISOString();
    const metadata_json = entry.metadata !== undefined
      ? JSON.stringify(entry.metadata)
      : null;

    const doInsert = this.db.transaction((): string => {
      // Read the last row's hash to form the chain link.
      const lastRow = this.db.prepare(
        'SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1',
      ).get() as { hash: string } | undefined;
      const prevHash = lastRow?.hash ?? '';

      const payload = buildPayload(
        entry.actor,
        entry.action,
        entry.resource,
        entry.outcome,
        metadata_json,
      );
      const hash = computeHash(prevHash, timestamp, payload);

      this.db.prepare(
        `INSERT INTO audit_log
           (id, timestamp, actor, action, resource, outcome, metadata_json, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        timestamp,
        entry.actor,
        entry.action,
        entry.resource,
        entry.outcome,
        metadata_json,
        prevHash,
        hash,
      );

      log.debug(
        { id, actor: entry.actor, action: entry.action, outcome: entry.outcome, hash: hash.slice(0, 16) },
        'Audit entry recorded',
      );
      return id;
    });

    return doInsert();
  }

  /**
   * Query audit entries with optional filters.
   * Always returns entries newest-first.
   */
  query(filter: AuditFilter = {}): AuditEntry[] {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (filter.actor) { sql += ' AND actor = ?'; params.push(filter.actor); }
    if (filter.action) { sql += ' AND action = ?'; params.push(filter.action); }
    if (filter.resource) { sql += ' AND resource = ?'; params.push(filter.resource); }
    if (filter.outcome) { sql += ' AND outcome = ?'; params.push(filter.outcome); }
    if (filter.since) { sql += ' AND timestamp >= ?'; params.push(filter.since); }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(filter.limit ?? 100);

    const rows = this.db.prepare(sql).all(...params) as RawRow[];

    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      actor: r.actor,
      action: r.action,
      resource: r.resource,
      outcome: r.outcome as AuditEntry['outcome'],
      metadata: r.metadata_json !== null ? JSON.parse(r.metadata_json) as Record<string, unknown> : undefined,
    }));
  }

  /**
   * Count entries matching an actor/action combination within a time window.
   * Useful for rate-limiting and anomaly detection.
   */
  countSince(actor: string, action: string, since: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM audit_log WHERE actor = ? AND action = ? AND timestamp >= ?',
    ).get(actor, action, since) as { cnt: number };
    return row.cnt;
  }

  /**
   * Verify the integrity of the entire audit chain.
   *
   * Reads all rows in chronological order, reconstructs the payload string
   * for each, and compares the recomputed SHA-256 against the stored hash.
   * Returns immediately on the first mismatch.
   *
   * @returns ChainVerifyResult — ok:true if intact, ok:false + breakAt if tampered.
   */
  verifyChain(): ChainVerifyResult {
    const rows = this.db.prepare(
      'SELECT id, timestamp, actor, action, resource, outcome, metadata_json, prev_hash, hash ' +
      'FROM audit_log ORDER BY rowid ASC',
    ).all() as RawRow[];

    const chainEntries = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      payload: buildPayload(r.actor, r.action, r.resource, r.outcome, r.metadata_json),
      prev_hash: r.prev_hash,
      hash: r.hash,
    }));

    return verifyChainRows(chainEntries);
  }

  /**
   * Record a structured commitment triple.
   *
   * Persists a (mistake, learned, commitment) tuple into the audit log
   * with actor='system' and action='commitment'.
   *
   * @returns The audit entry ID.
   */
  recordTriple(triple: CommitmentTriple): string {
    return this.record({
      actor: 'system',
      action: 'commitment',
      resource: triple.resource ?? 'system',
      outcome: 'success',
      metadata: {
        mistake: triple.mistake,
        learned: triple.learned,
        commitment: triple.commitment,
        ttl_days: triple.ttl_days,
      },
    });
  }
}
