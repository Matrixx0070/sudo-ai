import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'gdrive-ckpt-'));
process.env['DATA_DIR'] = tmp;

type Checkpoint = typeof import('../../src/core/gdrive/checkpoint.js');
type Serializer = typeof import('../../src/core/gdrive/brain-serializer.js');
let ck: Checkpoint;
let ser: Serializer;

const keys = { hmacKey: randomBytes(32), encKey: randomBytes(32) };
const FOLDERS = { manifest: 'FLD-manifest', 'memory/blobs': 'FLD-blobs' };

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: Buffer; trashed: boolean }>();
  private seq = 0;
  private async drain(body: string | NodeJS.ReadableStream): Promise<Buffer> {
    if (typeof body === 'string') return Buffer.from(body, 'utf-8');
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }
  async listChildren(folderId: string) {
    return [...this.files.entries()]
      .filter(([, f]) => f.parent === folderId && !f.trashed)
      .map(([id, f]) => ({ id, name: f.name }));
  }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string | NodeJS.ReadableStream }) {
    const id = `file${++this.seq}`;
    this.files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media ? await this.drain(media.body) : Buffer.alloc(0), trashed: false });
    return { id, name: meta.name };
  }
  async filesUpdate(fileId: string, _meta: object, media?: { body: string | NodeJS.ReadableStream }) {
    const f = this.files.get(fileId)!;
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

/** In-memory fakes for the three backends. */
function fakeBackends(mdDir: string) {
  const chunks: Array<{ text: string; path: string; source: 'learning'; hash: string; isEvergreen: boolean; createdAt: string }> = [];
  const structured = new Map<string, { type: string; id: string; name: string; description: string; content: string }>();
  const mdPath = join(mdDir, 'MEMORY.md');
  const deps = {
    chunks: {
      getActiveChunks: () => [...chunks],
      storeChunk: (text: string, path: string, source: 'learning') => {
        const hash = String(text.length) + text.slice(0, 8);
        if (!chunks.some((c) => c.hash === hash)) {
          chunks.push({ text, path, source, hash, isEvergreen: false, createdAt: '2026-07-16T00:00:00Z' });
        }
      },
    },
    structured: {
      listMemories: async () => [...structured.values()],
      saveMemory: async (m: { type: string; id: string; name: string; description: string; content: string }) => {
        structured.set(`${m.type}_${m.id}`, m);
        return m;
      },
    },
    memoryMdPath: mdPath,
  };
  return { deps, chunks, structured, mdPath };
}

beforeAll(async () => {
  ck = await import('../../src/core/gdrive/checkpoint.js');
  ser = await import('../../src/core/gdrive/brain-serializer.js');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(join(tmp, 'gdrive'), { recursive: true, force: true });
});

function ckDeps(drive: FakeDrive, snapshot: object) {
  return {
    client: drive as never,
    folders: FOLDERS,
    keys,
    snapshot: snapshot as never,
    audit: null,
    now: () => new Date('2026-07-16T12:00:00Z'),
  };
}

describe('F2 — checkpoint / restore', () => {
  it('checkpoint pushes a snapshot and advances the counter', async () => {
    const drive = new FakeDrive();
    const a = fakeBackends(mkdtempSync(join(tmpdir(), 'mdA-')));
    a.deps.chunks.storeChunk('sqlite WAL fact', 'memory/x.md', 'learning');
    writeFileSync(a.mdPath, '- [2026-07-16] durable fact\n');

    const r1 = await ck.runCheckpoint(ckDeps(drive, a.deps));
    expect(r1.manifest.counter).toBe(1);
    const r2 = await ck.runCheckpoint(ckDeps(drive, a.deps));
    expect(r2.manifest.counter).toBe(2);
    expect(r2.uploadedBlobs).toBe(0); // unchanged content dedups
    expect(ck.loadBrainState().counter).toBe(2);
  });

  it('KILL-AND-RESTORE: machine B hydrates machine A\'s brain through the memory API', async () => {
    const drive = new FakeDrive();
    const a = fakeBackends(mkdtempSync(join(tmpdir(), 'mdA-')));
    a.deps.chunks.storeChunk('consolidated knowledge X', 'memory/x.md', 'learning');
    await a.deps.structured.saveMemory({ type: 'project', id: 'p1', name: 'proj', description: 'd', content: 'project state' });
    writeFileSync(a.mdPath, '- [2026-07-16] long-term fact\n');
    await ck.runCheckpoint(ckDeps(drive, a.deps));

    // "Machine B": empty backends, empty local brain state (fresh DATA_DIR cache dir).
    rmSync(join(tmp, 'gdrive'), { recursive: true, force: true });
    const b = fakeBackends(mkdtempSync(join(tmpdir(), 'mdB-')));
    const outcome = await ck.runRestoreCheck(ckDeps(drive, b.deps));
    expect(outcome.action).toBe('applied');
    expect(b.chunks.some((c) => c.text === 'consolidated knowledge X')).toBe(true);
    expect(b.structured.get('project_p1')?.content).toBe('project state');
    expect(readFileSync(b.mdPath, 'utf-8')).toContain('long-term fact');
    expect(ck.loadBrainState().counter).toBe(1);
  });

  it('does not re-apply when local counter is current (up-to-date)', async () => {
    const drive = new FakeDrive();
    const a = fakeBackends(mkdtempSync(join(tmpdir(), 'mdA-')));
    a.deps.chunks.storeChunk('fact', 'memory/x.md', 'learning');
    await ck.runCheckpoint(ckDeps(drive, a.deps));
    const outcome = await ck.runRestoreCheck(ckDeps(drive, a.deps));
    expect(outcome.action).toBe('up-to-date');
  });

  it('REFUSES a tampered remote brain and keeps local state untouched', async () => {
    const drive = new FakeDrive();
    const a = fakeBackends(mkdtempSync(join(tmpdir(), 'mdA-')));
    a.deps.chunks.storeChunk('fact', 'memory/x.md', 'learning');
    await ck.runCheckpoint(ckDeps(drive, a.deps));

    // Tamper the manifest, then simulate a fresh machine trying to restore.
    const mf = [...drive.files.values()].find((f) => f.name === 'manifest.json')!;
    const doc = JSON.parse(mf.content.toString()) as { counter: number };
    doc.counter = 99; // ahead of everyone, but signature is now stale
    mf.content = Buffer.from(JSON.stringify(doc));

    rmSync(join(tmp, 'gdrive'), { recursive: true, force: true });
    const b = fakeBackends(mkdtempSync(join(tmpdir(), 'mdB-')));
    const outcome = await ck.runRestoreCheck(ckDeps(drive, b.deps));
    expect(outcome.action).toBe('refused');
    expect(b.chunks).toHaveLength(0); // nothing applied
    expect(ck.loadBrainState().counter).toBe(0); // local state untouched
  });

  it('reports no-remote on an empty Drive tree', async () => {
    const drive = new FakeDrive();
    const b = fakeBackends(mkdtempSync(join(tmpdir(), 'mdB-')));
    const outcome = await ck.runRestoreCheck(ckDeps(drive, b.deps));
    expect(outcome.action).toBe('no-remote');
  });

  it('restore drill passes when remote reproduces local, fails on divergence', async () => {
    const drive = new FakeDrive();
    const a = fakeBackends(mkdtempSync(join(tmpdir(), 'mdA-')));
    a.deps.chunks.storeChunk('fact one', 'memory/x.md', 'learning');
    await ck.runCheckpoint(ckDeps(drive, a.deps));

    const good = await ck.runRestoreDrill(ckDeps(drive, a.deps));
    expect(good.ok).toBe(true);

    // Local gains a chunk the backup does not have -> drill must flag it.
    a.deps.chunks.storeChunk('fact two — not yet pushed', 'memory/y.md', 'learning');
    const bad = await ck.runRestoreDrill(ckDeps(drive, a.deps));
    expect(bad.ok).toBe(false);
    expect(bad.divergent).toContain('chunks/zone2.jsonl');
  });
});

describe('F2 — serializer zone handling', () => {
  it('zone-1-classified records ride encrypted bundles; MEMORY.md is a policy entry', async () => {
    const a = fakeBackends(mkdtempSync(join(tmpdir(), 'mdZ-')));
    a.deps.chunks.storeChunk('the api key for prod lives at /x', 'memory/s.md', 'learning');
    a.deps.chunks.storeChunk('plain architectural note', 'memory/p.md', 'learning');
    writeFileSync(a.mdPath, '- ordinary long-term memory\n');
    const inputs = await ser.collectBrainSnapshot(a.deps);
    const paths = inputs.map((i) => [i.logicalPath, i.zone, i.category]);
    expect(paths).toContainEqual(['chunks/zone1.jsonl', 1, 'knowledge']);
    expect(paths).toContainEqual(['chunks/zone2.jsonl', 2, 'knowledge']);
    expect(paths).toContainEqual(['workspace/MEMORY.md', 2, 'policy']);
    const z2 = inputs.find((i) => i.logicalPath === 'chunks/zone2.jsonl')!;
    expect(z2.content.toString()).not.toContain('api key');
  });

  it('never-sync chunks are excluded from the snapshot entirely', async () => {
    const a = fakeBackends(mkdtempSync(join(tmpdir(), 'mdZ0-')));
    a.deps.chunks.storeChunk('never-sync: purely local scratch', 'memory/l.md', 'learning');
    const inputs = await ser.collectBrainSnapshot(a.deps);
    for (const i of inputs) expect(i.content.toString()).not.toContain('purely local scratch');
  });

  it('MEMORY.md overwrite creates a timestamped backup first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdBk-'));
    const a = fakeBackends(dir);
    writeFileSync(a.mdPath, 'OLD LOCAL CONTENT\n');
    await ser.applyBrainSnapshot(
      new Map([['workspace/MEMORY.md', Buffer.from('NEW REMOTE CONTENT\n')]]),
      a.deps,
    );
    expect(readFileSync(a.mdPath, 'utf-8')).toBe('NEW REMOTE CONTENT\n');
    const backups = readdirSync(dir).filter((f) => f.includes('.pre-hydrate.'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf-8')).toBe('OLD LOCAL CONTENT\n');
  });
});
