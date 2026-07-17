import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nlm-proberoute-'));
process.env['DATA_DIR'] = tmp;
delete process.env['LLM_ALIAS_JUDGE']; // anthropic default judge

type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Route = typeof import('../../src/core/notebooklm/probe-route.js');
type Store = typeof import('../../src/core/notebooklm/probe-store.js');
type Probe = typeof import('../../src/core/notebooklm/probe.js');
let returns: Returns, route: Route, store: Store, probe: Probe;

beforeAll(async () => {
  returns = await import('../../src/core/notebooklm/returns.js');
  route = await import('../../src/core/notebooklm/probe-route.js');
  store = await import('../../src/core/notebooklm/probe-store.js');
  probe = await import('../../src/core/notebooklm/probe.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SET: import('../../src/core/notebooklm/probe.js').ProbeSet = {
  id: 'rt-set-2026',
  feature: 'F40',
  title: 'Route test',
  corpus: 'cockpit',
  questions: [
    { qid: 'a', text: 'q a', rubric: ['single auth boundary across all surfaces'], scope: 's' },
    { qid: 'b', text: 'q b', rubric: ['phase zero kill gate fired'], scope: 's' },
  ],
};

const FOLDERS = {
  'notebooklm/returns': 'FLD-ret',
  'notebooklm/returns/processed': 'FLD-proc',
  'notebooklm/returns/held': 'FLD-held',
  'notebooklm/probes': 'FLD-probes',
};

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  add(name: string, parent: string, content: string) { const id = `f${++this.seq}`; this.files.set(id, { name, parent, content }); return id; }
  async listChildren(fid: string) { return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); }
  async filesDownload(id: string) { return this.files.get(id)!.content; }
  async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) this.files.get(id)!.parent = meta.addParents; return { id }; }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) { const id = `f${++this.seq}`; this.files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' }); return { id, name: meta.name }; }
}

describe('E4 return route — F40.probe-answers → comparison report', () => {
  it('routes external answers to the comparator and publishes a report', async () => {
    // 1. self reader answered earlier — record it (self covers 'a', blind on 'b').
    const selfRun = await probe.runProbeSelf(
      SET,
      async (q) => ({ answer: q.qid === 'a' ? 'the single auth boundary across all surfaces holds' : '', citations: [] }),
      { studentRoute: 'sudo/cheap' }, // xai student → anthropic judge independent
    );
    store.saveSelfRun(selfRun);

    // 2. wire the route: register set, judge, routes.
    route.registerProbeSet(SET);
    route.setProbeJudge(async () => '{"verdict":"agree","rationale":"same"}');
    route.registerProbeRoutes();

    // 3. external paste arrives as an E2 return (covers both a and b).
    const drive = new FakeDrive();
    drive.add(
      'F40.probe-answers.rt-set-2026.md',
      'FLD-ret',
      '## a\nthe single auth boundary across all surfaces\n\n## b\nphase zero kill gate fired against the cache',
    );
    const deps = {
      client: drive as never,
      folders: FOLDERS,
      audit: null,
      chunks: { getActiveChunks: () => [], storeChunk: () => { throw new Error('probe must not ingest to memory'); } },
      structured: { listMemories: async () => [], saveMemory: async () => { throw new Error('no memory'); } },
    } as never;

    const res = await returns.processReturnsOnce(deps);
    const routed = res.routed.find((r) => r.file === 'F40.probe-answers.rt-set-2026.md')!;
    expect(routed.route).toMatch(/^probe-compared/);
    // report published to the probes folder
    const report = [...drive.files.values()].find((f) => f.name === 'comparison-rt-set-2026.md');
    expect(report).toBeDefined();
    expect(report!.content).toContain('external-only'); // qid 'b' = dark memory (self blind)
  });
});
