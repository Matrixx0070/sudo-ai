/**
 * SurvivalSystem — SUDO cannot be killed permanently.
 *
 * Features:
 *   - Multi-backup: tarballs of all data/*.db files  (via SurvivalBackup)
 *   - Dead man's switch: detects silence >24 h
 *   - Model availability probing                     (via SurvivalProbe)
 *   - State export/import: portable tarball
 *   - Migration history tracking
 *   - Resilience score (0–100)
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { SurvivalBackup } from './survival-backup.js';
import { SurvivalProbe } from './survival-probe.js';

const log          = createLogger('persistence:survival');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types (re-exported from sub-modules)
// ---------------------------------------------------------------------------

export type { BackupState } from './survival-backup.js';
export type { ModelMigration, ModelProbeResult } from './survival-probe.js';

export interface ResilienceScore {
  score:           number;
  backupCount:     number;
  lastBackup:      string;
  modelsAvailable: number;
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface HeartbeatRow {
  id:           number;
  last_seen_at: string;
  notes:        string | null;
}

// ---------------------------------------------------------------------------
// SurvivalSystem
// ---------------------------------------------------------------------------

export class SurvivalSystem {
  private readonly db:      Database.Database;
  private readonly backup:  SurvivalBackup;
  private readonly probe:   SurvivalProbe;
  private readonly dataDir: string;
  private readonly backupDir: string;

  /**
   * @param dataDir - Root data directory (e.g. '/root/sudo-ai-v4/data').
   * @param dbPath  - Absolute path to the SQLite DB file for survival tables.
   */
  constructor(dataDir: string, dbPath: string) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new TypeError('SurvivalSystem: dataDir must be a non-empty string');
    }
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('SurvivalSystem: dbPath must be a non-empty string');
    }

    this.dataDir   = dataDir;
    this.backupDir = join(dataDir, 'backups');

    const dir = dirname(dbPath);
    if (!existsSync(dir))          mkdirSync(dir,           { recursive: true });
    if (!existsSync(this.backupDir)) mkdirSync(this.backupDir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._ensureSchema();

    this.backup = new SurvivalBackup(this.db, dataDir, this.backupDir);
    this.probe  = new SurvivalProbe(this.db);

    log.info({ dataDir, dbPath }, 'SurvivalSystem initialised');
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private _ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backups (
        id               TEXT    PRIMARY KEY,
        timestamp        TEXT    NOT NULL,
        databases        TEXT    NOT NULL DEFAULT '[]',
        total_size_bytes INTEGER NOT NULL DEFAULT 0,
        location         TEXT    NOT NULL,
        verified         INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS dead_man_switch (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        last_seen_at TEXT    NOT NULL,
        notes        TEXT
      );

      CREATE TABLE IF NOT EXISTS model_migrations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        from_model  TEXT    NOT NULL,
        to_model    TEXT    NOT NULL,
        reason      TEXT    NOT NULL DEFAULT '',
        migrated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        success     INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_backups_ts    ON backups(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_migrations_ts ON model_migrations(migrated_at DESC);
    `);
    log.debug('survival schema ensured');
  }

  // -------------------------------------------------------------------------
  // Backup delegation
  // -------------------------------------------------------------------------

  async createBackup(location?: string)                     { return this.backup.createBackup(location); }
  async restoreFromBackup(backupId: string)                 { return this.backup.restoreFromBackup(backupId); }
  listBackups()                                             { return this.backup.listBackups(); }
  pruneOldBackups(keepCount = 10)                           { return this.backup.pruneOldBackups(keepCount); }

  // -------------------------------------------------------------------------
  // Model probe delegation
  // -------------------------------------------------------------------------

  async testModelAvailability()                             { return this.probe.testModelAvailability(); }
  getMigrationHistory()                                     { return this.probe.getMigrationHistory(); }

  // -------------------------------------------------------------------------
  // Dead man's switch
  // -------------------------------------------------------------------------

  /** Record an "I'm alive" heartbeat. */
  async heartbeat(): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO dead_man_switch (id, last_seen_at)
      VALUES (1, :now)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run({ now });
    log.debug({ now }, 'Heartbeat recorded');
  }

  /** Check whether SUDO has been silent beyond the 24-hour threshold. */
  async checkDeadManSwitch(): Promise<{ alive: boolean; lastSeen: string; silentHours: number }> {
    const row = this.db
      .prepare<[], HeartbeatRow>('SELECT * FROM dead_man_switch WHERE id = 1')
      .get();

    if (!row) {
      log.warn('No heartbeat record — dead man switch never initialised');
      return { alive: false, lastSeen: 'never', silentHours: Infinity };
    }

    const lastSeen    = new Date(row.last_seen_at);
    const silentHours = (Date.now() - lastSeen.getTime()) / (1000 * 60 * 60);
    const alive       = silentHours < 24;

    log.info({ lastSeen: row.last_seen_at, silentHours: silentHours.toFixed(2), alive }, 'DMS checked');
    return { alive, lastSeen: row.last_seen_at, silentHours };
  }

  // -------------------------------------------------------------------------
  // State export / import
  // -------------------------------------------------------------------------

  /** Export all DB files to a portable tarball under data/exports/. */
  async exportState(): Promise<{ path: string; sizeBytes: number }> {
    const exportDir = join(this.dataDir, 'exports');
    if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

    const ts      = new Date().toISOString().replace(/[:.]/g, '-');
    const tarPath = join(exportDir, `sudo-state-${ts}.tar.gz`);
    const dbFiles: string[] = [];

    for (const entry of readdirSync(this.dataDir)) {
      if (entry.endsWith('.db') || entry.endsWith('.db-shm') || entry.endsWith('.db-wal')) {
        dbFiles.push(entry);
      }
    }

    log.info({ tarPath, files: dbFiles.length }, 'Exporting state');

    try {
      await execFileAsync('tar', ['-czf', tarPath, '--directory', this.dataDir, ...dbFiles]);
    } catch (err) {
      throw new Error(`SurvivalSystem.exportState: tar error: ${String(err)}`);
    }

    let sizeBytes = 0;
    try { sizeBytes = statSync(tarPath).size; } catch { /* non-fatal */ }

    log.info({ tarPath, sizeBytes }, 'State exported');
    return { path: tarPath, sizeBytes };
  }

  /**
   * Import a previously exported state tarball.
   *
   * @param path - Absolute path to the .tar.gz export file.
   */
  async importState(path: string): Promise<boolean> {
    if (!path?.trim()) throw new TypeError('SurvivalSystem.importState: path required');
    if (!existsSync(path)) { log.error({ path }, 'Import file not found'); return false; }

    log.warn({ path }, 'Importing state');

    try {
      await execFileAsync('tar', ['-xzf', path, '--directory', this.dataDir]);
      log.info({ path }, 'State import complete');
      return true;
    } catch (err) {
      log.error({ path, err: String(err) }, 'State import failed');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Resilience score
  // -------------------------------------------------------------------------

  /** Compute a composite resilience score (0–100). */
  getResilienceScore(): ResilienceScore {
    const backups  = this.listBackups();
    const lastBkup = backups.length > 0 ? backups[0]!.timestamp : 'never';

    // Factor 1 (25 pts): backup count ≥5 = full
    const bkScore = Math.min(25, backups.length * 5);

    // Factor 2 (25 pts): recency of last backup
    let recencyScore = 0;
    if (backups.length > 0) {
      const ageHours = (Date.now() - new Date(lastBkup).getTime()) / 3_600_000;
      recencyScore = Math.max(0, 25 - Math.floor(ageHours / 12) * 5);
    }

    // Factor 3 (25 pts): dead man switch freshness
    const hmRow = this.db
      .prepare<[], HeartbeatRow>('SELECT * FROM dead_man_switch WHERE id = 1')
      .get();
    let dmsScore = 0;
    if (hmRow) {
      const ageHours = (Date.now() - new Date(hmRow.last_seen_at).getTime()) / 3_600_000;
      dmsScore = ageHours < 1 ? 25 : ageHours < 6 ? 20 : ageHours < 24 ? 10 : 0;
    }

    // Factor 4 (25 pts): verified backup count ≥3 = full
    const verified  = backups.filter((b) => b.verified).length;
    const verScore  = Math.min(25, verified * 8);

    // Count distinct models seen in migration history
    const models = this.db
      .prepare<[], { to_model: string }>('SELECT DISTINCT to_model FROM model_migrations')
      .all().length;

    const score = Math.min(100, bkScore + recencyScore + dmsScore + verScore);
    log.debug({ score, backupCount: backups.length, models }, 'Resilience score computed');

    return {
      score,
      backupCount:     backups.length,
      lastBackup:      lastBkup,
      modelsAvailable: models,
    };
  }
}
