/**
 * @file notebooklm/folders.ts
 * @description Self-contained NotebookLM folder subtree under sudo-ai/notebooklm/
 * (D-N0.5: NOT appended to gdrive CANONICAL_FOLDERS, so the base tree stays clean
 * when the annex is disabled). Reuses DriveClient.createFolder/listChildren
 * primitives — no forked plumbing. Idempotent; ids cached 0600.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { FOLDER_MIME, type DriveClient } from '../gdrive/client.js';

/** Logical paths relative to the sudo-ai root (parents-before-children). */
export const NOTEBOOKLM_FOLDERS: readonly string[] = [
  'notebooklm',
  'notebooklm/daily',
  'notebooklm/cockpit',
  'notebooklm/architecture',
  'notebooklm/incidents',
  'notebooklm/probes',
  'notebooklm/approvals',
  'notebooklm/reception',
  'notebooklm/skills',
  'notebooklm/debates',
  'notebooklm/corpora',
  'notebooklm/studypacks',
  'notebooklm/releases',
  'notebooklm/releases/forks-museum',
  'notebooklm/succession',
  'notebooklm/succession/operator-pack',
  'notebooklm/embassy',
  'notebooklm/embassy/outbound',
  'notebooklm/returns',
  'notebooklm/returns/processed',
  'notebooklm/returns/held',
  'notebooklm/rituals',
];

/** logicalPath -> Drive folderId. */
export type NlmFolderMap = Record<string, string>;

function cachePath(): string {
  return dataPath('notebooklm', 'folder-ids.json');
}

interface CacheFile {
  rootFolderId: string;
  folders: NlmFolderMap;
}

export function loadNlmFolderCache(rootFolderId: string): NlmFolderMap | null {
  try {
    if (!existsSync(cachePath())) return null;
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf-8')) as CacheFile;
    if (parsed.rootFolderId !== rootFolderId) return null;
    return parsed.folders ?? null;
  } catch {
    return null;
  }
}

function saveCache(rootFolderId: string, folders: NlmFolderMap): void {
  const p = cachePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ rootFolderId, folders }, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort */
  }
}

/**
 * Ensure the notebooklm subtree exists under rootFolderId. Warm cache costs
 * zero Drive calls. Resolves existing folders by name (never duplicates).
 */
export async function ensureNotebookLmTree(
  client: DriveClient,
  rootFolderId: string,
  opts: { force?: boolean } = {},
): Promise<NlmFolderMap> {
  if (!opts.force) {
    const cached = loadNlmFolderCache(rootFolderId);
    if (cached && NOTEBOOKLM_FOLDERS.every((f) => typeof cached[f] === 'string')) return cached;
  }

  const map: NlmFolderMap = {};
  const childrenCache = new Map<string, Map<string, string>>();
  const childFolders = async (parentId: string): Promise<Map<string, string>> => {
    const hit = childrenCache.get(parentId);
    if (hit) return hit;
    const byName = new Map<string, string>();
    for (const k of await client.listChildren(parentId)) {
      if (k.mimeType === FOLDER_MIME && k.name && k.id) byName.set(k.name, k.id);
    }
    childrenCache.set(parentId, byName);
    return byName;
  };

  for (const logical of NOTEBOOKLM_FOLDERS) {
    const segments = logical.split('/');
    const name = segments[segments.length - 1]!;
    const parentLogical = segments.slice(0, -1).join('/');
    const parentId = parentLogical === '' ? rootFolderId : map[parentLogical]!;
    const siblings = await childFolders(parentId);
    let id = siblings.get(name);
    if (!id) {
      id = (await client.createFolder(name, parentId)).id;
      siblings.set(name, id);
    }
    map[logical] = id;
  }

  saveCache(rootFolderId, map);
  return map;
}
