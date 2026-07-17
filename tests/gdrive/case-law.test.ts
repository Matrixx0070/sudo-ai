import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'case-law-'));
process.env['DATA_DIR'] = tmp;

type CL = typeof import('../../src/core/gdrive/case-law.js');
type Seam = typeof import('../../src/core/agent/case-law-seam.js');
let cl: CL, seam: Seam;

beforeAll(async () => {
  cl = await import('../../src/core/gdrive/case-law.js');
  seam = await import('../../src/core/agent/case-law-seam.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => { rmSync(join(tmp, 'gdrive'), { recursive: true, force: true }); seam.setCaseLawMatcher(null); });

const FOLDERS = { 'tasks/proposals': 'FLD-prop' };

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  async listChildren(fid: string) { return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); }
  async filesDownload(id: string) { return this.files.get(id)!.content; }
  async filesUpdate(id: string, _m: unknown, media?: { body: string }) { if (media) this.files.get(id)!.content = media.body; return { id }; }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) { const id = `f${++this.seq}`; this.files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' }); return { id, name: meta.name }; }
}

describe('F70 fleet case law', () => {
  it('proposes to tasks/proposals; a proposal is NOT binding until ratified', async () => {
    const drive = new FakeDrive();
    await cl.proposePrecedent(drive as never, FOLDERS, { id: 'cache-ttl', situation: 'lowering the cache ttl below one hour', ruling: 'keep the one hour ttl', rationale: 'probe showed recall risk' });
    await cl.proposePrecedent(drive as never, FOLDERS, { id: 'friday-deploy', situation: 'deploying on a friday afternoon', ruling: 'wait for monday', rationale: 'weekend blast radius' });
    expect((await cl.listProposals(drive as never, FOLDERS)).map((p) => p.id).sort()).toEqual(['cache-ttl', 'friday-deploy']);
    // nothing ratified yet → consult returns nothing
    expect(cl.consultPrecedents('should we consider lowering the cache ttl now')).toEqual([]);
  });

  it('ratification makes ONLY that precedent binding + consultable', async () => {
    const drive = new FakeDrive();
    await cl.proposePrecedent(drive as never, FOLDERS, { id: 'cache-ttl', situation: 'lowering the cache ttl below one hour', ruling: 'keep the one hour ttl', rationale: 'r' });
    await cl.proposePrecedent(drive as never, FOLDERS, { id: 'friday-deploy', situation: 'deploying on a friday afternoon', ruling: 'wait for monday', rationale: 'r' });
    await cl.ratifyPrecedent(drive as never, FOLDERS, 'cache-ttl');

    const hits = cl.consultPrecedents('plan: consider lowering the cache ttl this week');
    expect(hits.map((h) => h.id)).toEqual(['cache-ttl']); // ratified only
    expect(hits[0]!.ruling).toContain('one hour');
    // the un-ratified friday precedent stays invisible even to a matching plan
    expect(cl.consultPrecedents('we are deploying on a friday afternoon').map((h) => h.id)).toEqual([]);
    expect(cl.listRatifiedPrecedents().map((p) => p.id)).toEqual(['cache-ttl']);
  });

  it('requires enough keyword overlap to match (minHits)', async () => {
    const drive = new FakeDrive();
    await cl.proposePrecedent(drive as never, FOLDERS, { id: 'p', situation: 'lowering the cache ttl below one hour', ruling: 'keep it', rationale: 'r' });
    await cl.ratifyPrecedent(drive as never, FOLDERS, 'p');
    expect(cl.consultPrecedents('a totally unrelated plan about ant colonies')).toEqual([]);
  });
});

describe('F70 case-law seam', () => {
  it('no-op until wired; renders a consult block; fail-open', () => {
    expect(seam.matchPrecedents('x')).toEqual([]);
    expect(seam.renderPrecedentConsult([])).toBe('');
    seam.setCaseLawMatcher(() => [{ id: 'p1', situation: 'friday deploy', ruling: 'wait for monday' }]);
    const block = seam.renderPrecedentConsult(seam.matchPrecedents('friday deploy?'));
    expect(block).toContain('FLEET CASE LAW');
    expect(block).toContain('wait for monday');
    seam.setCaseLawMatcher(() => { throw new Error('boom'); });
    expect(seam.matchPrecedents('x')).toEqual([]);
  });
});
