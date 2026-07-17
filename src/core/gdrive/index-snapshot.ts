/**
 * @file gdrive/index-snapshot.ts
 * @description F28 — embedding-index snapshots: a fresh machine hydrates the
 * retrieval index instead of re-embedding the corpus.
 *
 * Serializes the embedding_cache table (hash, model, float32 blob) -> gzip ->
 * AES-256-GCM (zone 1 — embeddings can leak content) -> content-hash-named
 * file in memory/index-snapshots/, keep last K. Hydration inserts missing
 * rows (INSERT OR IGNORE) so embedding-call count for already-known text is
 * ~0. Snapshot format versioned for the F36 migration chain.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { BrainKeys } from './keys.js';
import { encryptZone1, decryptZone1 } from './zones.js';
import { sha256Hex } from './manifest.js';

const log = createLogger('gdrive:index-snapshot');

export const SNAPSHOT_FORMAT_VERSION = 1;
export const KEEP_SNAPSHOTS = 3;

export interface EmbeddingRow {
  hash: string;
  model: string;
  /** base64 of the raw float32 bytes. */
  embeddingB64: string;
}

export interface IndexSnapshot {
  formatVersion: 1;
  createdAt: string;
  rows: EmbeddingRow[];
}

/** Duck-typed raw-DB surface (real impl: MindDB.db, better-sqlite3). */
export interface EmbeddingCacheDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

export function exportEmbeddingCache(db: EmbeddingCacheDb, now: string = new Date().toISOString()): IndexSnapshot {
  const rows = db
    .prepare('SELECT hash, model, embedding FROM embedding_cache')
    .all() as Array<{ hash: string; model: string; embedding: Buffer }>;
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    createdAt: now,
    rows: rows.map((r) => ({ hash: r.hash, model: r.model, embeddingB64: Buffer.from(r.embedding).toString('base64') })),
  };
}

/** INSERT OR IGNORE — existing local rows always win. Returns inserted count. */
export function importEmbeddingCache(db: EmbeddingCacheDb, snapshot: IndexSnapshot): number {
  if (snapshot.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(`index-snapshot: unsupported formatVersion ${String(snapshot.formatVersion)} — add a migration (F36)`);
  }
  const stmt = db.prepare('INSERT OR IGNORE INTO embedding_cache (hash, model, embedding) VALUES (?, ?, ?)');
  let inserted = 0;
  for (const row of snapshot.rows) {
    const res = stmt.run(row.hash, row.model, Buffer.from(row.embeddingB64, 'base64')) as { changes?: number };
    if ((res.changes ?? 0) > 0) inserted++;
  }
  return inserted;
}

export function packSnapshot(snapshot: IndexSnapshot, keys: BrainKeys): Buffer {
  if (!keys.encKey) throw new Error('index-snapshot: BRAIN_ENC_KEY_PATH required (embeddings are zone 1)');
  return encryptZone1(gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf-8')), keys.encKey);
}

export function unpackSnapshot(wire: Buffer, keys: BrainKeys): IndexSnapshot {
  if (!keys.encKey) throw new Error('index-snapshot: BRAIN_ENC_KEY_PATH required');
  return JSON.parse(gunzipSync(decryptZone1(wire, keys.encKey)).toString('utf-8')) as IndexSnapshot;
}

/** Upload a snapshot (content-hash named, dedup-skipped) + prune beyond K. */
export async function uploadIndexSnapshot(
  client: DriveClient,
  folders: FolderIdMap,
  db: EmbeddingCacheDb,
  keys: BrainKeys,
): Promise<{ name: string; uploaded: boolean; pruned: number }> {
  const folderId = folders['memory/index-snapshots'];
  if (!folderId) throw new Error('index-snapshot: memory/index-snapshots folder id missing');
  const snapshot = exportEmbeddingCache(db);
  const wire = packSnapshot(snapshot, keys);
  const name = `index-${sha256Hex(JSON.stringify(snapshot.rows)).slice(0, 16)}.enc`;
  const children = await client.listChildren(folderId);
  let uploaded = false;
  if (!children.some((f) => f.name === name)) {
    await client.filesCreate(
      { name, parents: [folderId] },
      { mimeType: 'application/octet-stream', body: Readable.from(wire) },
    );
    uploaded = true;
  }
  // Keep newest K (name list re-read after upload; sort by modifiedTime).
  const after = await client.listChildren(folderId);
  const sorted = after.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  let pruned = 0;
  for (const victim of sorted.slice(KEEP_SNAPSHOTS)) {
    await client.filesUpdate(victim.id, { trashed: true });
    pruned++;
  }
  log.info({ name, uploaded, rows: snapshot.rows.length, pruned }, 'index snapshot done');
  return { name, uploaded, pruned };
}

/** Hydrate the newest remote snapshot into the local cache (pairs with F2). */
export async function hydrateIndexSnapshot(
  client: DriveClient,
  folders: FolderIdMap,
  db: EmbeddingCacheDb,
  keys: BrainKeys,
): Promise<{ inserted: number } | null> {
  const folderId = folders['memory/index-snapshots'];
  if (!folderId) return null;
  const children = await client.listChildren(folderId);
  const newest = children.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''))[0];
  if (!newest) return null;
  const wire = await client.filesDownloadRaw(newest.id);
  const snapshot = unpackSnapshot(wire, keys);
  const inserted = importEmbeddingCache(db, snapshot);
  log.info({ snapshot: newest.name, inserted }, 'index snapshot hydrated');
  return { inserted };
}
