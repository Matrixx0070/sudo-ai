import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'nlm-n1-'));
process.env['DATA_DIR'] = tmp;

import { cockpitShape, architectureShape, researchTargetShape } from '../../src/core/notebooklm/shapes-n1.js';
import { redactSecrets } from '../../src/core/notebooklm/zone-screen.js';
import { registerN1Rituals } from '../../src/core/notebooklm/rituals-n1.js';
import { allRituals, tier1WeeklyMinutes, TIER1_WEEKLY_BUDGET_MIN } from '../../src/core/notebooklm/rituals.js';

type Packs = typeof import('../../src/core/notebooklm/packs.js');
type FlightRecorder = typeof import('../../src/core/gdrive/flight-recorder.js');
let packs: Packs;
let fr: FlightRecorder;

beforeAll(async () => {
  packs = await import('../../src/core/notebooklm/packs.js');
  fr = await import('../../src/core/gdrive/flight-recorder.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ctx = {
  now: () => new Date('2026-07-17T00:00:00Z'),
  readReports: async () => ['clean report'],
  readOpenQuestions: async () => ['Belief gdrive-x still orphaned — re-derivation pending', 'Quarantine HOLD needs review: foo'],
  readAuditNotes: async () => ['x: success'],
  readFile: (p: string) => (p.endsWith('.md') ? `# ${p}\ncontent of ${p}` : null),
  readSourceDocs: async () => [{ name: 'atlas', id: 'a1', url: 'https://drive/a1' }, { name: 'daily-2026-07-16', id: 'd1' }],
};

describe('N1 shapes compile', () => {
  it('F41 cockpit renders chat-instruction + pointer card with live ids', async () => {
    const [doc] = await cockpitShape.compile(ctx as never);
    expect(doc!.name).toBe('chat-instruction');
    expect(doc!.body).toContain('inspection console for an autonomous agent');
    expect(doc!.body).toContain('atlas');
    expect(doc!.body).toContain('https://drive/a1');
  });
  it('F42 architecture pack compiles repo docs into <=8 zone-screened Docs', async () => {
    const docs = await architectureShape.compile(ctx as never);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.length).toBeLessThanOrEqual(8);
    expect(docs[0]!.name).toMatch(/^arch-/);
  });
  it('F52 research-target picks the highest-ranked open question', async () => {
    const [doc] = await researchTargetShape.compile(ctx as never);
    expect(doc!.body).toContain("Tonight's research target");
    expect(doc!.body).toContain('orphaned'); // the [0] ranked question
    expect(doc!.body).toContain('F52.research');
  });
  it('F52 research-target degrades gracefully with no questions', async () => {
    const [doc] = await researchTargetShape.compile({ ...ctx, readOpenQuestions: async () => [] } as never);
    expect(doc!.body).toContain('No open question tonight');
  });
});

describe('F43 declassification screen (redactSecrets)', () => {
  it('redacts secrets in place, keeps surrounding text', () => {
    const { redacted, hits } = redactSecrets('step 1 ok. token=AKIAABCDEFGHIJKLMNOP then continue');
    expect(hits).toBeGreaterThan(0);
    expect(redacted).toContain('[REDACTED');
    expect(redacted).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(redacted).toContain('then continue');
  });
});

describe('F43 incident pack — zone-1 bundle leak test', () => {
  it('exports a redacted transcript; a seeded secret in the bundle never appears', async () => {
    const keys = { hmacKey: randomBytes(32), encKey: randomBytes(32) };
    const bundle = fr.buildRunBundle({
      runId: 'run-leak-1', sessionId: 's1', startedAt: 't', finishedAt: 't', outcome: 'failure',
      events: [{ type: 'tool-result', digest: 'AKIASECRETSECRET1234 leaked here' }] as never,
      llmCalls: [], traceStore: { query: () => [{ tool: 'browser.click', note: 'password: hunter2secret' }] },
    });
    const wire = fr.packBundle(bundle, keys);

    // Fake drive: incident bundle in ops/incidents, output to notebooklm/incidents.
    const docs = new Map<string, { name: string; parent: string; content: string; raw?: Buffer }>();
    let seq = 0;
    const gdriveFolders = { 'ops/incidents': 'FLD-inc' };
    const nlmFolders = { 'notebooklm/incidents': 'FLD-nlm-inc' };
    docs.set('bundle1', { name: 'run-run-leak-1.json.gz.enc', parent: 'FLD-inc', content: '', raw: wire });
    const client = {
      async listChildren(fid: string) {
        return [...docs.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name }));
      },
      async filesDownloadRaw(id: string) {
        return docs.get(id)!.raw!;
      },
      async filesCreateAsGoogleDoc(name: string, parent: string, body: string) {
        const id = `d${++seq}`;
        docs.set(id, { name, parent, content: body });
        return { id, name };
      },
      async filesUpdateGoogleDoc() {},
    };
    const res = await packs.exportIncidentPack(client as never, gdriveFolders, nlmFolders, 'run-leak-1', keys, null);
    expect(res.docs.length).toBe(3);
    expect(res.redactionHits).toBeGreaterThan(0);
    const transcript = [...docs.values()].find((d) => d.name.includes('transcript'))!;
    expect(transcript.content).not.toContain('AKIASECRETSECRET1234');
    expect(transcript.content).not.toContain('hunter2secret');
    expect(transcript.content).toContain('[REDACTED');
  });
});

describe('F45 study pack', () => {
  it('screens zone-2 context; withholds a zone-1 snippet', async () => {
    const docs = new Map<string, { name: string; content: string }>();
    let seq = 0;
    const client = {
      async listChildren() { return [...docs.entries()].map(([id, d]) => ({ id, name: d.name })); },
      async filesCreateAsGoogleDoc(name: string, _p: string, body: string) { const id = `d${++seq}`; docs.set(id, { name, content: body }); return { id, name }; },
      async filesUpdateGoogleDoc(id: string, body: string) { docs.get(id)!.content = body; },
    };
    const res = await packs.exportStudyPack(client as never, { 'notebooklm/studypacks': 'FLD-sp' }, {
      questionId: 'kubernetes-rollback',
      question: 'how do we roll back a kubernetes deploy?',
      context: ['kubectl rollout undo restores the previous revision', 'the api_key for prod is AKIAZZZZZZZZZZZZZZZZ'],
    });
    expect(res.contextCount).toBe(1); // the secret snippet withheld
    const doc = [...docs.values()][0]!;
    expect(doc.content).toContain('kubectl rollout undo');
    expect(doc.content).not.toContain('AKIAZZZZZZZZZZZZZZZZ');
  });
});

describe('N1 rituals + Tier-1 budget', () => {
  it('after N1 registration Tier-1 stays within budget (F39 14 + F46 5 = 19)', () => {
    registerN1Rituals();
    expect(tier1WeeklyMinutes()).toBe(19);
    expect(tier1WeeklyMinutes()).toBeLessThanOrEqual(TIER1_WEEKLY_BUDGET_MIN);
    const ids = allRituals().map((r) => r.id);
    expect(ids).toContain('quiz-the-brain');
    expect(ids).toContain('architecture-explainer');
    expect(ids).toContain('research-desk');
  });
});
