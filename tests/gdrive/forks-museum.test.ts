import { describe, it, expect, beforeAll } from 'vitest';

type FM = typeof import('../../src/core/gdrive/forks-museum.js');
type ShapesN3 = typeof import('../../src/core/notebooklm/shapes-n3.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Routes = typeof import('../../src/core/notebooklm/routes-n1.js');
let fm: FM, shapesN3: ShapesN3, returns: Returns, routes: Routes;

beforeAll(async () => {
  fm = await import('../../src/core/gdrive/forks-museum.js');
  shapesN3 = await import('../../src/core/notebooklm/shapes-n3.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  routes = await import('../../src/core/notebooklm/routes-n1.js');
});

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  add(name: string, parent: string, content: string) { const id = `f${++this.seq}`; this.files.set(id, { name, parent, content }); return id; }
  async listChildren(fid: string) { return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); }
  async filesDownload(id: string) { return this.files.get(id)!.content; }
  async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) this.files.get(id)!.parent = meta.addParents; return { id }; }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) { const id = `x${++this.seq}`; this.files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' }); return { id, name: meta.name }; }
}

const FOLDERS = { 'brains/forks': 'FLD-forks' };

describe('F60 forks museum', () => {
  it('catalogs past-self forks (metadata only), newest era first, skips junk', async () => {
    const drive = new FakeDrive();
    drive.add('aggressive-decay.json', 'FLD-forks', JSON.stringify({ brainId: 'fork-aggressive-decay', counter: 12, createdAt: '2026-06-01T00:00:00Z', policyNote: 'decay non-evergreen after 7d', entries: [{}, {}] }));
    drive.add('conservative.json', 'FLD-forks', JSON.stringify({ brainId: 'fork-conservative', counter: 20, createdAt: '2026-07-01T00:00:00Z', policyNote: 'never decay', entries: [{}] }));
    drive.add('broken.json', 'FLD-forks', 'not json');
    const cat = await fm.buildForksMuseum(drive as never, FOLDERS);
    expect(cat.map((e) => e.name)).toEqual(['conservative', 'aggressive-decay']); // counter 20 before 12
    expect(cat[0]!.entryCount).toBe(1);
    expect(cat[1]!.policyNote).toContain('7d');
    // metadata only — no raw entries carried
    expect(JSON.stringify(cat)).not.toContain('"entries"');
  });

  it('renders a museum, and the shape body passes the zone screen', async () => {
    const drive = new FakeDrive();
    drive.add('x.json', 'FLD-forks', JSON.stringify({ brainId: 'fork-x', counter: 5, createdAt: '2026-05-01T00:00:00Z', policyNote: 'trial', entries: [] }));
    const cat = await fm.buildForksMuseum(drive as never, FOLDERS);
    expect(fm.renderForksMuseum(cat)).toContain('past selves');
    const [doc] = await shapesN3.forksMuseumShape.compile({ readForks: async () => cat } as never);
    expect(doc!.body).toContain('fork-x');
    expect(doc!.body).toContain('counter 5');
  });

  it('F60:dialogue route stores a past-self dialogue at external tier', async () => {
    routes.registerN1Routes();
    const RF = { 'notebooklm/returns': 'FLD-ret', 'notebooklm/returns/processed': 'FLD-proc', 'notebooklm/returns/held': 'FLD-held' };
    const drive = new FakeDrive();
    drive.add('F60.dialogue.2026-07-17.md', 'FLD-ret', 'Asked my aggressive-decay self about the cache; it warned recall risk outweighs the small stale-hit win.');
    const saved: Array<{ content: string }> = [];
    const chunks: string[] = [];
    const res = await returns.processReturnsOnce({
      client: drive as never, folders: RF, audit: null,
      chunks: { getActiveChunks: () => [], storeChunk: (t: string) => chunks.push(t) } as never,
      structured: { listMemories: async () => [], saveMemory: async (m: never) => { saved.push(m as never); return m; } } as never,
    });
    expect(res.routed).toEqual([{ file: 'F60.dialogue.2026-07-17.md', route: 'past-self-dialogue' }]);
    expect(chunks.length).toBeGreaterThan(0);
    expect((JSON.parse(saved[0]!.content) as { trustTier: string }).trustTier).toBe('external');
  });
});
