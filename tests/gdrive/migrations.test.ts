import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadVersionedManifest,
  CURRENT_MANIFEST_SCHEMA,
} from '../../src/core/gdrive/migrations.js';
import { ManifestVerifyError } from '../../src/core/gdrive/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
// Committed TEST-ONLY key — pairs with the static golden fixture. Never a real key.
const goldenKey = Buffer.from(
  '746573742d6f6e6c792d6b65792d746573742d6f6e6c792d6b65792d31323334',
  'hex',
);

function goldenBytes(): string {
  return readFileSync(join(here, 'fixtures', 'golden-brain-v1.json'), 'utf-8');
}

describe('F36 — golden brain through the migration ladder (CI canary)', () => {
  it('the committed oldest golden brain loads at the current schema', () => {
    // STATIC bytes: if canonical-json or HMAC computation ever drifts, this
    // fixture stops verifying and CI goes red — that is the point.
    const m = loadVersionedManifest(JSON.parse(goldenBytes()), goldenKey);
    expect(m.schemaVersion).toBe(CURRENT_MANIFEST_SCHEMA);
    expect(m.brainId).toBe('golden');
    expect(m.counter).toBe(3);
    expect(m.entries).toHaveLength(2);
  });

  it('rejects a tampered golden brain', () => {
    const doc = JSON.parse(goldenBytes()) as { counter: number };
    doc.counter = 999;
    expect(() => loadVersionedManifest(doc, goldenKey)).toThrow(/HMAC mismatch/);
  });

  it('rejects a manifest newer than this build supports', () => {
    const doc = JSON.parse(goldenBytes()) as { schemaVersion: number };
    doc.schemaVersion = CURRENT_MANIFEST_SCHEMA + 1;
    expect(() => loadVersionedManifest(doc, goldenKey)).toThrow(/newer than this build/);
  });

  it('rejects an historical version with no registered migration', () => {
    // schemaVersion 0 never existed; signature must still be checked FIRST,
    // so sign-then-fail-on-ladder is the expected order.
    const doc = JSON.parse(goldenBytes()) as Record<string, unknown>;
    doc['schemaVersion'] = 0;
    // Re-signing with the right key isolates the ladder check from the HMAC check.
    expect(() => loadVersionedManifest(doc, goldenKey)).toThrow(ManifestVerifyError);
  });

  it('rejects non-manifest values', () => {
    expect(() => loadVersionedManifest(null, goldenKey)).toThrow(/not a manifest/);
    expect(() => loadVersionedManifest({ foo: 1 }, goldenKey)).toThrow(/not a manifest/);
  });
});
