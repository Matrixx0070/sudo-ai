/**
 * @file gdrive/manifest.ts
 * @description F17 — the HMAC-signed brain manifest.
 *
 * Blobs are immutable and content-addressed; the manifest is the single
 * source of truth for what the brain contains. It is signed with
 * HMAC-SHA256 over canonical JSON (sorted keys, `hmac` excluded) using the
 * local BRAIN_HMAC_KEY_PATH key. Concurrent writers resolve by newest
 * manifest wins (createdAt + monotonic counter); losing blobs stay in Drive
 * untouched (divergence handled by the dream cycle, F12).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import type { Zone } from './zones.js';

export type EntryCategory = 'knowledge' | 'policy' | 'skill';

export interface ManifestEntry {
  logicalPath: string;
  /** Drive-relative blob path, e.g. "memory/blobs/<sha256>[.enc]". */
  blob: string;
  /** sha256 (hex) of the UPLOADED bytes (ciphertext for zone 1). */
  sha256: string;
  zone: Zone;
  bytes: number;
  category: EntryCategory;
}

export interface BrainManifest {
  schemaVersion: 1;
  brainId: string;
  /** Monotonic push counter — tie-break for newest-manifest-wins. */
  counter: number;
  createdAt: string;
  entries: ManifestEntry[];
  hmac: string;
}

export class ManifestVerifyError extends Error {
  constructor(message: string) {
    super(`manifest: ${message}`);
    this.name = 'ManifestVerifyError';
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** HMAC over the canonical JSON of the manifest with `hmac` excluded. */
export function computeManifestHmac(
  manifest: Omit<BrainManifest, 'hmac'> & { hmac?: string },
  key: Buffer,
): string {
  const { hmac: _drop, ...unsigned } = manifest;
  return createHmac('sha256', key).update(canonicalJson(unsigned)).digest('hex');
}

/** Build + sign a manifest from entries. */
export function buildManifest(
  params: {
    brainId: string;
    counter: number;
    createdAt: string;
    entries: ManifestEntry[];
  },
  key: Buffer,
): BrainManifest {
  const unsigned = { schemaVersion: 1 as const, ...params };
  return { ...unsigned, hmac: computeManifestHmac(unsigned, key) };
}

/**
 * Verify a downloaded manifest. Throws ManifestVerifyError on any problem —
 * callers refuse-and-alert, keeping local state (never "best-effort" load).
 */
export function verifyManifest(candidate: unknown, key: Buffer): BrainManifest {
  const m = candidate as BrainManifest;
  if (!m || typeof m !== 'object') throw new ManifestVerifyError('not an object');
  if (m.schemaVersion !== 1) {
    throw new ManifestVerifyError(
      `unsupported schemaVersion ${String(m.schemaVersion)} — run migrations (F36)`,
    );
  }
  if (typeof m.hmac !== 'string' || m.hmac.length !== 64) {
    throw new ManifestVerifyError('missing/malformed hmac');
  }
  if (!Array.isArray(m.entries) || typeof m.counter !== 'number' || typeof m.brainId !== 'string') {
    throw new ManifestVerifyError('malformed manifest body');
  }
  const expected = computeManifestHmac(m, key);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(m.hmac, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ManifestVerifyError('HMAC mismatch — manifest tampered or wrong key; refusing');
  }
  for (const e of m.entries) {
    if (
      typeof e.logicalPath !== 'string' ||
      typeof e.blob !== 'string' ||
      typeof e.sha256 !== 'string' ||
      typeof e.bytes !== 'number' ||
      (e.zone !== 1 && e.zone !== 2) // zone 0 must NEVER appear in a synced manifest
    ) {
      throw new ManifestVerifyError(
        `malformed/forbidden entry for ${String((e as { logicalPath?: string }).logicalPath)}`,
      );
    }
  }
  return m;
}

/** Newest-manifest-wins comparison (counter first, then createdAt). */
export function isNewerManifest(a: BrainManifest, b: BrainManifest): boolean {
  if (a.counter !== b.counter) return a.counter > b.counter;
  return a.createdAt > b.createdAt;
}
