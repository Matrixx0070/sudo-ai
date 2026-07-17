import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nlm-n1gaps-'));
process.env['DATA_DIR'] = tmp;

type Comments = typeof import('../../src/core/gdrive/comments.js');
type Datasets = typeof import('../../src/core/gdrive/datasets.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Routes = typeof import('../../src/core/notebooklm/routes-n1.js');
type DeadEnds = typeof import('../../src/core/gdrive/dead-ends.js');
type Dream = typeof import('../../src/core/gdrive/dream.js');
type Beliefs = typeof import('../../src/core/gdrive/beliefs.js');
let comments: Comments, datasets: Datasets, returns: Returns, routes: Routes, deadEnds: DeadEnds, dream: Dream, beliefs: Beliefs;

beforeAll(async () => {
  comments = await import('../../src/core/gdrive/comments.js');
  datasets = await import('../../src/core/gdrive/datasets.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  routes = await import('../../src/core/notebooklm/routes-n1.js');
  deadEnds = await import('../../src/core/gdrive/dead-ends.js');
  dream = await import('../../src/core/gdrive/dream.js');
  beliefs = await import('../../src/core/gdrive/beliefs.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(join(tmp, 'gdrive'), { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// G-F46MARK — comment source markers
// ---------------------------------------------------------------------------

describe('G-F46MARK — comment source markers make F46 corrections countable', () => {
  it('a "F46:" prefixed comment is tagged + stripped; dataset row carries the marker', async () => {
    comments.watchDoc('atlas1', 'brain atlas');
    const drive = {
      async commentsList() {
        return [{ id: 'c1', resolved: false, content: 'F46: the infra topic is wrong', author: { emailAddress: 'frank@x.com' } }];
      },
      async repliesCreate() {},
    };
    const saved: Array<{ name: string; content: string }> = [];
    const store = { listMemories: async () => [], saveMemory: async (m: never) => { saved.push(m as never); return m; } };
    const r = await comments.pollComments({ client: drive as never, structured: store, principalEmails: ['frank@x.com'], serviceAccountEmail: 'sa@x.com' });
    expect(r.corrections).toBe(1);
    expect(saved[0]!.name).toContain('[F46]');
    expect(saved[0]!.content).toContain('the infra topic is wrong');
    expect(saved[0]!.content).not.toContain('F46:'); // marker stripped from body
    const rows = datasets.readDataset<{ marker?: string; correction: string }>('corrections');
    expect(rows.some((row) => row.marker === 'F46')).toBe(true);
    // Count F46 corrections — the whole point.
    expect(rows.filter((row) => row.marker === 'F46').length).toBeGreaterThanOrEqual(1);
  });

  it('an unmarked comment has no marker (null in dataset)', async () => {
    comments.watchDoc('atlas2', 'brain atlas');
    const drive = {
      async commentsList() { return [{ id: 'c2', resolved: false, content: 'just a normal correction', author: { emailAddress: 'frank@x.com' } }]; },
      async repliesCreate() {},
    };
    const store = { listMemories: async () => [], saveMemory: async (m: never) => m };
    await comments.pollComments({ client: drive as never, structured: store, principalEmails: ['frank@x.com'], serviceAccountEmail: 'sa@x.com' });
    const rows = datasets.readDataset<{ marker?: string | null; correction: string }>('corrections');
    expect(rows.some((row) => row.correction.includes('normal correction') && (row.marker === null || row.marker === undefined))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F43 postmortem return route → dead-end candidate
// ---------------------------------------------------------------------------

describe('F43 return route — postmortem → dead-end candidate', () => {
  it('a quarantined F43 postmortem becomes a dead-end candidate, not a memory', async () => {
    routes.registerN1Routes();
    const FOLDERS = { 'notebooklm/returns': 'FLD-ret', 'notebooklm/returns/processed': 'FLD-proc', 'notebooklm/returns/held': 'FLD-held' };
    const files = new Map<string, { name: string; parent: string; content: string }>();
    files.set('r1', { name: 'F43.postmortem.inc-99.md', parent: 'FLD-ret', content: 'browser.click looped forever on a stale selector. Cause: selector rot.' });
    let seq = 0;
    const client = {
      async listChildren(fid: string) { return [...files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); },
      async filesDownload(id: string) { return files.get(id)!.content; },
      async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) files.get(id)!.parent = meta.addParents; return { id }; },
      async filesCreate() { return { id: `x${++seq}` }; },
    };
    const chunks = { getActiveChunks: () => [], storeChunk: () => { throw new Error('should not ingest to memory'); } };
    const res = await returns.processReturnsOnce({ client: client as never, folders: FOLDERS, audit: null, chunks: chunks as never, structured: { listMemories: async () => [], saveMemory: async () => { throw new Error('no memory'); } } as never });
    expect(res.routed).toEqual([{ file: 'F43.postmortem.inc-99.md', route: 'dead-end-candidate' }]);
    const candidates = deadEnds.listDeadEnds('candidate');
    expect(candidates.some((d) => d.summary.includes('browser.click looped'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G-F52RANK — dream open-questions ranked (orphaned > stale > hold)
// ---------------------------------------------------------------------------

describe('G-F52RANK — dream cycle ranks open questions', () => {
  it('orphaned beliefs rank above stale in the open-questions file', async () => {
    // Seed beliefs: one stale, one orphaned, both queued.
    const graph = beliefs.loadBeliefs();
    beliefs.upsertBelief(graph, { id: 'b-stale', chunkPathPrefix: 'x', sources: [{ fileId: 's1' }], trustTier: 'agent' });
    beliefs.upsertBelief(graph, { id: 'b-orph', chunkPathPrefix: 'y', sources: [{ fileId: 's2' }], trustTier: 'agent' });
    beliefs.flagSourceChanged(graph, 's1'); // stale
    beliefs.flagSourceDeleted(graph, 's2'); // orphaned
    beliefs.saveBeliefs(graph);

    const written: Record<string, string> = {};
    const client = {
      async listChildren() { return []; },
      async filesCreate(meta: { name: string }, media: { body: string }) { written[meta.name] = media.body; return { id: 'f1' }; },
      async filesUpdate() { return { id: 'f1' }; },
    };
    const be = { chunks: { getActiveChunks: () => [], storeChunk: () => {} }, structured: { listMemories: async () => [], saveMemory: async (m: never) => m } };
    await dream.runDreamCycle({
      client: client as never,
      folders: { 'ops/reports': 'FLD-r', 'knowledge/quarantine': 'FLD-q' } as never,
      audit: null,
      chunks: be.chunks as never,
      structured: be.structured as never,
      localCounter: 1,
      restoreCheck: async () => ({ action: 'no-remote' }),
      checkpoint: async () => ({ counter: 1 }),
      now: () => new Date('2026-07-17T00:00:00Z'),
    });
    const oqName = Object.keys(written).find((n) => n.startsWith('open-questions-'))!;
    const parsed = JSON.parse(written[oqName]!) as { ranked: Array<{ question: string; score: number }> };
    // orphaned (score 3) must come before stale (score 2)
    const orphIdx = parsed.ranked.findIndex((r) => r.question.includes('b-orph'));
    const staleIdx = parsed.ranked.findIndex((r) => r.question.includes('b-stale'));
    expect(orphIdx).toBeGreaterThanOrEqual(0);
    expect(orphIdx).toBeLessThan(staleIdx);
    expect(parsed.ranked[0]!.score).toBe(3);
  });
});
