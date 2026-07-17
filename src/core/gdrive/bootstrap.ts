/**
 * @file gdrive/bootstrap.ts
 * @description Idempotent canonical folder-tree bootstrap + local folder-ID cache.
 *
 * Creates the roadmap's canonical layout under the shared root folder on
 * first run; every later run resolves from the local cache and only touches
 * Drive for paths missing from it. Cache: data/gdrive/folder-ids.json (0600).
 *
 * Canary files (F19) are deliberately NOT part of this tree.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { FOLDER_MIME, type DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

/** Canonical logical folder paths (relative to the shared sudo-ai/ root). */
export const CANONICAL_FOLDERS: readonly string[] = [
  'manifest',
  'memory',
  'memory/blobs',
  'memory/chronicle',
  'memory/dead-ends',
  'memory/index-snapshots',
  'knowledge',
  'knowledge/inbox',
  'knowledge/quarantine',
  'knowledge/processed',
  'knowledge/mirror',
  'knowledge/curiosity',
  'skills',
  'skills/candidates',
  'skills/stable',
  'brains',
  'brains/releases',
  'brains/forks',
  'tasks',
  'tasks/active',
  'tasks/blackboard',
  'tasks/proposals',
  'datasets',
  'evals',
  'evals/gym',
  'ops',
  'ops/reports',
  'ops/review-queue',
  'ops/incidents',
  'ops/audit',
];

export function folderIdCachePath(): string {
  return dataPath('gdrive', 'folder-ids.json');
}

interface FolderIdCacheFile {
  rootFolderId: string;
  folders: FolderIdMap;
}

export function loadFolderIdCache(rootFolderId: string): FolderIdMap | null {
  const p = folderIdCachePath();
  try {
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as FolderIdCacheFile;
    // A different root means a different Drive tree — never reuse those ids.
    if (parsed.rootFolderId !== rootFolderId) return null;
    return parsed.folders ?? null;
  } catch {
    return null;
  }
}

export function saveFolderIdCache(rootFolderId: string, folders: FolderIdMap): void {
  const p = folderIdCachePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ rootFolderId, folders }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {
    /* rename preserved tmp mode on POSIX; best-effort elsewhere */
  }
}

/**
 * Ensure the canonical tree exists under rootFolderId. Resolves existing
 * folders by name (never duplicates), creates missing ones, returns the full
 * logical-path -> folderId map, and persists it to the local cache.
 *
 * Idempotent: safe to run on every boot; a warm cache costs zero Drive calls
 * unless `force` is set.
 */
export async function ensureFolderTree(
  client: DriveClient,
  rootFolderId: string,
  opts: { force?: boolean } = {},
): Promise<FolderIdMap> {
  if (!opts.force) {
    const cached = loadFolderIdCache(rootFolderId);
    if (cached && CANONICAL_FOLDERS.every((f) => typeof cached[f] === 'string')) {
      return cached;
    }
  }

  const map: FolderIdMap = {};
  // Children listing is cached per parent so each level lists exactly once.
  const childrenCache = new Map<string, Map<string, string>>();

  const childFolders = async (parentId: string): Promise<Map<string, string>> => {
    const hit = childrenCache.get(parentId);
    if (hit) return hit;
    const kids = await client.listChildren(parentId);
    const byName = new Map<string, string>();
    for (const k of kids) {
      if (k.mimeType === FOLDER_MIME && k.name && k.id) byName.set(k.name, k.id);
    }
    childrenCache.set(parentId, byName);
    return byName;
  };

  // CANONICAL_FOLDERS is ordered parents-before-children, so a single pass
  // resolves each segment against its (already-resolved) parent.
  for (const logical of CANONICAL_FOLDERS) {
    const segments = logical.split('/');
    const name = segments[segments.length - 1]!;
    const parentLogical = segments.slice(0, -1).join('/');
    const parentId = parentLogical === '' ? rootFolderId : map[parentLogical]!;
    const siblings = await childFolders(parentId);
    let id = siblings.get(name);
    if (!id) {
      const created = await client.createFolder(name, parentId);
      id = created.id;
      siblings.set(name, id);
    }
    map[logical] = id;
  }

  saveFolderIdCache(rootFolderId, map);
  return map;
}

/** Test/ops helper: where the cache lives for a given DATA_DIR. */
export function describeCache(): { path: string } {
  return { path: join(folderIdCachePath()) };
}
