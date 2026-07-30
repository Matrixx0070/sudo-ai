/**
 * @file blob-gc.test.ts
 * @description Blob-GC driver: keep-set from manifest REVISIONS (recent +
 * keepForever pins), HMAC-verified, FAIL-CLOSED — any unverifiable manifest
 * aborts the sweep with nothing trashed. gcBlobs only trashes (30-day undo).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { runBlobGc, assembleKeepManifests, KEEP_RECENT_REVISIONS } from '../../src/core/gdrive/blob-gc.js';
import { buildManifest } from '../../src/core/gdrive/manifest.js';
import type { BrainKeys } from '../../src/core/gdrive/keys.js';

const hmacKey = randomBytes(32);
const keys: BrainKeys = { hmacKey };

function manifestJson(counter: number, blobNames: string[]): string {
  const entries = blobNames.map((name) => ({
    logicalPath: `memory/${name}`,
    blob: `memory/blobs/${name}`,
    sha256: createHash('sha256').update(name).digest('hex'),
    bytes: 10,
    zone: 2 as const,
  }));
  return JSON.stringify(buildManifest(
    { brainId: 'test-brain', counter, createdAt: '2026-07-30T00:00:00Z', entries: entries as never },
    hmacKey,
  ));
}

interface FakeFile { id: string; name: string; trashed?: boolean }

function makeFakeClient(opts: {
  revisions: Array<{ id: string; keepForever?: boolean; json: string }>;
  blobs: string[];
}) {
  const blobFiles: FakeFile[] = opts.blobs.map((name, i) => ({ id: `b${i}`, name }));
  const trashedIds: string[] = [];
  const client = {
    listChildren: async (folderId: string): Promise<FakeFile[]> =>
      folderId === 'F_MANIFEST' ? [{ id: 'MF', name: 'manifest.json' }] : blobFiles,
    revisionsList: async () => opts.revisions.map((r) => ({ id: r.id, keepForever: r.keepForever ?? false })),
    revisionsGetContent: async (_f: string, revId: string) => {
      const r = opts.revisions.find((x) => x.id === revId);
      if (!r) throw new Error(`no revision ${revId}`);
      return r.json;
    },
    filesUpdate: async (fileId: string, patch: { trashed?: boolean }) => {
      if (patch.trashed) trashedIds.push(fileId);
    },
  };
  return { client: client as never, trashedIds, blobFiles };
}

const folders = { manifest: 'F_MANIFEST', 'memory/blobs': 'F_BLOBS' } as never;

beforeEach(() => { delete process.env['SUDO_GDRIVE_BLOB_GC']; });
afterEach(() => { delete process.env['SUDO_GDRIVE_BLOB_GC']; });

describe('gdrive blob GC', () => {
  it('GC-1: trashes only blobs unreferenced by recent+pinned manifests', async () => {
    const { client, trashedIds, blobFiles } = makeFakeClient({
      revisions: [
        { id: 'r1', keepForever: true, json: manifestJson(1, ['old-pinned.enc']) },
        { id: 'r2', json: manifestJson(2, ['current-a', 'current-b.enc']) },
      ],
      blobs: ['current-a', 'current-b.enc', 'old-pinned.enc', 'stale-plaintext-name'],
    });
    const result = await runBlobGc(client, folders, keys);
    expect(result.ran).toBe(true);
    expect(result.keptManifests).toBe(2);
    expect(result.trashed).toBe(1);
    const trashedNames = trashedIds.map((id) => blobFiles.find((f) => f.id === id)!.name);
    expect(trashedNames).toEqual(['stale-plaintext-name']);
  });

  it('GC-2: FAIL-CLOSED — one tampered manifest aborts the sweep, nothing trashed', async () => {
    const tampered = manifestJson(2, ['x']).replace('"counter":2', '"counter":99');
    const { client, trashedIds } = makeFakeClient({
      revisions: [
        { id: 'r1', json: manifestJson(1, ['a']) },
        { id: 'r2', json: tampered },
      ],
      blobs: ['a', 'orphan'],
    });
    const result = await runBlobGc(client, folders, keys);
    expect(result.ran).toBe(false);
    expect(result.trashed).toBe(0);
    expect(trashedIds).toHaveLength(0);
  });

  it('GC-3: keepForever pins outside the recent window still anchor their blobs', async () => {
    const revisions = [{ id: 'pin', keepForever: true, json: manifestJson(1, ['ancient-pinned']) }];
    for (let i = 0; i < KEEP_RECENT_REVISIONS + 5; i++) {
      revisions.push({ id: `r${i}`, keepForever: false, json: manifestJson(i + 2, ['live']) });
    }
    const { client, trashedIds } = makeFakeClient({ revisions, blobs: ['live', 'ancient-pinned', 'junk'] });
    const result = await runBlobGc(client, folders, keys);
    expect(result.ran).toBe(true);
    expect(result.trashed).toBe(1); // only junk — ancient-pinned survives via the pin
    expect(trashedIds).toHaveLength(1);
  });

  it('GC-4: SUDO_GDRIVE_BLOB_GC=0 disables the sweep', async () => {
    process.env['SUDO_GDRIVE_BLOB_GC'] = '0';
    const { client, trashedIds } = makeFakeClient({
      revisions: [{ id: 'r1', json: manifestJson(1, ['a']) }],
      blobs: ['a', 'orphan'],
    });
    const result = await runBlobGc(client, folders, keys);
    expect(result.ran).toBe(false);
    expect(trashedIds).toHaveLength(0);
  });

  it('GC-5: assembleKeepManifests throws on missing revisions (no silent empty keep-set)', async () => {
    const { client } = makeFakeClient({ revisions: [], blobs: ['a'] });
    await expect(assembleKeepManifests(client, folders, keys)).rejects.toThrow(/no manifest revisions/);
  });
});
