/**
 * @file gdrive/blob-gc.ts
 * @description Blob GC driver — the missing production caller for
 * `gcBlobs()` (DRIVE_SECURITY_AUDIT weak point: zone re-classification
 * renames blobs on checkpoint, leaving the old-named blobs on Drive until
 * someone sweeps).
 *
 * Keep-set assembly is the safety core: manifests live as REVISIONS of the
 * single manifest.json (F36 pins release boundaries with keepForever), so the
 * keep-set = the last `keepRecent` revisions PLUS every keepForever revision,
 * each HMAC-verified. FAIL-CLOSED: if ANY manifest in the keep window cannot
 * be fetched or verified, the sweep ABORTS — we never trash blobs while
 * uncertain what is referenced. gcBlobs itself only TRASHES (Drive 30-day
 * undo); nothing here hard-deletes.
 *
 * Wired as a rider on the checkpoint cron (never the agent hot path);
 * SUDO_GDRIVE_BLOB_GC=0 disables. GC failures never fail the checkpoint.
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { BrainKeys } from './keys.js';
import { gcBlobs, resolveManifestFile } from './blob-store.js';
import { verifyManifest, type BrainManifest } from './manifest.js';

const log = createLogger('gdrive:blob-gc');

export function blobGcEnabled(): boolean {
  return process.env['SUDO_GDRIVE_BLOB_GC'] !== '0';
}

/** How many most-recent manifest revisions anchor the keep-set (generous). */
export const KEEP_RECENT_REVISIONS = 20;

export interface BlobGcResult {
  ran: boolean;
  trashed: number;
  keptManifests: number;
  reason?: string;
}

/**
 * Assemble the verified keep-set from manifest revisions. Throws when any
 * revision in the window fails fetch/verify — the caller treats that as
 * "do not sweep".
 */
export async function assembleKeepManifests(
  client: DriveClient,
  folders: FolderIdMap,
  keys: BrainKeys,
  keepRecent = KEEP_RECENT_REVISIONS,
): Promise<BrainManifest[]> {
  const fileId = await resolveManifestFile(client, folders);
  if (!fileId) throw new Error('manifest file not found — nothing to anchor a sweep');
  const revisions = await client.revisionsList(fileId);
  if (revisions.length === 0) throw new Error('no manifest revisions returned');
  const recent = revisions.slice(-keepRecent);
  const pinned = revisions.filter((r) => r.keepForever === true);
  const wanted = new Map<string, true>();
  for (const r of [...recent, ...pinned]) if (r.id) wanted.set(r.id, true);

  const manifests: BrainManifest[] = [];
  for (const revisionId of wanted.keys()) {
    const raw = await client.revisionsGetContent(fileId, revisionId);
    // verifyManifest throws on tamper/shape mismatch — bubbled to abort the sweep.
    manifests.push(verifyManifest(JSON.parse(raw), keys.hmacKey));
  }
  return manifests;
}

/** One sweep: assemble keep-set (fail-closed) then trash unreferenced blobs. */
export async function runBlobGc(
  client: DriveClient,
  folders: FolderIdMap,
  keys: BrainKeys,
): Promise<BlobGcResult> {
  if (!blobGcEnabled()) return { ran: false, trashed: 0, keptManifests: 0, reason: 'SUDO_GDRIVE_BLOB_GC=0' };
  try {
    const keep = await assembleKeepManifests(client, folders, keys);
    const { trashed } = await gcBlobs(client, folders, keep);
    log.info({ trashed, keptManifests: keep.length }, 'Blob GC sweep complete');
    return { ran: true, trashed, keptManifests: keep.length };
  } catch (err) {
    // Fail-closed = fail-quiet for the sweep itself: uncertainty means no
    // trashing, and the checkpoint that invoked us is unaffected.
    log.warn({ err: String(err) }, 'Blob GC aborted — keep-set could not be verified; nothing trashed');
    return { ran: false, trashed: 0, keptManifests: 0, reason: String(err) };
  }
}
