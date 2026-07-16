/**
 * @file gdrive/releases.ts
 * @description F36 — named immutable brain releases + revision pinning.
 *
 * A release copies the CURRENT manifest to brains/releases/ as its own file
 * (never edited afterwards — uncapped, unlike pinned revisions) and pins the
 * main manifest's current head revision with keepRevisionForever so bisection
 * ranges (F9) survive Drive's revision pruning. Pins are capped by Drive, so
 * rotation keeps only the most recent MAX_PINNED.
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import { MANIFEST_FILE_NAME } from './blob-store.js';

const log = createLogger('gdrive:releases');

/** Drive caps keepForever pins (200/file); rotate well below it. */
export const MAX_PINNED_REVISIONS = 25;

export interface ReleaseResult {
  releaseFileId: string;
  releaseName: string;
  pinnedRevisionId?: string;
  unpinned: number;
}

async function findManifestFileId(client: DriveClient, folders: FolderIdMap): Promise<string> {
  const manifestFolder = folders['manifest'];
  if (!manifestFolder) throw new Error('gdrive releases: manifest folder id missing');
  const f = (await client.listChildren(manifestFolder)).find((x) => x.name === MANIFEST_FILE_NAME);
  if (!f) throw new Error('gdrive releases: no manifest to release');
  return f.id;
}

/**
 * Create a named release from the current manifest: copy its exact bytes to
 * brains/releases/brain-<date>-<tag>.json and pin the head revision.
 */
export async function createRelease(
  client: DriveClient,
  folders: FolderIdMap,
  tag: string,
  opts: { date?: string } = {},
): Promise<ReleaseResult> {
  const releasesFolder = folders['brains/releases'];
  if (!releasesFolder) throw new Error('gdrive releases: brains/releases folder id missing');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(tag)) {
    throw new Error(`gdrive releases: invalid tag "${tag}" (alnum + dashes, max 64)`);
  }

  const manifestId = await findManifestFileId(client, folders);
  const bytes = await client.filesDownload(manifestId);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const releaseName = `brain-${date}-${tag}.json`;

  const existing = (await client.listChildren(releasesFolder)).find((f) => f.name === releaseName);
  if (existing) throw new Error(`gdrive releases: release ${releaseName} already exists (immutable)`);

  const created = await client.filesCreate(
    { name: releaseName, parents: [releasesFolder] },
    { mimeType: 'application/json', body: bytes },
  );

  // Pin the manifest's newest revision + rotate old pins (cap-aware).
  let pinnedRevisionId: string | undefined;
  let unpinned = 0;
  const revisions = await client.revisionsList(manifestId);
  const head = revisions[revisions.length - 1];
  if (head?.id) {
    await client.revisionsSetKeepForever(manifestId, head.id, true);
    pinnedRevisionId = head.id;
    const pinned = revisions.filter((r) => r.keepForever && r.id !== head.id);
    const excess = pinned.length + 1 - MAX_PINNED_REVISIONS;
    for (let i = 0; i < excess; i++) {
      const victim = pinned[i];
      if (victim?.id) {
        await client.revisionsSetKeepForever(manifestId, victim.id, false);
        unpinned++;
      }
    }
  }

  log.info({ releaseName, pinnedRevisionId, unpinned }, 'brain release created');
  return { releaseFileId: created.id, releaseName, pinnedRevisionId, unpinned };
}

/** Download + return a release manifest's raw JSON text (never mutated). */
export async function getRelease(
  client: DriveClient,
  folders: FolderIdMap,
  releaseName: string,
): Promise<string> {
  const releasesFolder = folders['brains/releases'];
  if (!releasesFolder) throw new Error('gdrive releases: brains/releases folder id missing');
  const f = (await client.listChildren(releasesFolder)).find((x) => x.name === releaseName);
  if (!f) throw new Error(`gdrive releases: release not found: ${releaseName}`);
  return client.filesDownload(f.id);
}
