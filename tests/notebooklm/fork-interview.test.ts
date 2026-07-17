import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'fork-interview-'));
process.env['DATA_DIR'] = tmp;

type FI = typeof import('../../src/core/notebooklm/fork-interview.js');
type Forks = typeof import('../../src/core/gdrive/forks.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Routes = typeof import('../../src/core/notebooklm/routes-n1.js');
let fi: FI, forks: Forks, returns: Returns, routes: Routes;

beforeAll(async () => {
  fi = await import('../../src/core/notebooklm/fork-interview.js');
  forks = await import('../../src/core/gdrive/forks.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  routes = await import('../../src/core/notebooklm/routes-n1.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(join(tmp, 'gdrive'), { recursive: true, force: true }));

const FOLDERS = { 'notebooklm/releases/forks-museum': 'FLD-museum' };

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  add(name: string, parent: string, content: string) { const id = `f${++this.seq}`; this.files.set(id, { name, parent, content }); return id; }
  async listChildren(fid: string) { return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); }
  async filesDownload(id: string) { return this.files.get(id)!.content; }
  async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) this.files.get(id)!.parent = meta.addParents; return { id }; }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) { const id = `x${++this.seq}`; this.files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' }); return { id, name: meta.name }; }
  async filesCreateAsGoogleDoc(name: string, folderId: string, body: string) { const id = `g${++this.seq}`; this.files.set(id, { name, parent: folderId, content: body }); return { id, name }; }
  async filesUpdateGoogleDoc(id: string, body: string) { this.files.get(id)!.content = body; return { id }; }
}

describe('F65 fork interview + adoption gate', () => {
  it('opens an interview packet; adoption gate HOLDS until a PASS verdict', async () => {
    const drive = new FakeDrive();
    const rec = await fi.openForkInterview(drive as never, FOLDERS, 'aggressive-decay');
    expect(rec.phase).toBe('pending');
    expect(fi.isForkInterviewPassed('aggressive-decay')).toBe(false);
    const packet = [...drive.files.values()].find((f) => f.name === 'F65.interview-packet.aggressive-decay')!;
    expect(packet.content).toContain(`INTERVIEW aggressive-decay PASS ${rec.token}`);
  });

  it('grants only on a PASS with the exact token; FAIL keeps the gate shut', async () => {
    const drive = new FakeDrive();
    const rec = await fi.openForkInterview(drive as never, FOLDERS, 'cand');
    expect(fi.recordForkInterview('cand', 'INTERVIEW cand PASS deadbeefcafe').decided).toBe(false); // wrong token
    expect(fi.recordForkInterview('cand', `INTERVIEW cand FAIL ${rec.token}`).phase).toBe('failed');
    expect(fi.isForkInterviewPassed('cand')).toBe(false);
  });

  it('a PASS verdict opens the gate', async () => {
    const drive = new FakeDrive();
    const rec = await fi.openForkInterview(drive as never, FOLDERS, 'good');
    const r = fi.recordForkInterview('good', `INTERVIEW good PASS ${rec.token}`);
    expect(r.phase).toBe('passed');
    expect(fi.isForkInterviewPassed('good')).toBe(true);
  });

  it('adoptFork is BLOCKED when an interview is required but not passed', async () => {
    await expect(
      forks.adoptFork({} as never, {} as never, 'unvetted', {} as never, {
        requiresInterview: () => true,
        interviewPassed: () => false,
      }),
    ).rejects.toThrow(/BLOCKED|interview not passed/);
  });

  it('F65:interview return route records the verdict and opens the gate', async () => {
    const drive = new FakeDrive();
    const rec = await fi.openForkInterview(drive as never, FOLDERS, 'routed');
    routes.registerN1Routes();
    const RF = { 'notebooklm/returns': 'FLD-ret', 'notebooklm/returns/processed': 'FLD-proc', 'notebooklm/returns/held': 'FLD-held' };
    drive.add('F65.interview.routed.md', 'FLD-ret', `INTERVIEW routed PASS ${rec.token}`);
    const res = await returns.processReturnsOnce({
      client: drive as never, folders: RF, audit: null,
      chunks: { getActiveChunks: () => [], storeChunk: () => { throw new Error('must not ingest'); } } as never,
      structured: { listMemories: async () => [], saveMemory: async () => { throw new Error('no memory'); } } as never,
    });
    expect(res.routed).toEqual([{ file: 'F65.interview.routed.md', route: 'interview-passed' }]);
    expect(fi.isForkInterviewPassed('routed')).toBe(true);
  });
});
