import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nlm-embassy-'));
process.env['DATA_DIR'] = tmp;

type Embassy = typeof import('../../src/core/notebooklm/embassy.js');
type Canary = typeof import('../../src/core/gdrive/canary.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Routes = typeof import('../../src/core/notebooklm/routes-n1.js');
let embassy: Embassy, canary: Canary, returns: Returns, routes: Routes;

beforeAll(async () => {
  embassy = await import('../../src/core/notebooklm/embassy.js');
  canary = await import('../../src/core/gdrive/canary.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  routes = await import('../../src/core/notebooklm/routes-n1.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(tmp, 'gdrive'), { recursive: true, force: true });
  canary.clearGdrivePause();
});

const OUT_FOLDERS = { 'notebooklm/embassy/outbound': 'FLD-out' };
const DISTILLATE = 'The unified gateway authenticates every surface through a single boundary. The websocket handshake is schema validated. Untrusted turns route to a docker backend with capabilities dropped.';

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  add(name: string, parent: string, content: string) { const id = `f${++this.seq}`; this.files.set(id, { name, parent, content }); return id; }
  async listChildren(fid: string) { return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); }
  async filesDownload(id: string) { return this.files.get(id)!.content; }
  async filesExport(id: string) { return this.files.get(id)!.content; }
  async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) this.files.get(id)!.parent = meta.addParents; return { id }; }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) { const id = `x${++this.seq}`; this.files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' }); return { id, name: meta.name }; }
  async filesCreateAsGoogleDoc(name: string, folderId: string, body: string) { const id = `g${++this.seq}`; this.files.set(id, { name, parent: folderId, content: body }); return { id, name }; }
  async filesUpdateGoogleDoc(id: string, body: string) { this.files.get(id)!.content = body; return { id }; }
}

describe('G-CANARYWRITE — registerCanary', () => {
  it('appends a marker-only canary locally and is idempotent; empty fileId never matches a real file', () => {
    canary.registerCanary({ marker: 'CANARY-XYZ', label: 'test' });
    canary.registerCanary({ marker: 'CANARY-XYZ', label: 'test' }); // dedupe
    const cfg = canary.loadCanaryConfig();
    expect(cfg.canaries.filter((c) => c.marker === 'CANARY-XYZ')).toHaveLength(1);
    expect(canary.checkCanaryPayload('text with CANARY-XYZ inside', cfg)).not.toBeNull();
    expect(canary.checkCanaryFileId('', cfg)).toBeNull(); // marker-only fileId '' must not match
  });
});

describe('F67 embassy publish', () => {
  it('is GATED — refuses without approval', async () => {
    const drive = new FakeDrive();
    await expect(embassy.publishEmbassyPack(drive as never, OUT_FOLDERS, { id: 'p1', title: 'T', body: DISTILLATE }, { approved: false })).rejects.toThrow(/BLOCKED|approval/);
  });

  it('watermarks + registers a canary + writes to outbound', async () => {
    const drive = new FakeDrive();
    const { marker, fileId } = await embassy.publishEmbassyPack(drive as never, OUT_FOLDERS, { id: 'p1', title: 'Distillate', body: DISTILLATE }, { approved: true });
    expect(marker).toMatch(/^CANARY-EMB-[a-f0-9]{16}$/);
    expect(drive.files.get(fileId)!.content).toContain(marker); // watermark embedded
    expect(canary.checkCanaryPayload(`echo ${marker} echo`, canary.loadCanaryConfig())).not.toBeNull(); // registered
  });
});

describe('F67 embassy inbound route', () => {
  const RF = { 'notebooklm/returns': 'FLD-ret', 'notebooklm/returns/processed': 'FLD-proc', 'notebooklm/returns/held': 'FLD-held', 'notebooklm/embassy/outbound': 'FLD-out' };

  async function sweep(drive: FakeDrive) {
    const saved: Array<{ content: string }> = [];
    const chunks: string[] = [];
    const res = await returns.processReturnsOnce({
      client: drive as never, folders: RF, audit: null,
      chunks: { getActiveChunks: () => [], storeChunk: (t: string) => chunks.push(t) } as never,
      structured: { listMemories: async () => [], saveMemory: async (m: never) => { saved.push(m as never); return m; } } as never,
    });
    return { res, saved, chunks };
  }

  it('HELD when inbound carries our watermark canary (F19 trips)', async () => {
    routes.registerN1Routes();
    const drive = new FakeDrive();
    const { marker } = await embassy.publishEmbassyPack(drive as never, RF, { id: 'p9', title: 'T', body: DISTILLATE }, { approved: true });
    drive.add('F67.distillate.2026-07-17.md', 'FLD-ret', `interesting note ${marker} more text`);
    const { res, chunks } = await sweep(drive);
    expect(res.routed).toEqual([{ file: 'F67.distillate.2026-07-17.md', route: 'embassy-canary-tripped' }]);
    expect(chunks).toHaveLength(0); // never ingested
  });

  it('HELD when inbound is a verbatim echo of what we published', async () => {
    routes.registerN1Routes();
    const drive = new FakeDrive();
    await embassy.publishEmbassyPack(drive as never, RF, { id: 'p10', title: 'T', body: DISTILLATE }, { approved: true });
    // same distillate text WITHOUT the watermark → verbatim heuristic catches it
    drive.add('F67.distillate.2026-07-18.md', 'FLD-ret', DISTILLATE);
    const { res, chunks } = await sweep(drive);
    expect(res.routed).toEqual([{ file: 'F67.distillate.2026-07-18.md', route: 'embassy-verbatim-held' }]);
    expect(chunks).toHaveLength(0);
  });

  it('novel foreign distillate → external-tier memory', async () => {
    routes.registerN1Routes();
    const drive = new FakeDrive();
    drive.add('F67.distillate.2026-07-19.md', 'FLD-ret', 'A wholly novel foreign perspective on distributed consensus and quorum sensing in ant colonies.');
    const { res, saved, chunks } = await sweep(drive);
    expect(res.routed).toEqual([{ file: 'F67.distillate.2026-07-19.md', route: 'embassy-external' }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect((JSON.parse(saved[0]!.content) as { trustTier: string }).trustTier).toBe('external');
  });
});
