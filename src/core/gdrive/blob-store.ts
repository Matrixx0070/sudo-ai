/**
 * @file gdrive/blob-store.ts
 * @description F17/F29 — content-addressed blob push, verified hydration, GC.
 *
 * Push ordering makes partial failures harmless: blobs first (immutable,
 * deduped by content hash — re-uploading an existing hash is skipped), the
 * signed manifest LAST, updated in place so its Drive revision history is the
 * brain timeline (F9).
 *
 * Hydration is refuse-and-alert: HMAC failure, sha256 mismatch, or a zone-0
 * entry in a remote manifest aborts the whole load with local state untouched.
 *
 * Zone enforcement (F29): zone 0 is filtered out of the push payload before
 * anything leaves the process; zone 1 is encrypted and named by the sha256 of
 * the CIPHERTEXT; zone 2 is plaintext.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import {
  buildManifest,
  sha256Hex,
  verifyManifest,
  ManifestVerifyError,
  type BrainManifest,
  type EntryCategory,
  type ManifestEntry,
} from './manifest.js';
import { encryptZone1, decryptZone1, type Zone } from './zones.js';
import type { BrainKeys } from './keys.js';

const log = createLogger('gdrive:blob-store');

export const MANIFEST_FILE_NAME = 'manifest.json';

/** One logical brain item queued for sync. */
export interface BrainBlobInput {
  logicalPath: string;
  content: Buffer;
  zone: Zone;
  category: EntryCategory;
}

export interface PushResult {
  manifest: BrainManifest;
  uploadedBlobs: number;
  skippedBlobs: number;
  /** Zone-0 items filtered out before any payload was built. */
  filteredZone0: number;
  bytes: number;
}

export interface HydrateResult {
  manifest: BrainManifest;
  /** logicalPath -> decrypted plaintext content. */
  blobs: Map<string, Buffer>;
}

// ---------------------------------------------------------------------------
// Manifest fileId cache (same pattern as the heartbeat file)
// ---------------------------------------------------------------------------

function manifestIdCachePath(): string {
  return dataPath('gdrive', 'manifest-file-id.json');
}

function loadManifestFileId(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestIdCachePath(), 'utf-8')) as { fileId?: string };
    return parsed.fileId ?? null;
  } catch {
    return null;
  }
}

function saveManifestFileId(fileId: string): void {
  const p = manifestIdCachePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ fileId }), { mode: 0o600 });
}

async function resolveManifestFile(
  client: DriveClient,
  folders: FolderIdMap,
): Promise<string | null> {
  const cached = loadManifestFileId();
  if (cached) return cached;
  const manifestFolder = folders['manifest'];
  if (!manifestFolder) throw new Error('gdrive blob-store: manifest folder id missing — bootstrap first');
  const existing = (await client.listChildren(manifestFolder)).find(
    (f) => f.name === MANIFEST_FILE_NAME,
  );
  if (existing) {
    saveManifestFileId(existing.id);
    return existing.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prepared (wire-format) blob
// ---------------------------------------------------------------------------

interface PreparedBlob {
  entry: ManifestEntry;
  /** The exact bytes to upload (ciphertext for zone 1). */
  wire: Buffer;
}

/**
 * Convert inputs into wire blobs + manifest entries. Zone 0 is dropped HERE,
 * before any Drive-bound structure exists (test-asserted invariant).
 */
export function prepareBlobs(
  inputs: BrainBlobInput[],
  keys: BrainKeys,
): { prepared: PreparedBlob[]; filteredZone0: number } {
  const prepared: PreparedBlob[] = [];
  let filteredZone0 = 0;
  for (const input of inputs) {
    if (input.zone === 0) {
      filteredZone0++;
      continue;
    }
    let wire: Buffer;
    let suffix = '';
    if (input.zone === 1) {
      if (!keys.encKey) {
        throw new Error(
          `gdrive blob-store: zone-1 item "${input.logicalPath}" but BRAIN_ENC_KEY_PATH not configured`,
        );
      }
      wire = encryptZone1(input.content, keys.encKey);
      suffix = '.enc';
    } else {
      wire = input.content;
    }
    const hash = sha256Hex(wire);
    prepared.push({
      wire,
      entry: {
        logicalPath: input.logicalPath,
        blob: `memory/blobs/${hash}${suffix}`,
        sha256: hash,
        zone: input.zone,
        bytes: wire.length,
        category: input.category,
      },
    });
  }
  return { prepared, filteredZone0 };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * Push a full brain snapshot: dedup + upload missing blobs, then sign and
 * upload the manifest last (update-in-place for revision history).
 */
export async function pushBrain(
  client: DriveClient,
  folders: FolderIdMap,
  inputs: BrainBlobInput[],
  keys: BrainKeys,
  opts: { brainId?: string; counter: number; createdAt: string },
): Promise<PushResult> {
  const blobsFolder = folders['memory/blobs'];
  const manifestFolder = folders['manifest'];
  if (!blobsFolder || !manifestFolder) {
    throw new Error('gdrive blob-store: folder ids missing — bootstrap first');
  }

  const { prepared, filteredZone0 } = prepareBlobs(inputs, keys);

  // Existing blob names — content hash in the name makes dedup a set lookup.
  const existingNames = new Set((await client.listChildren(blobsFolder)).map((f) => f.name));

  let uploadedBlobs = 0;
  let skippedBlobs = 0;
  let bytes = 0;
  for (const { entry, wire } of prepared) {
    const name = entry.blob.split('/').pop()!;
    if (existingNames.has(name)) {
      skippedBlobs++;
      continue;
    }
    await client.filesCreate(
      { name, parents: [blobsFolder] },
      { mimeType: 'application/octet-stream', body: bufferToStream(wire) },
    );
    existingNames.add(name);
    uploadedBlobs++;
    bytes += wire.length;
  }

  const manifest = buildManifest(
    {
      brainId: opts.brainId ?? 'main',
      counter: opts.counter,
      createdAt: opts.createdAt,
      entries: prepared.map((p) => p.entry),
    },
    keys.hmacKey,
  );
  const body = JSON.stringify(manifest, null, 2);
  const media = { mimeType: 'application/json', body };

  const manifestId = await resolveManifestFile(client, folders);
  if (manifestId) {
    await client.filesUpdate(manifestId, {}, media);
  } else {
    const created = await client.filesCreate(
      { name: MANIFEST_FILE_NAME, parents: [manifestFolder] },
      media,
    );
    saveManifestFileId(created.id);
  }

  log.info({ uploadedBlobs, skippedBlobs, filteredZone0, counter: manifest.counter }, 'brain pushed');
  return { manifest, uploadedBlobs, skippedBlobs, filteredZone0, bytes };
}

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

/**
 * Download + fully verify the remote brain. Any integrity failure throws
 * (refuse-and-alert) — callers keep local state and audit the refusal.
 */
export async function hydrateBrain(
  client: DriveClient,
  folders: FolderIdMap,
  keys: BrainKeys,
): Promise<HydrateResult> {
  const manifestId = await resolveManifestFile(client, folders);
  if (!manifestId) throw new ManifestVerifyError('no remote manifest found');
  const raw = await client.filesDownload(manifestId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ManifestVerifyError('remote manifest is not valid JSON');
  }
  const manifest = verifyManifest(parsed, keys.hmacKey); // throws on tamper

  const blobsFolder = folders['memory/blobs'];
  if (!blobsFolder) throw new Error('gdrive blob-store: blobs folder id missing');
  const byName = new Map(
    (await client.listChildren(blobsFolder)).map((f) => [f.name, f.id] as const),
  );

  const blobs = new Map<string, Buffer>();
  for (const entry of manifest.entries) {
    const name = entry.blob.split('/').pop()!;
    const fileId = byName.get(name);
    if (!fileId) throw new ManifestVerifyError(`blob missing in Drive: ${entry.blob}`);
    const wire = await client.filesDownloadRaw(fileId);
    if (sha256Hex(wire) !== entry.sha256) {
      throw new ManifestVerifyError(
        `sha256 mismatch for ${entry.logicalPath} (${entry.blob}) — blob tampered; refusing hydration`,
      );
    }
    let content = wire;
    if (entry.zone === 1) {
      if (!keys.encKey) {
        throw new ManifestVerifyError(
          `zone-1 entry ${entry.logicalPath} but BRAIN_ENC_KEY_PATH not configured`,
        );
      }
      content = decryptZone1(wire, keys.encKey);
    }
    blobs.set(entry.logicalPath, content);
  }
  return { manifest, blobs };
}

// ---------------------------------------------------------------------------
// GC (trash-aware forgetting rider)
// ---------------------------------------------------------------------------

/**
 * Trash blobs unreferenced by any of the given manifests (recent history +
 * pinned releases). Drive trash gives a 30-day undo window; permanent delete
 * is Drive's own trash expiry — we never hard-delete here.
 */
export async function gcBlobs(
  client: DriveClient,
  folders: FolderIdMap,
  keepManifests: BrainManifest[],
): Promise<{ trashed: number }> {
  const blobsFolder = folders['memory/blobs'];
  if (!blobsFolder) throw new Error('gdrive blob-store: blobs folder id missing');
  const referenced = new Set(
    keepManifests.flatMap((m) => m.entries.map((e) => e.blob.split('/').pop()!)),
  );
  let trashed = 0;
  for (const f of await client.listChildren(blobsFolder)) {
    if (!referenced.has(f.name)) {
      await client.filesUpdate(f.id, { trashed: true });
      trashed++;
    }
  }
  if (trashed > 0) log.info({ trashed }, 'gc trashed unreferenced blobs (30-day undo)');
  return { trashed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferToStream(buf: Buffer): NodeJS.ReadableStream {
  return Readable.from(buf);
}

/** Test/ops probe. */
export function hasManifestIdCache(): boolean {
  return existsSync(manifestIdCachePath());
}
