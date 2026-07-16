import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// DATA_DIR must be set before the gdrive modules load (paths.ts captures it).
const tmp = mkdtempSync(join(tmpdir(), 'gdrive-blob-'));
process.env['DATA_DIR'] = tmp;

type BlobStore = typeof import('../../src/core/gdrive/blob-store.js');
type ManifestMod = typeof import('../../src/core/gdrive/manifest.js');
type ZonesMod = typeof import('../../src/core/gdrive/zones.js');
let store: BlobStore;
let manifestMod: ManifestMod;
let zones: ZonesMod;

const hmacKey = randomBytes(32);
const encKey = randomBytes(32);
const keys = { hmacKey, encKey };

/** In-memory Drive: enough surface for push/hydrate/gc. */
class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: Buffer; trashed: boolean }>();
  private seq = 0;

  constructor(private folders: Record<string, string>) {}

  private async drain(body: string | NodeJS.ReadableStream): Promise<Buffer> {
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }

  async listChildren(folderId: string) {
    return [...this.files.entries()]
      .filter(([, f]) => f.parent === folderId && !f.trashed)
      .map(([id, f]) => ({ id, name: f.name }));
  }

  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string | NodeJS.ReadableStream }) {
    const id = `file${++this.seq}`;
    this.files.set(id, {
      name: meta.name,
      parent: meta.parents?.[0] ?? '',
      content: media ? await this.drain(media.body) : Buffer.alloc(0),
      trashed: false,
    });
    return { id, name: meta.name };
  }

  async filesUpdate(fileId: string, meta: { trashed?: boolean }, media?: { body: string | NodeJS.ReadableStream }) {
    const f = this.files.get(fileId);
    if (!f) throw { response: { status: 404, data: {} } };
    if (meta.trashed !== undefined) f.trashed = meta.trashed;
    if (media) f.content = await this.drain(media.body);
    return { id: fileId, name: f.name };
  }

  async filesDownloadRaw(fileId: string) {
    const f = this.files.get(fileId);
    if (!f) throw { response: { status: 404, data: {} } };
    return f.content;
  }

  async filesDownload(fileId: string) {
    return (await this.filesDownloadRaw(fileId)).toString('utf-8');
  }
}

const FOLDERS = { manifest: 'FLD-manifest', 'memory/blobs': 'FLD-blobs', ops: 'FLD-ops' };

function inputs(): import('../../src/core/gdrive/blob-store.js').BrainBlobInput[] {
  return [
    { logicalPath: 'chunks/infra.md', content: Buffer.from('sqlite WAL notes'), zone: 2, category: 'knowledge' },
    { logicalPath: 'structured/user_1.json', content: Buffer.from('{"secret":"credential-adjacent"}'), zone: 1, category: 'knowledge' },
    { logicalPath: 'workspace/MEMORY.md', content: Buffer.from('- [2026-07-16] fact'), zone: 2, category: 'policy' },
    { logicalPath: 'local/never.md', content: Buffer.from('zone zero material'), zone: 0, category: 'knowledge' },
  ];
}

beforeAll(async () => {
  store = await import('../../src/core/gdrive/blob-store.js');
  manifestMod = await import('../../src/core/gdrive/manifest.js');
  zones = await import('../../src/core/gdrive/zones.js');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function freshCacheDir(suffix: string): void {
  // Each scenario gets an isolated DATA_DIR-scoped cache by clearing the file.
  rmSync(join(tmp, 'gdrive'), { recursive: true, force: true });
  void suffix;
}

describe('pushBrain / hydrateBrain (F17 + F29)', () => {
  it('round-trips: push then hydrate returns identical plaintext for zones 1+2', async () => {
    freshCacheDir('roundtrip');
    const drive = new FakeDrive(FOLDERS);
    const push = await store.pushBrain(drive as never, FOLDERS, inputs(), keys, {
      counter: 1,
      createdAt: '2026-07-16T00:00:00Z',
    });
    expect(push.filteredZone0).toBe(1);
    expect(push.uploadedBlobs).toBe(3);

    const hyd = await store.hydrateBrain(drive as never, FOLDERS, keys);
    expect(hyd.manifest.counter).toBe(1);
    expect(hyd.blobs.get('chunks/infra.md')!.toString()).toBe('sqlite WAL notes');
    expect(hyd.blobs.get('structured/user_1.json')!.toString()).toBe('{"secret":"credential-adjacent"}');
    expect(hyd.blobs.has('local/never.md')).toBe(false);
  });

  it('zone-0 content NEVER appears in any Drive-bound payload', async () => {
    freshCacheDir('zone0');
    const drive = new FakeDrive(FOLDERS);
    await store.pushBrain(drive as never, FOLDERS, inputs(), keys, {
      counter: 1,
      createdAt: '2026-07-16T00:00:00Z',
    });
    for (const [, f] of drive.files) {
      expect(f.content.includes(Buffer.from('zone zero material'))).toBe(false);
    }
    // And prepareBlobs (the pre-network stage) already dropped it.
    const { prepared } = store.prepareBlobs(inputs(), keys);
    expect(prepared.some((p) => p.entry.logicalPath === 'local/never.md')).toBe(false);
  });

  it('zone-1 blobs are ciphertext on the wire, named by ciphertext sha256, .enc suffixed', async () => {
    freshCacheDir('cipher');
    const drive = new FakeDrive(FOLDERS);
    const push = await store.pushBrain(drive as never, FOLDERS, inputs(), keys, {
      counter: 1,
      createdAt: '2026-07-16T00:00:00Z',
    });
    const entry = push.manifest.entries.find((e) => e.logicalPath === 'structured/user_1.json')!;
    expect(entry.blob.endsWith('.enc')).toBe(true);
    const blobFile = [...drive.files.values()].find((f) => f.name === entry.blob.split('/').pop())!;
    expect(blobFile.content.includes(Buffer.from('credential-adjacent'))).toBe(false);
    expect(manifestMod.sha256Hex(blobFile.content)).toBe(entry.sha256);
    expect(zones.decryptZone1(blobFile.content, encKey).toString()).toContain('credential-adjacent');
  });

  it('dedups: second push of same content uploads zero blobs, manifest counter advances', async () => {
    freshCacheDir('dedup');
    const drive = new FakeDrive(FOLDERS);
    await store.pushBrain(drive as never, FOLDERS, inputs(), keys, { counter: 1, createdAt: '2026-07-16T00:00:00Z' });
    // Zone-1 re-encrypts with a fresh IV -> new hash, so dedup applies to zone-2 only.
    const zone2Only = inputs().filter((i) => i.zone === 2);
    const second = await store.pushBrain(drive as never, FOLDERS, zone2Only, keys, { counter: 2, createdAt: '2026-07-16T01:00:00Z' });
    expect(second.uploadedBlobs).toBe(0);
    expect(second.skippedBlobs).toBe(2);
    const hyd = await store.hydrateBrain(drive as never, FOLDERS, keys);
    expect(hyd.manifest.counter).toBe(2);
  });

  it('TAMPER: a flipped byte in a blob refuses hydration', async () => {
    freshCacheDir('tamper-blob');
    const drive = new FakeDrive(FOLDERS);
    const push = await store.pushBrain(drive as never, FOLDERS, inputs(), keys, { counter: 1, createdAt: '2026-07-16T00:00:00Z' });
    const entry = push.manifest.entries[0]!;
    const blobFile = [...drive.files.entries()].find(([, f]) => f.name === entry.blob.split('/').pop())!;
    blobFile[1].content = Buffer.from(blobFile[1].content); // copy
    blobFile[1].content[0]! ^= 0xff;
    await expect(store.hydrateBrain(drive as never, FOLDERS, keys)).rejects.toThrow(/sha256 mismatch/);
  });

  it('TAMPER: an edited manifest byte refuses hydration', async () => {
    freshCacheDir('tamper-manifest');
    const drive = new FakeDrive(FOLDERS);
    await store.pushBrain(drive as never, FOLDERS, inputs(), keys, { counter: 1, createdAt: '2026-07-16T00:00:00Z' });
    const mf = [...drive.files.values()].find((f) => f.name === store.MANIFEST_FILE_NAME)!;
    const doc = JSON.parse(mf.content.toString()) as { entries: Array<{ logicalPath: string }> };
    doc.entries[0]!.logicalPath = 'chunks/EVIL.md'; // content edit, hmac now stale
    mf.content = Buffer.from(JSON.stringify(doc));
    await expect(store.hydrateBrain(drive as never, FOLDERS, keys)).rejects.toThrow(/HMAC mismatch/);
  });

  it('wrong HMAC key refuses hydration', async () => {
    freshCacheDir('wrong-key');
    const drive = new FakeDrive(FOLDERS);
    await store.pushBrain(drive as never, FOLDERS, inputs(), keys, { counter: 1, createdAt: '2026-07-16T00:00:00Z' });
    await expect(
      store.hydrateBrain(drive as never, FOLDERS, { hmacKey: randomBytes(32), encKey }),
    ).rejects.toThrow(/HMAC mismatch/);
  });

  it('a remote manifest claiming zone 0 is refused (invariant: zone 0 never syncs)', async () => {
    freshCacheDir('zone0-manifest');
    const drive = new FakeDrive(FOLDERS);
    // Forge a signed manifest WITH the right key but a zone-0 entry — even a
    // correctly-signed manifest must not smuggle zone-0 through hydration.
    const forged = manifestMod.buildManifest(
      {
        brainId: 'main',
        counter: 9,
        createdAt: '2026-07-16T00:00:00Z',
        entries: [
          { logicalPath: 'x', blob: 'memory/blobs/aa', sha256: 'aa', zone: 0 as never, bytes: 1, category: 'knowledge' },
        ],
      },
      hmacKey,
    );
    await drive.filesCreate(
      { name: store.MANIFEST_FILE_NAME, parents: [FOLDERS.manifest] },
      { body: JSON.stringify(forged) },
    );
    await expect(store.hydrateBrain(drive as never, FOLDERS, keys)).rejects.toThrow(/malformed\/forbidden/);
  });

  it('zone-1 input without an enc key fails before any upload', async () => {
    freshCacheDir('no-enc-key');
    const drive = new FakeDrive(FOLDERS);
    await expect(
      store.pushBrain(drive as never, FOLDERS, inputs(), { hmacKey }, { counter: 1, createdAt: '2026-07-16T00:00:00Z' }),
    ).rejects.toThrow(/BRAIN_ENC_KEY_PATH/);
    expect(drive.files.size).toBe(0);
  });
});

describe('gcBlobs (trash-aware forgetting)', () => {
  it('trashes only unreferenced blobs; keeps everything any kept manifest references', async () => {
    freshCacheDir('gc');
    const drive = new FakeDrive(FOLDERS);
    const first = await store.pushBrain(drive as never, FOLDERS, inputs(), keys, { counter: 1, createdAt: '2026-07-16T00:00:00Z' });
    const newer = [{ logicalPath: 'chunks/new.md', content: Buffer.from('new fact'), zone: 2 as const, category: 'knowledge' as const }];
    const second = await store.pushBrain(drive as never, FOLDERS, newer, keys, { counter: 2, createdAt: '2026-07-16T01:00:00Z' });

    // Keep only the newest manifest: first push's blobs become unreferenced.
    const { trashed } = await store.gcBlobs(drive as never, FOLDERS, [second.manifest]);
    expect(trashed).toBe(3);
    // Keeping both manifests trashes nothing further.
    const again = await store.gcBlobs(drive as never, FOLDERS, [first.manifest, second.manifest]);
    expect(again.trashed).toBe(0);
    // Trash, not delete: files still exist, flagged trashed (30-day undo).
    expect([...drive.files.values()].filter((f) => f.trashed).length).toBe(3);
  });
});

describe('manifest helpers', () => {
  it('isNewerManifest: counter first, createdAt tiebreak', () => {
    const base = { brainId: 'main', entries: [], hmac: 'x', schemaVersion: 1 as const };
    const a = { ...base, counter: 2, createdAt: '2026-07-16T00:00:00Z' };
    const b = { ...base, counter: 1, createdAt: '2026-07-16T05:00:00Z' };
    expect(manifestMod.isNewerManifest(a, b)).toBe(true);
    const c = { ...base, counter: 2, createdAt: '2026-07-16T06:00:00Z' };
    expect(manifestMod.isNewerManifest(c, a)).toBe(true);
  });
});
