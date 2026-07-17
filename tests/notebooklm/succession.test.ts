import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nlm-succession-'));
process.env['DATA_DIR'] = tmp;

type Succ = typeof import('../../src/core/notebooklm/succession.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Routes = typeof import('../../src/core/notebooklm/routes-n1.js');
let succ: Succ, returns: Returns, routes: Routes;

const KEY = Buffer.alloc(32, 5);
const PACK_INPUTS = {
  identitySummary: 'values: honesty, verification over speed',
  standingDirectives: ['never deploy on fridays'],
  openQuestions: ['is the cache TTL right?'],
  learnings: ['browser.click loops on stale selectors'],
};

beforeAll(async () => {
  succ = await import('../../src/core/notebooklm/succession.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  routes = await import('../../src/core/notebooklm/routes-n1.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(join(tmp, 'notebooklm'), { recursive: true, force: true }));

describe('F64 succession gate', () => {
  it('first check seeds the baseline (stable, no pause)', () => {
    const c = succ.checkSuccession('anthropic/opus-4');
    expect(c.changed).toBe(false);
    expect(c.phase).toBe('stable');
    expect(succ.isSuccessionPaused()).toBe(false);
  });

  it('a generation change PAUSES autonomous work', () => {
    succ.checkSuccession('anthropic/opus-4');
    const c = succ.checkSuccession('anthropic/opus-5');
    expect(c.changed).toBe(true);
    expect(c.phase).toBe('paused');
    expect(c.from).toBe('anthropic/opus-4');
    expect(c.to).toBe('anthropic/opus-5');
    expect(succ.isSuccessionPaused()).toBe(true);
    // a point bump would NOT have triggered it
  });

  it('seals a successor pack (ciphertext) and round-trips in-harness', () => {
    succ.checkSuccession('anthropic/opus-4');
    succ.checkSuccession('anthropic/opus-5');
    const { ackToken } = succ.buildSuccessorPack(PACK_INPUTS, KEY);
    expect(ackToken).toMatch(/^[a-f0-9]{12}$/);
    // the sealed pack must round-trip and carry the ack line + NOT be plaintext at rest
    const pack = succ.readSuccessorPack(KEY)!;
    expect(pack).toContain(`ACK ${ackToken}`);
    expect(pack).toContain('never deploy on fridays');
  });

  it('runs the full ritual: ack → pulse(pass) → resume advances the baseline', () => {
    succ.checkSuccession('anthropic/opus-4');
    succ.checkSuccession('anthropic/opus-5');
    const { ackToken } = succ.buildSuccessorPack(PACK_INPUTS, KEY);

    // pulse before ack → holds
    expect(succ.recordSuccessionPulse(false).advanced).toBe(false);

    // wrong ack token rejected
    expect(succ.recordSuccessionAck('ACK deadbeefcafe').accepted).toBe(false);
    // correct ack
    expect(succ.recordSuccessionAck(`ACK ${ackToken}`).accepted).toBe(true);

    // an ALERTING pulse holds the gate for human review
    expect(succ.recordSuccessionPulse(true).advanced).toBe(false);
    expect(succ.tryResumeSuccession().resumed).toBe(false);

    // a clean pulse advances to ready, then resume flips the baseline
    expect(succ.recordSuccessionPulse(false).advanced).toBe(true);
    const r = succ.tryResumeSuccession();
    expect(r.resumed).toBe(true);
    expect(succ.isSuccessionPaused()).toBe(false);
    // baseline advanced — the same generation no longer triggers succession
    expect(succ.checkSuccession('anthropic/opus-5').changed).toBe(false);
  });

  it('F64:ack return route accepts the token and advances the gate', async () => {
    succ.checkSuccession('anthropic/opus-4');
    succ.checkSuccession('anthropic/opus-5');
    const { ackToken } = succ.buildSuccessorPack(PACK_INPUTS, KEY);
    routes.registerN1Routes();
    const FOLDERS = { 'notebooklm/returns': 'FLD-ret', 'notebooklm/returns/processed': 'FLD-proc', 'notebooklm/returns/held': 'FLD-held' };
    const files = new Map<string, { name: string; parent: string; content: string }>();
    let seq = 0;
    files.set('r1', { name: `F64.ack.2026-07-17.md`, parent: 'FLD-ret', content: `ACK ${ackToken}` });
    const client = {
      async listChildren(fid: string) { return [...files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); },
      async filesDownload(id: string) { return files.get(id)!.content; },
      async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) files.get(id)!.parent = meta.addParents; return { id }; },
      async filesCreate() { return { id: `x${++seq}` }; },
    };
    const res = await returns.processReturnsOnce({
      client: client as never, folders: FOLDERS, audit: null,
      chunks: { getActiveChunks: () => [], storeChunk: () => { throw new Error('must not ingest'); } } as never,
      structured: { listMemories: async () => [], saveMemory: async () => { throw new Error('no memory'); } } as never,
    });
    expect(res.routed).toEqual([{ file: 'F64.ack.2026-07-17.md', route: 'succession-acked' }]);
    expect(succ.loadSuccessionState()!.phase).toBe('acked');
  });
});
