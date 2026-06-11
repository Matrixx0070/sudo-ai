/**
 * @file rollback-store.ts
 * @description SQLite-backed version history for SUDO-AI Auto-Update rollback.
 *
 * Persists version records to data/update-versions.db so that updates can be
 * rolled back to a previous known-good version. Keeps the last N inactive
 * versions for rollback, pruning older ones automatically.
 *
 * Covers: recordVersion, getCurrentVersion, getRollbackTarget, listVersions,
 *         markActive, close.
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import type { UpdateChannel, VersionRecord } from './update-manager-types.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger('update:rollback-store');

// ---------------------------------------------------------------------------
// Row shape (SQLite column names are snake_case)
// ---------------------------------------------------------------------------

interface VersionRow {
  id: string;
  version: string;
  git_sha: string;
  installed_at: string;
  channel: string;
  checksum_sha256: string;
  is_active: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(r: VersionRow): VersionRecord {
  return {
    id: r.id,
    version: r.version,
    gitSha: r.git_sha,
    installedAt: r.installed_at,
    channel: r.channel as UpdateChannel,
    checksumSha256: r.checksum_sha256,
    isActive: r.is_active === 1,
  };
}

// ---------------------------------------------------------------------------
// RollbackStore
// ---------------------------------------------------------------------------

export class RollbackStore {
  private readonly db: Database.Database;
  private readonly maxInactive: number;

  /**
   * @param dbPath  Path to the SQLite database file.
   * @param rollbackVersions  How many inactive versions to retain (default 3).
   */
  constructor(dbPath: string = path.join(DATA_DIR, 'update-versions.db'), rollbackVersions: number = 3) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.maxInactive = Math.max(1, rollbackVersions);
    this._migrate();
    log.info({ dbPath, rollbackVersions }, 'RollbackStore initialised');
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        id            TEXT PRIMARY KEY,
        version       TEXT NOT NULL,
        git_sha       TEXT NOT NULL,
        installed_at   TEXT NOT NULL,
        channel       TEXT NOT NULL DEFAULT 'latest',
        checksum_sha256 TEXT NOT NULL DEFAULT '',
        is_active     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_versions_active   ON versions(is_active, installed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_versions_installed ON versions(installed_at DESC);
    `);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Record a new version. Deactivates the previous active version and
   * prunes inactive versions beyond the configured limit.
   */
  recordVersion(record: Omit<VersionRecord, 'id'>): VersionRecord {
    const id = nanoid();

    // Deactivate all current active versions
    this.db.prepare('UPDATE versions SET is_active = 0 WHERE is_active = 1').run();

    // Insert the new version as active
    this.db.prepare(`
      INSERT INTO versions (id, version, git_sha, installed_at, channel, checksum_sha256, is_active)
      VALUES (@id, @version, @gitSha, @installedAt, @channel, @checksumSha256, 1)
    `).run({
      id,
      version: record.version,
      gitSha: record.gitSha,
      installedAt: record.installedAt,
      channel: record.channel,
      checksumSha256: record.checksumSha256,
    });

    // Prune inactive versions beyond the limit
    this._pruneInactive();

    const result: VersionRecord = {
      id,
      version: record.version,
      gitSha: record.gitSha,
      installedAt: record.installedAt,
      channel: record.channel,
      checksumSha256: record.checksumSha256,
      isActive: true,
    };

    log.info({ id, version: record.version, channel: record.channel }, 'Version recorded');
    return result;
  }

  /**
   * Get the currently active version record.
   */
  getCurrentVersion(): VersionRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM versions WHERE is_active = 1 ORDER BY installed_at DESC LIMIT 1',
    ).get() as VersionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Get the most recent inactive version — the rollback target.
   */
  getRollbackTarget(): VersionRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM versions WHERE is_active = 0 ORDER BY installed_at DESC LIMIT 1',
    ).get() as VersionRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * List version records, ordered by most recent first.
   */
  listVersions(limit: number = 20): VersionRecord[] {
    const n = Math.max(1, Math.min(500, limit));
    const rows = this.db.prepare(
      'SELECT * FROM versions ORDER BY installed_at DESC LIMIT ?',
    ).all(n) as VersionRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Mark a specific version as active (for rollback).
   * Deactivates all other versions first.
   */
  markActive(id: string): void {
    const existing = this.db.prepare('SELECT id FROM versions WHERE id = ?').get(id) as { id: string } | undefined;
    if (!existing) {
      throw new Error(`Version record not found: ${id}`);
    }

    // Deactivate all
    this.db.prepare('UPDATE versions SET is_active = 0').run();
    // Activate the target
    this.db.prepare('UPDATE versions SET is_active = 1 WHERE id = ?').run(id);
    log.info({ id }, 'Version marked as active');
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
    log.info('RollbackStore closed');
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _pruneInactive(): void {
    // Delete the oldest inactive versions that exceed the limit
    this.db.prepare(`
      DELETE FROM versions
      WHERE is_active = 0
        AND id NOT IN (
          SELECT id FROM versions
          WHERE is_active = 0
          ORDER BY installed_at DESC
          LIMIT ?
        )
    `).run(this.maxInactive);
  }
}