import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nlm-reception-'));
process.env['DATA_DIR'] = tmp;

type Reception = typeof import('../../src/core/notebooklm/reception.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Routes = typeof import('../../src/core/notebooklm/routes-n1.js');
let reception: Reception, returns: Returns, routes: Routes;

beforeAll(async () => {
  reception = await import('../../src/core/notebooklm/reception.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  routes = await import('../../src/core/notebooklm/routes-n1.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TRANSCRIPT = [
  'The report was very clear and thorough, the atlas explanation was helpful.',
  'One host found the caching section confusing and was not sure what the verdict meant.',
  'They kept coming back to the gateway and the gateway auth boundary.',
  'Overall an impressive and coherent picture, though the timezone bit was unclear.',
].join('\n');

describe('F59 reception analysis', () => {
  it('tallies sentiment, surfaces themes, flags confusions', () => {
    const r = reception.analyzeReception(TRANSCRIPT);
    expect(r.sentiment.positive).toBeGreaterThan(0); // clear/thorough/helpful/impressive/coherent
    expect(r.sentiment.negative).toBeGreaterThan(0); // confusing/unclear
    expect(r.themes.map((t) => t.theme)).toContain('gateway'); // repeated → top theme
    expect(r.confusions.length).toBeGreaterThanOrEqual(1); // "not sure what..."/"unclear"
  });

  it('renders a report with the mood + themes', () => {
    const body = reception.renderReceptionReport('2026-07-17', reception.analyzeReception(TRANSCRIPT));
    expect(body).toContain('Reception report (F59)');
    expect(body).toMatch(/Sentiment: net (positive|negative|neutral)/);
    expect(body).toContain('gateway');
  });
});

describe('F59 return route', () => {
  it('writes a reception Doc + external-tier memory, never the default chunk ingest', async () => {
    routes.registerN1Routes();
    const FOLDERS = {
      'notebooklm/returns': 'FLD-ret', 'notebooklm/returns/processed': 'FLD-proc', 'notebooklm/returns/held': 'FLD-held',
      'notebooklm/reception': 'FLD-rec',
    };
    const files = new Map<string, { name: string; parent: string; content: string }>();
    let seq = 0;
    files.set('r1', { name: 'F59.reception.2026-07-17.md', parent: 'FLD-ret', content: TRANSCRIPT });
    const client = {
      async listChildren(fid: string) { return [...files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); },
      async filesDownload(id: string) { return files.get(id)!.content; },
      async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) files.get(id)!.parent = meta.addParents; return { id }; },
      async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) { const id = `x${++seq}`; files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' }); return { id, name: meta.name }; },
    };
    const saved: Array<{ content: string }> = [];
    const res = await returns.processReturnsOnce({
      client: client as never, folders: FOLDERS, audit: null,
      chunks: { getActiveChunks: () => [], storeChunk: () => { throw new Error('F59 must not chunk-ingest'); } } as never,
      structured: { listMemories: async () => [], saveMemory: async (m: never) => { saved.push(m as never); return m; } } as never,
    });
    expect(res.routed).toEqual([{ file: 'F59.reception.2026-07-17.md', route: 'reception-analyzed' }]);
    // reception report Doc published
    expect([...files.values()].some((f) => f.name === 'reception-2026-07-17.md' && f.parent === 'FLD-rec')).toBe(true);
    // external-tier memory saved
    const mem = JSON.parse(saved[0]!.content) as { trustTier: string; featureId: string };
    expect(mem.trustTier).toBe('external');
    expect(mem.featureId).toBe('F59');
  });
});
