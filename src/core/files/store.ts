/**
 * @file store.ts
 * @description FileStore — SQLite-backed file metadata store + on-disk I/O.
 *
 * Storage layout:  workspace/files/<2-char sha256 prefix>/<file-id>
 *
 * Security:
 *  - Filenames are validated (path-traversal, null bytes) before storage.
 *  - SHA-256 is always computed server-side; client value never trusted.
 *  - Soft delete only: deleted_at is set, file bytes remain on disk.
 *  - mountFilesForSession copies files read-only (chmod 0o444).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database, Statement } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { createLogger } from '../shared/logger.js';
import {
  FileStoreError,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SESSION,
  STORAGE_PREFIX_LEN,
  type FileRow,
  type FileMetadata,
  type CreateFileInput,
  type ListFilesOptions,
} from './types.js';

const log = createLogger('files:store');

// ---------------------------------------------------------------------------
// FileStore
// ---------------------------------------------------------------------------

export class FileStore {
  private readonly db: Database;
  private readonly baseDir: string;
  private readonly workspaceRoot: string;

  // Prepared statements
  private readonly stmtInsert:      Statement;
  private readonly stmtGetById:     Statement;
  private readonly stmtList:        Statement;
  private readonly stmtListScoped:  Statement;
  private readonly stmtSoftDelete:  Statement;
  private readonly stmtCountScope:  Statement;

  constructor(db: Database, baseDir: string, workspaceRoot?: string) {
    this.db = db;
    this.baseDir = baseDir;
    this.workspaceRoot = workspaceRoot ?? path.join(process.cwd(), 'workspace');

    this.runMigration();

    this.stmtInsert = db.prepare(`
      INSERT INTO files (id, filename, mime, size_bytes, sha256, scope_id, storage_path, uploaded_at)
      VALUES (@id, @filename, @mime, @size_bytes, @sha256, @scope_id, @storage_path, @uploaded_at)
    `);

    this.stmtGetById = db.prepare(`
      SELECT * FROM files WHERE id = ? AND deleted_at IS NULL
    `);

    this.stmtList = db.prepare(`
      SELECT * FROM files WHERE deleted_at IS NULL
      ORDER BY uploaded_at DESC
      LIMIT ? OFFSET ?
    `);

    this.stmtListScoped = db.prepare(`
      SELECT * FROM files WHERE scope_id = ? AND deleted_at IS NULL
      ORDER BY uploaded_at DESC
      LIMIT ? OFFSET ?
    `);

    this.stmtSoftDelete = db.prepare(`
      UPDATE files
      SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND deleted_at IS NULL
    `);

    this.stmtCountScope = db.prepare(`
      SELECT COUNT(*) as cnt FROM files WHERE scope_id = ? AND deleted_at IS NULL
    `);
  }

  // ---------------------------------------------------------------------------
  // Migration
  // ---------------------------------------------------------------------------

  private runMigration(): void {
    const sql = `
      CREATE TABLE IF NOT EXISTS files (
        id           TEXT    NOT NULL PRIMARY KEY,
        filename     TEXT    NOT NULL,
        mime         TEXT    NOT NULL,
        size_bytes   INTEGER NOT NULL CHECK(size_bytes >= 0),
        sha256       TEXT    NOT NULL,
        scope_id     TEXT    NOT NULL,
        storage_path TEXT    NOT NULL,
        uploaded_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        deleted_at   TEXT    DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_scope_id ON files(scope_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_files_sha256   ON files(sha256)   WHERE deleted_at IS NULL;
    `;
    this.db.exec(sql);
    log.debug('files migration complete');
  }

  // ---------------------------------------------------------------------------
  // Write file to disk
  // ---------------------------------------------------------------------------

  /**
   * Write raw bytes to disk under the content-addressed fanout path.
   * Returns the resolved storage_path.
   */
  writeFileToDisk(fileId: string, sha256: string, data: Buffer): string {
    const prefix = sha256.slice(0, STORAGE_PREFIX_LEN);
    const dir = path.join(this.baseDir, prefix);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileId);
    fs.writeFileSync(filePath, data, { mode: 0o644 });
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /**
   * Check the file count cap for a scope WITHOUT creating a record.
   * Throws FileStoreError with code `file_cap_exceeded` if the session already
   * holds MAX_FILES_PER_SESSION files.  Call this BEFORE writing bytes to disk
   * so that a rejection does not leave an orphan file.
   */
  checkCap(scopeId: string): void {
    const countRow = this.stmtCountScope.get(scopeId) as { cnt: number };
    if (countRow.cnt >= MAX_FILES_PER_SESSION) {
      throw new FileStoreError(
        `Session "${scopeId}" has reached the ${MAX_FILES_PER_SESSION}-file limit`,
        'file_cap_exceeded',
        { scope_id: scopeId, count: countRow.cnt },
      );
    }
  }

  /**
   * Persist file metadata. The caller must have already written bytes to disk
   * and set storage_path in the input.
   */
  create(input: CreateFileInput): FileMetadata {
    const { scope_id } = input;

    const countRow = this.stmtCountScope.get(scope_id) as { cnt: number };
    if (countRow.cnt >= MAX_FILES_PER_SESSION) {
      throw new FileStoreError(
        `Session "${scope_id}" has reached the ${MAX_FILES_PER_SESSION}-file limit`,
        'file_cap_exceeded',
        { scope_id, count: countRow.cnt },
      );
    }

    const id = `file_${nanoid()}`;
    const uploaded_at = new Date().toISOString().replace('T', 'T').replace(/\.\d{3}Z$/, match => match);
    const row: FileRow = { ...input, id, uploaded_at, deleted_at: null };

    this.stmtInsert.run({
      id:           row.id,
      filename:     row.filename,
      mime:         row.mime,
      size_bytes:   row.size_bytes,
      sha256:       row.sha256,
      scope_id:     row.scope_id,
      storage_path: row.storage_path,
      uploaded_at:  row.uploaded_at,
    });

    log.info({ id, scope_id, filename: input.filename, size_bytes: input.size_bytes }, 'file created');
    return rowToMeta(row);
  }

  /** Retrieve metadata for a single (non-deleted) file. */
  getById(id: string): FileMetadata | null {
    if (!id) return null;
    const row = this.stmtGetById.get(id) as FileRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  /** Retrieve full row including storage_path. Internal use only. */
  getRowById(id: string): FileRow | null {
    if (!id) return null;
    return (this.stmtGetById.get(id) as FileRow | undefined) ?? null;
  }

  /** List files, optionally filtered by scope_id. */
  list(opts: ListFilesOptions = {}): FileMetadata[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;
    let rows: FileRow[];
    if (opts.scope_id) {
      rows = this.stmtListScoped.all(opts.scope_id, limit, offset) as FileRow[];
    } else {
      rows = this.stmtList.all(limit, offset) as FileRow[];
    }
    return rows.map(rowToMeta);
  }

  /**
   * Soft-delete a file. Returns true if deleted, false if not found.
   */
  softDelete(id: string): boolean {
    const result = this.stmtSoftDelete.run(id);
    if (result.changes > 0) {
      log.info({ id }, 'file soft-deleted');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Mount integration
  // ---------------------------------------------------------------------------

  /**
   * Copy all active files scoped to `sessionId` into `targetDir`.
   * Each file is copied flat (filename only) and set to read-only (0o444).
   * Subdirectories in target are created as needed.
   *
   * @param sessionId - The scope_id to filter files by.
   * @param targetDir - Destination directory (must exist or be creatable).
   */
  mountFilesForSession(sessionId: string, targetDir: string): void {
    if (!sessionId) throw new FileStoreError('sessionId is required', 'file_invalid_input');

    fs.mkdirSync(targetDir, { recursive: true });

    // Validate targetDir is inside workspaceRoot to prevent path-traversal during mount
    const resolvedRoot = path.resolve(this.workspaceRoot);
    const resolved = fs.realpathSync(targetDir);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw new FileStoreError(
        `Mount target "${targetDir}" is outside workspace root "${this.workspaceRoot}"`,
        'file_target_out_of_root',
        { targetDir, workspaceRoot: this.workspaceRoot },
      );
    }

    const rows = this.stmtListScoped.all(sessionId, MAX_FILES_PER_SESSION, 0) as FileRow[];
    log.info({ sessionId, targetDir, count: rows.length }, 'mounting files for session');

    for (const row of rows) {
      const dest = path.join(targetDir, row.filename);
      try {
        fs.copyFileSync(row.storage_path, dest);
        fs.chmodSync(dest, 0o444);
        log.debug({ src: row.storage_path, dest }, 'file mounted read-only');
      } catch (err) {
        log.warn({ err: String(err), id: row.id, dest }, 'failed to mount file — skipping');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToMeta(row: FileRow): FileMetadata {
  return {
    id:          row.id,
    filename:    row.filename,
    mime:        row.mime,
    size_bytes:  row.size_bytes,
    sha256:      row.sha256,
    scope_id:    row.scope_id,
    uploaded_at: row.uploaded_at,
  };
}

/**
 * Compute SHA-256 hex digest of a Buffer.
 */
export function computeSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
