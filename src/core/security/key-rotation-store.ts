/**
 * @file security/key-rotation-store.ts
 * @description SQLite-backed key rotation log for ArtifactSigner Wave 10G.
 *
 * Schema: key_rotation_log (key_version AUTOINCREMENT PK, status in active/retiring/retired).
 * DB path: data/keys/key-rotation.db (override via SUDO_KEY_ROTATION_DB_PATH env).
 *
 * Design invariants:
 *  - At most ONE row with status='active' at any time.
 *  - At most ONE row with status='retiring' at any time.
 *  - key_id values are UNIQUE (8-char hex prefix of DER public key).
 *  - Private key material is NEVER persisted here — only public key DER hex.
 *  - DB is always source of truth for which key is active.
 *
 * @module security/key-rotation-store
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('security:key-rotation-store');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = 'data/keys/key-rotation.db';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;

CREATE TABLE IF NOT EXISTS key_rotation_log (
  key_version  INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id       TEXT NOT NULL UNIQUE,
  public_key   TEXT NOT NULL,
  algorithm    TEXT NOT NULL DEFAULT 'ed25519',
  status       TEXT NOT NULL CHECK(status IN ('active','retiring','retired')),
  generated_at TEXT NOT NULL,
  retired_at   TEXT
);
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KeyRotationRow {
  key_version: number;
  key_id: string;
  /** Full DER hex of the public key — never contains private material. */
  public_key: string;
  algorithm: 'ed25519';
  status: 'active' | 'retiring' | 'retired';
  generated_at: string;  // ISO-8601
  retired_at: string | null;  // ISO-8601 or null
}

// Internal SQLite row shape (same fields, status is just string from DB).
interface RawRow {
  key_version: number;
  key_id: string;
  public_key: string;
  algorithm: string;
  status: string;
  generated_at: string;
  retired_at: string | null;
}

function toKeyRotationRow(raw: RawRow): KeyRotationRow {
  return {
    key_version: raw.key_version,
    key_id: raw.key_id,
    public_key: raw.public_key,
    algorithm: raw.algorithm as 'ed25519',
    status: raw.status as 'active' | 'retiring' | 'retired',
    generated_at: raw.generated_at,
    retired_at: raw.retired_at,
  };
}

// ---------------------------------------------------------------------------
// KeyRotationStore class
// ---------------------------------------------------------------------------

/**
 * Manages the key_rotation_log SQLite table.
 *
 * Instantiate once per ArtifactSigner. Use `keyRotationStore` singleton for
 * production or pass a custom dbPath for test isolation.
 */
export class KeyRotationStore {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? process.env['SUDO_KEY_ROTATION_DB_PATH'] ?? DEFAULT_DB_PATH;
    try {
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      this.db = new Database(resolvedPath);
      this.db.exec(SCHEMA);
      log.info({ dbPath: resolvedPath }, 'KeyRotationStore initialised');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`KeyRotationStore: failed to open database at ${resolvedPath}: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // promoteLegacy — persist pre-existing Wave 10F key as v1
  // ---------------------------------------------------------------------------

  /**
   * Persist a pre-built v1 row when ArtifactSigner detects legacy
   * wave10-signer.{pub,priv} files at construction.
   *
   * No-op (idempotent) if key_rotation_log already has any rows.
   * Returns the inserted row or the existing active row.
   *
   * @param row - Row data WITHOUT key_version (AUTOINCREMENT assigns it).
   */
  promoteLegacy(row: Omit<KeyRotationRow, 'key_version'>): KeyRotationRow {
    try {
      const existing = this.getActive();
      if (existing) {
        log.debug({ keyId: existing.key_id }, 'KeyRotationStore.promoteLegacy: DB not empty, skip');
        return existing;
      }
      this.db.prepare(`
        INSERT INTO key_rotation_log (key_id, public_key, algorithm, status, generated_at, retired_at)
        VALUES (:key_id, :public_key, :algorithm, :status, :generated_at, :retired_at)
      `).run({
        key_id: row.key_id,
        public_key: row.public_key,
        algorithm: row.algorithm,
        status: row.status,
        generated_at: row.generated_at,
        retired_at: row.retired_at,
      });
      const inserted = this.getActive();
      if (!inserted) throw new Error('promoteLegacy: INSERT succeeded but getActive() returned null');
      log.info({ keyId: inserted.key_id, keyVersion: inserted.key_version }, 'KeyRotationStore.promoteLegacy: v1 row inserted');
      return inserted;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'KeyRotationStore.promoteLegacy failed');
      throw new Error(`KeyRotationStore.promoteLegacy failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // getActive — return current active key row
  // ---------------------------------------------------------------------------

  /**
   * Return the current active row or null if the table is empty.
   */
  getActive(): KeyRotationRow | null {
    try {
      const raw = this.db.prepare(
        `SELECT * FROM key_rotation_log WHERE status = 'active' LIMIT 1`,
      ).get() as RawRow | undefined;
      return raw ? toKeyRotationRow(raw) : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'KeyRotationStore.getActive failed');
      throw new Error(`KeyRotationStore.getActive failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // getByVersion — lookup by monotonic version number
  // ---------------------------------------------------------------------------

  getByVersion(version: number): KeyRotationRow | null {
    try {
      const raw = this.db.prepare(
        `SELECT * FROM key_rotation_log WHERE key_version = ?`,
      ).get(version) as RawRow | undefined;
      return raw ? toKeyRotationRow(raw) : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, version }, 'KeyRotationStore.getByVersion failed');
      throw new Error(`KeyRotationStore.getByVersion failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // getByKeyId — lookup by 8-char key_id prefix
  // ---------------------------------------------------------------------------

  getByKeyId(keyId: string): KeyRotationRow | null {
    try {
      const raw = this.db.prepare(
        `SELECT * FROM key_rotation_log WHERE key_id = ?`,
      ).get(keyId) as RawRow | undefined;
      return raw ? toKeyRotationRow(raw) : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, keyId }, 'KeyRotationStore.getByKeyId failed');
      throw new Error(`KeyRotationStore.getByKeyId failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // promoteNewKey — transactional rotation (BEGIN IMMEDIATE)
  // ---------------------------------------------------------------------------

  /**
   * Atomically promote a new keypair to active within a BEGIN IMMEDIATE
   * transaction. If within the idempotency window (last rotation < idempotencyWindowMs),
   * rolls back and returns the current active row with `idempotent: true`.
   *
   * @param newRow - New key row data WITHOUT key_version.
   * @param retirementWindowHours - Hours until retiring key is permanently expired.
   * @param idempotencyWindowMs - Min ms between rotations (0 in tests).
   * @returns New active row (or existing if idempotent), with `idempotent` flag.
   */
  promoteNewKey(
    newRow: Omit<KeyRotationRow, 'key_version'>,
    retirementWindowHours: number,
    idempotencyWindowMs: number,
  ): KeyRotationRow & { idempotent: boolean } {
    let result!: KeyRotationRow & { idempotent: boolean };

    // db.transaction() returns a Transaction<F> with .exclusive() for BEGIN EXCLUSIVE lock.
    // This prevents concurrent rotate() calls from both reading "outside window" simultaneously.
    const txnFn = this.db.transaction(() => {
      // Re-check inside transaction (definitive idempotency guard).
      const lastMs = this._lastRotatedAtTxn();
      if (idempotencyWindowMs > 0 && Date.now() - lastMs < idempotencyWindowMs) {
        const priorRotation = this.db.prepare(
          `SELECT 1 FROM key_rotation_log WHERE status IN ('retiring','retired') LIMIT 1`
        ).get();
        if (priorRotation) {
          const active = this.getActive();
          if (!active) throw new Error('promoteNewKey: within idempotency window but no active row found');
          result = { ...active, idempotent: true };
          return;
        }
      }

      // Compute retirement timestamp.
      const retiredAt = new Date(Date.now() + retirementWindowHours * 3600 * 1000).toISOString();

      // UPDATE current active → retiring.
      this.db.prepare(`
        UPDATE key_rotation_log
        SET status = 'retiring', retired_at = ?
        WHERE status = 'active'
      `).run(retiredAt);

      // INSERT new active row.
      this.db.prepare(`
        INSERT INTO key_rotation_log (key_id, public_key, algorithm, status, generated_at, retired_at)
        VALUES (:key_id, :public_key, :algorithm, :status, :generated_at, :retired_at)
      `).run({
        key_id: newRow.key_id,
        public_key: newRow.public_key,
        algorithm: newRow.algorithm,
        status: 'active',
        generated_at: newRow.generated_at,
        retired_at: null,
      });

      const inserted = this.getActive();
      if (!inserted) throw new Error('promoteNewKey: INSERT succeeded but getActive() returned null');
      result = { ...inserted, idempotent: false };
    });

    // Call .exclusive() to acquire an EXCLUSIVE lock for the entire transaction.
    // This is the definitive guard against concurrent rotate() races.
    txnFn.exclusive();

    return result;
  }

  // ---------------------------------------------------------------------------
  // expireIfDue — promote retiring → retired when retired_at has passed
  // ---------------------------------------------------------------------------

  /**
   * If the row at `version` is status='retiring' and retired_at <= now,
   * update it to status='retired'. Called at verify() time.
   */
  expireIfDue(version: number): void {
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE key_rotation_log
        SET status = 'retired'
        WHERE key_version = ? AND status = 'retiring' AND retired_at IS NOT NULL AND retired_at <= ?
      `).run(version, now);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg, version }, 'KeyRotationStore.expireIfDue failed (non-fatal)');
      // Non-fatal — verification will still check retired_at manually.
    }
  }

  // ---------------------------------------------------------------------------
  // lastRotatedAt — return ms timestamp of last active row generation
  // ---------------------------------------------------------------------------

  /**
   * Return the epoch-ms of the most recently active row's generated_at,
   * or 0 if the table is empty.
   *
   * NOTE: This is advisory only for pre-checks. The definitive idempotency
   * check runs inside the BEGIN IMMEDIATE transaction in promoteNewKey().
   */
  lastRotatedAt(): number {
    try {
      const raw = this.db.prepare(
        `SELECT generated_at FROM key_rotation_log ORDER BY key_version DESC LIMIT 1`,
      ).get() as { generated_at: string } | undefined;
      if (!raw) return 0;
      const ms = Date.parse(raw.generated_at);
      return isNaN(ms) ? 0 : ms;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'KeyRotationStore.lastRotatedAt failed (returning 0)');
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * lastRotatedAt() variant for use INSIDE a transaction (no try/catch —
   * let the transaction propagate errors).
   */
  private _lastRotatedAtTxn(): number {
    const raw = this.db.prepare(
      `SELECT generated_at FROM key_rotation_log ORDER BY key_version DESC LIMIT 1`,
    ).get() as { generated_at: string } | undefined;
    if (!raw) return 0;
    const ms = Date.parse(raw.generated_at);
    return isNaN(ms) ? 0 : ms;
  }

  // ---------------------------------------------------------------------------
  // getRetiring — return the current retiring row (if any, and still active window)
  // ---------------------------------------------------------------------------

  /**
   * Return the retiring row if one exists and its retired_at is still in the future,
   * or null otherwise.
   */
  getRetiring(): KeyRotationRow | null {
    try {
      const now = new Date().toISOString();
      const raw = this.db.prepare(
        `SELECT * FROM key_rotation_log WHERE status = 'retiring' AND retired_at > ? LIMIT 1`,
      ).get(now) as RawRow | undefined;
      return raw ? toKeyRotationRow(raw) : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'KeyRotationStore.getRetiring failed (returning null)');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // close
  // ---------------------------------------------------------------------------

  close(): void {
    try {
      this.db.close();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'KeyRotationStore.close: error closing DB');
    }
  }
}
