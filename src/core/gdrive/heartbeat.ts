/**
 * @file gdrive/heartbeat.ts
 * @description Liveness heartbeat writer — updates ops/heartbeat.json in the
 * shared Drive tree on a cron cadence (default 5 min). Consumed later by the
 * F34 Apps Script dead-man's switch: `now - lastBeat > threshold` => alert.
 *
 * The heartbeat file is updated IN PLACE (stable fileId) so the watcher never
 * has to re-search for it; the fileId is cached alongside the folder ids.
 */

import { hostname } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

export const HEARTBEAT_FILE_NAME = 'heartbeat.json';

export interface HeartbeatBody {
  lastBeat: string;
  host: string;
  pid: number;
  schemaVersion: 1;
}

function heartbeatIdCachePath(): string {
  return dataPath('gdrive', 'heartbeat-file-id.json');
}

function loadCachedFileId(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(heartbeatIdCachePath(), 'utf-8')) as { fileId?: string };
    return parsed.fileId ?? null;
  } catch {
    return null;
  }
}

function saveCachedFileId(fileId: string): void {
  const p = heartbeatIdCachePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ fileId }), { mode: 0o600 });
}

export function buildHeartbeatBody(now: Date = new Date()): HeartbeatBody {
  return { lastBeat: now.toISOString(), host: hostname(), pid: process.pid, schemaVersion: 1 };
}

/**
 * Write one heartbeat. Resolves the target file by cached id, then by name
 * under ops/, creating it on first run. Returns the fileId written.
 */
export async function writeHeartbeat(client: DriveClient, folders: FolderIdMap): Promise<string> {
  const opsId = folders['ops'];
  if (!opsId) throw new Error('gdrive heartbeat: ops folder id missing — bootstrap first');
  const body = JSON.stringify(buildHeartbeatBody(), null, 2);
  const media = { mimeType: 'application/json', body };

  const cached = loadCachedFileId();
  if (cached) {
    try {
      await client.filesUpdate(cached, {}, media);
      return cached;
    } catch {
      // Cached id stale (file trashed/deleted) — fall through to re-resolve.
    }
  }

  const existing = (await client.listChildren(opsId)).find((f) => f.name === HEARTBEAT_FILE_NAME);
  if (existing) {
    await client.filesUpdate(existing.id, {}, media);
    saveCachedFileId(existing.id);
    return existing.id;
  }
  const created = await client.filesCreate(
    { name: HEARTBEAT_FILE_NAME, parents: [opsId] },
    media,
  );
  saveCachedFileId(created.id);
  return created.id;
}

/** Test helper: cache presence probe. */
export function hasHeartbeatIdCache(): boolean {
  return existsSync(heartbeatIdCachePath());
}
