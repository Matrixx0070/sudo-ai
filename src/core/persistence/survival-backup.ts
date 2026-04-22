/**
 * SurvivalBackup — backup/restore operations for SurvivalSystem.
 * Extracted to keep survival.ts under 300 lines.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('persistence:backup');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BackupState {
  id:             string;
  timestamp:      string;
  databases:      string[];
  totalSizeBytes: number;
  location:       string;
  verified:       boolean;
}

export interface BackupRow {
  id:               string;
  timestamp:        string;
  databases:        string;
  total_size_bytes: number;
  location:         string;
  verified:         number;
}

// ---------------------------------------------------------------------------
// SurvivalBackup
// ---------------------------------------------------------------------------

export class SurvivalBackup {
  constructor(
    private readonly db:        Database.Database,
    private readonly dataDir:   string,
    private readonly backupDir: string,
  ) {}

  /**
   * Create a tarball backup of all *.db files in dataDir.
   *
   * @param location - Optional override for the output directory.
   */
  async createBackup(location?: string): Promise<BackupState> {
    const outDir = location ?? this.backupDir;
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const id        = randomUUID();
    const timestamp = new Date().toISOString();
    const safeName  = timestamp.replace(/[:.]/g, '-');
    const tarPath   = join(outDir, `backup-${safeName}.tar.gz`);

    log.info({ id, outDir }, 'Creating backup');

    const dbFiles: string[] = [];
    try {
      for (const entry of readdirSync(this.dataDir)) {
        if (entry.endsWith('.db') || entry.endsWith('.db-shm') || entry.endsWith('.db-wal')) {
          dbFiles.push(entry);
        }
      }
    } catch (err) {
      throw new Error(`Cannot scan dataDir: ${String(err)}`);
    }

    if (dbFiles.length === 0) log.warn('No .db files found to backup');

    try {
      await execFileAsync('tar', ['-czf', tarPath, '--directory', this.dataDir, ...dbFiles]);
    } catch (err) {
      throw new Error(`tar error: ${String(err)}`);
    }

    let totalSizeBytes = 0;
    try { totalSizeBytes = statSync(tarPath).size; } catch { /* non-fatal */ }

    let verified = false;
    try {
      await execFileAsync('tar', ['-tzf', tarPath]);
      verified = true;
    } catch (err) {
      log.warn({ tarPath, err: String(err) }, 'Backup verification failed');
    }

    this.db.prepare(`
      INSERT INTO backups (id, timestamp, databases, total_size_bytes, location, verified)
      VALUES (:id, :timestamp, :databases, :total_size_bytes, :location, :verified)
    `).run({
      id, timestamp,
      databases:       JSON.stringify(dbFiles),
      total_size_bytes: totalSizeBytes,
      location:        tarPath,
      verified:        verified ? 1 : 0,
    });

    log.info({ id, tarPath, sizeBytes: totalSizeBytes, verified }, 'Backup complete');
    return { id, timestamp, databases: dbFiles, totalSizeBytes, location: tarPath, verified };
  }

  /**
   * Restore databases from a backup tarball.
   *
   * @param backupId - UUID of the backup record.
   */
  async restoreFromBackup(backupId: string): Promise<boolean> {
    if (!backupId?.trim()) throw new TypeError('backupId required');

    const row = this.db
      .prepare<{ id: string }, BackupRow>('SELECT * FROM backups WHERE id = :id')
      .get({ id: backupId });

    if (!row) { log.error({ backupId }, 'Backup not found'); return false; }
    if (!existsSync(row.location)) { log.error({ backupId }, 'Backup file missing'); return false; }

    log.warn({ backupId, location: row.location }, 'Restoring from backup');

    try {
      await execFileAsync('tar', ['-xzf', row.location, '--directory', this.dataDir]);
      log.info({ backupId }, 'Restore complete');
      return true;
    } catch (err) {
      log.error({ backupId, err: String(err) }, 'Restore failed');
      return false;
    }
  }

  /** List all backups ordered by newest first. */
  listBackups(): BackupState[] {
    return this.db
      .prepare<[], BackupRow>('SELECT * FROM backups ORDER BY timestamp DESC')
      .all()
      .map(rowToBackup);
  }

  /**
   * Delete old backup records and files, keeping the N newest.
   *
   * @param keepCount - Number to keep (default 10).
   */
  pruneOldBackups(keepCount = 10): number {
    if (keepCount < 1) throw new TypeError('keepCount must be >= 1');

    const all      = this.listBackups();
    const toDelete = all.slice(keepCount);
    let pruned     = 0;

    for (const bk of toDelete) {
      try { if (existsSync(bk.location)) unlinkSync(bk.location); }
      catch (err) { log.warn({ location: bk.location, err: String(err) }, 'Could not delete file'); }
      this.db.prepare<{ id: string }>('DELETE FROM backups WHERE id = :id').run({ id: bk.id });
      pruned++;
    }

    log.info({ pruned, kept: Math.min(all.length, keepCount) }, 'Backups pruned');
    return pruned;
  }
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

export function rowToBackup(row: BackupRow): BackupState {
  let databases: string[];
  try { databases = JSON.parse(row.databases) as string[]; } catch { databases = []; }
  return {
    id:             row.id,
    timestamp:      row.timestamp,
    databases,
    totalSizeBytes: row.total_size_bytes,
    location:       row.location,
    verified:       row.verified === 1,
  };
}
