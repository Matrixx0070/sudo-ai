/**
 * @file store.ts
 * @description Rewind store — content-addressed file snapshots + checkpoints.
 *
 * Claude Code's `/rewind` restores BOTH the conversation and the files a turn
 * touched. sudo-ai had neither: only an opt-in per-file `.bak` on one tool. This
 * is the storage half — a small SQLite index plus a content-addressed blob dir,
 * so re-snapshotting an unchanged file costs nothing and a hundred checkpoints
 * of the same file share one blob.
 *
 * Layout:  data/rewind/rewind.db          (checkpoints, snapshots)
 *          data/rewind/blobs/<sha[0:2]>/<sha>   (file contents, deduped)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';

const log = createLogger('rewind:store');

/** Files larger than this are not snapshotted (a rewind store is not a backup system). */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface CheckpointRow {
  id: number;
  sessionId: string;
  label: string;
  tool: string | null;
  createdAt: string;
  fileCount: number;
}

export interface SnapshotRow {
  path: string;
  sha256: string | null;
  existedBefore: number;
}

let db: Database.Database | null = null;
let rootDir: string | null = null;

function root(): string {
  if (rootDir === null) {
    rootDir = dataPath('rewind');
    mkdirSync(join(rootDir, 'blobs'), { recursive: true });
  }
  return rootDir;
}

/** Directory the rewind store lives in (honours the test seam). */
export function rewindRoot(): string {
  return root();
}

export function getRewindDb(): Database.Database {
  if (db) return db;
  const d = new Database(join(root(), 'rewind.db'));
  d.pragma('journal_mode = WAL');
  d.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      label      TEXT NOT NULL,
      tool       TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ckpt_session ON checkpoints(session_id, id DESC);
    -- Conversation boundary: the highest message id that existed when the
    -- checkpoint was taken. Restoring the conversation means dropping messages
    -- ABOVE this id for the session. NULL = boundary unknown (older rows).
    
    CREATE TABLE IF NOT EXISTS snapshots (
      checkpoint_id  INTEGER NOT NULL,
      path           TEXT NOT NULL,
      sha256         TEXT,
      existed_before INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, path)
    );
  `);
  db = d;
  return d;
}

/** Test seam: close and forget the handle (and optionally re-root). */
export function __resetRewindStore(newRoot?: string): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  rootDir = newRoot ?? null;
  if (newRoot) mkdirSync(join(newRoot, 'blobs'), { recursive: true });
}

function blobPath(sha: string): string {
  return join(root(), 'blobs', sha.slice(0, 2), sha);
}

/** Store a file's bytes content-addressed; returns its sha, or null if too big/unreadable. */
export function putBlob(absPath: string): string | null {
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null;
    const buf = readFileSync(absPath);
    const sha = createHash('sha256').update(buf).digest('hex');
    const dest = blobPath(sha);
    if (!existsSync(dest)) {
      mkdirSync(join(root(), 'blobs', sha.slice(0, 2)), { recursive: true });
      writeFileSync(dest, buf);
    }
    return sha;
  } catch (err) {
    log.debug({ err: String(err), absPath }, 'putBlob failed (skipping snapshot)');
    return null;
  }
}

/** Read a stored blob back. */
export function getBlob(sha: string): Buffer | null {
  const p = blobPath(sha);
  return existsSync(p) ? readFileSync(p) : null;
}

/** Idempotently add the conversation-boundary column to an existing store. */
function ensureBoundaryColumn(d: Database.Database): void {
  try {
    d.exec('ALTER TABLE checkpoints ADD COLUMN message_boundary INTEGER');
  } catch {
    // already present
  }
}

export function setMessageBoundary(checkpointId: number, boundary: number | null): void {
  const d = getRewindDb();
  ensureBoundaryColumn(d);
  d.prepare('UPDATE checkpoints SET message_boundary = ? WHERE id = ?').run(boundary, checkpointId);
}

export function getMessageBoundary(checkpointId: number): number | null {
  const d = getRewindDb();
  ensureBoundaryColumn(d);
  const row = d.prepare('SELECT message_boundary AS b FROM checkpoints WHERE id = ?').get(checkpointId) as
    | { b: number | null }
    | undefined;
  return row?.b ?? null;
}

export function createCheckpoint(sessionId: string, label: string, tool?: string): number {
  const d = getRewindDb();
  const info = d
    .prepare('INSERT INTO checkpoints (session_id, label, tool, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, label, tool ?? null, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function addSnapshot(checkpointId: number, path: string, sha256: string | null, existedBefore: boolean): void {
  getRewindDb()
    .prepare('INSERT OR REPLACE INTO snapshots (checkpoint_id, path, sha256, existed_before) VALUES (?, ?, ?, ?)')
    .run(checkpointId, path, sha256, existedBefore ? 1 : 0);
}

export function listCheckpoints(sessionId: string, limit = 20): CheckpointRow[] {
  const rows = getRewindDb()
    .prepare(
      `SELECT c.id, c.session_id AS sessionId, c.label, c.tool, c.created_at AS createdAt,
              (SELECT COUNT(*) FROM snapshots s WHERE s.checkpoint_id = c.id) AS fileCount
         FROM checkpoints c WHERE c.session_id = ? ORDER BY c.id DESC LIMIT ?`,
    )
    .all(sessionId, limit) as CheckpointRow[];
  return rows;
}

export function getSnapshots(checkpointId: number): SnapshotRow[] {
  return getRewindDb()
    .prepare('SELECT path, sha256, existed_before AS existedBefore FROM snapshots WHERE checkpoint_id = ?')
    .all(checkpointId) as SnapshotRow[];
}

export function getCheckpoint(id: number): CheckpointRow | null {
  const row = getRewindDb()
    .prepare(
      `SELECT c.id, c.session_id AS sessionId, c.label, c.tool, c.created_at AS createdAt,
              (SELECT COUNT(*) FROM snapshots s WHERE s.checkpoint_id = c.id) AS fileCount
         FROM checkpoints c WHERE c.id = ?`,
    )
    .get(id) as CheckpointRow | undefined;
  return row ?? null;
}
