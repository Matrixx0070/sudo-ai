/**
 * @file gdrive/migrations.ts
 * @description F36 — manifest schema migration chain.
 *
 * Old checkpoints never die: a manifest at any historical schemaVersion loads
 * by (1) verifying its HMAC as-written, (2) running the pure migration chain
 * up to CURRENT_MANIFEST_SCHEMA, (3) re-signing in memory so downstream
 * verification passes. Migrations are pure functions, never touch Drive, and
 * are covered in CI by the golden-brain fixture
 * (tests/gdrive/fixtures/golden-brain-v1.json) hydrating through the full
 * ladder on every run.
 */

import {
  computeManifestHmac,
  verifyManifest,
  ManifestVerifyError,
  type BrainManifest,
} from './manifest.js';

export const CURRENT_MANIFEST_SCHEMA = 1;

/** A pure schema migration: vN manifest object -> v(N+1) manifest object. */
export type ManifestMigration = (manifest: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration ladder: MIGRATIONS[n] migrates schemaVersion n -> n+1.
 * Convention for future entries: src/core/gdrive/migrations.ts stays the
 * registry; each migration gets its own tested function.
 */
export const MIGRATIONS: Record<number, ManifestMigration> = {
  // schemaVersion 1 is current — no migrations yet. Example shape for v1->v2:
  // 1: (m) => ({ ...m, schemaVersion: 2, entries: (m.entries as X[]).map(migrateEntry) }),
};

/**
 * Load a manifest of ANY supported historical schema: verify the signature
 * over the bytes as-written, migrate to current, re-sign in memory, then run
 * current-schema shape validation.
 */
export function loadVersionedManifest(candidate: unknown, hmacKey: Buffer): BrainManifest {
  const m = candidate as Record<string, unknown> & { schemaVersion?: number; hmac?: string };
  if (!m || typeof m !== 'object' || typeof m.schemaVersion !== 'number') {
    throw new ManifestVerifyError('not a manifest object');
  }
  if (m.schemaVersion > CURRENT_MANIFEST_SCHEMA) {
    throw new ManifestVerifyError(
      `manifest schemaVersion ${m.schemaVersion} is newer than this build supports ` +
        `(${CURRENT_MANIFEST_SCHEMA}) — update sudo-ai before hydrating`,
    );
  }

  // 1. Signature over the manifest exactly as written (any version).
  if (typeof m.hmac !== 'string') throw new ManifestVerifyError('missing hmac');
  const expected = computeManifestHmac(m as never, hmacKey);
  if (expected !== m.hmac) {
    throw new ManifestVerifyError('HMAC mismatch — manifest tampered or wrong key; refusing');
  }

  // 2. Pure migration chain.
  let current: Record<string, unknown> = m;
  for (let v = m.schemaVersion; v < CURRENT_MANIFEST_SCHEMA; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new ManifestVerifyError(`no migration registered for schemaVersion ${v} -> ${v + 1}`);
    }
    current = step(current);
    if (current['schemaVersion'] !== v + 1) {
      throw new ManifestVerifyError(`migration ${v} produced schemaVersion ${String(current['schemaVersion'])}`);
    }
  }

  // 3. Re-sign in memory + full current-schema validation.
  const resigned = { ...current, hmac: '' };
  resigned.hmac = computeManifestHmac(resigned as never, hmacKey);
  return verifyManifest(resigned, hmacKey);
}
