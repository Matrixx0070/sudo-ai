/**
 * P2 coverage + provability pins (docs/DRIVE_SECURITY_AUDIT_2026-07-28.md
 * items 7-9): canary checks in the remaining ingress lanes, pause checks at
 * job entries, per-blob zone in audit rows, ops-screen audit seam, and the
 * F5 user-file inspection upgrade (held → refusal; see also
 * deferred-slices.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// DATA_DIR must be set before the gdrive modules load (paths.ts captures it).
const tmp = mkdtempSync(join(tmpdir(), 'gdrive-p2-'));
process.env['DATA_DIR'] = tmp;

type Canary = typeof import('../../src/core/gdrive/canary.js');
type Mirror = typeof import('../../src/core/gdrive/mirror.js');
type Comments = typeof import('../../src/core/gdrive/comments.js');
type Changes = typeof import('../../src/core/gdrive/changes.js');
type Blackboard = typeof import('../../src/core/gdrive/blackboard.js');
type Curiosity = typeof import('../../src/core/gdrive/curiosity.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type OpsScreen = typeof import('../../src/core/gdrive/ops-screen.js');
type Checkpoint = typeof import('../../src/core/gdrive/checkpoint.js');
let canary: Canary;
let mirror: Mirror;
let comments: Comments;
let changes: Changes;
let blackboard: Blackboard;
let curiosity: Curiosity;
let returns: Returns;
let ops: OpsScreen;
let checkpoint: Checkpoint;

const MARKER = 'CANARY-P2-MARKER-91337';

beforeAll(async () => {
  canary = await import('../../src/core/gdrive/canary.js');
  mirror = await import('../../src/core/gdrive/mirror.js');
  comments = await import('../../src/core/gdrive/comments.js');
  changes = await import('../../src/core/gdrive/changes.js');
  blackboard = await import('../../src/core/gdrive/blackboard.js');
  curiosity = await import('../../src/core/gdrive/curiosity.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  ops = await import('../../src/core/gdrive/ops-screen.js');
  checkpoint = await import('../../src/core/gdrive/checkpoint.js');
  mkdirSync(join(tmp, 'gdrive'), { recursive: true });
  writeFileSync(
    join(tmp, 'gdrive', 'canaries.json'),
    JSON.stringify({ canaries: [{ fileId: '', marker: MARKER, label: 'p2-test' }] }),
  );
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => canary.clearGdrivePause());

/** A client that fails the test if any Drive I/O happens. */
const untouchableClient = new Proxy(
  {},
  { get: (_t, prop) => () => { throw new Error(`Drive I/O attempted while paused: ${String(prop)}`); } },
) as never;

describe('pause checks at job entries (audit item 7)', () => {
  it('mirror sweep no-ops while paused', async () => {
    canary.setGdrivePaused('test');
    const res = await mirror.runMirrorSweep(untouchableClient, { 'knowledge/mirror': 'FLD' } as never, null, {
      config: { refs: [{ name: 'ref1', url: 'https://example.com' }] },
    });
    expect(res.fetched).toEqual([]);
  });
  it('comments poll no-ops while paused', async () => {
    canary.setGdrivePaused('test');
    const res = await comments.pollComments({
      client: untouchableClient,
      structured: { listMemories: async () => [], saveMemory: async () => {} } as never,
      principalEmails: ['frank@example.com'],
      serviceAccountEmail: 'sa@example.com',
    });
    expect(res).toEqual({ corrections: 0, ignored: 0, held: 0 });
  });
  it('changes sweep no-ops while paused', async () => {
    canary.setGdrivePaused('test');
    const res = await changes.runChangesSweep(untouchableClient);
    expect(res.changes).toBe(0);
  });
  it('blackboard write/read no-op while paused', async () => {
    canary.setGdrivePaused('test');
    const me = await blackboard.writeMyStatus(untouchableClient, { 'tasks/blackboard': 'FLD' } as never, { status: 'running' });
    expect(me.status).toBe('running'); // coherent value, no Drive I/O
    expect(await blackboard.readPeers(untouchableClient, { 'tasks/blackboard': 'FLD' } as never)).toEqual([]);
  });
});

describe('canary checks in remaining ingress lanes (audit item 7)', () => {
  it('mirror content carrying a canary marker trips F19 and aborts the sweep', async () => {
    const uploads: string[] = [];
    const client = {
      async listChildren() { return []; },
      async filesCreate(meta: { name: string }) { uploads.push(meta.name); return { id: 'x', name: meta.name }; },
      async filesUpdate() { return {}; },
    } as never;
    const res = await mirror.runMirrorSweep(client, { 'knowledge/mirror': 'FLD' } as never, null, {
      config: { refs: [{ name: 'ref1', url: 'https://example.com' }] },
      fetcher: async () => `external page containing ${MARKER}`,
    });
    expect(res.aborted).toBe(true);
    expect(uploads).toEqual([]); // never snapshotted
    expect(canary.isGdrivePaused()).toBe(true);
  });

  it('curiosity research output carrying a canary marker trips F19 and aborts the drain', async () => {
    curiosity.appendCuriosity('what is the meaning of life?');
    const uploads: string[] = [];
    const client = {
      async filesCreate(meta: { name: string }) { uploads.push(meta.name); return { id: 'x', name: meta.name }; },
    } as never;
    const res = await curiosity.drainCuriosity(client, { 'knowledge/curiosity': 'FLD' } as never, {
      research: async () => `research result with ${MARKER} planted`,
      chunks: { storeChunk: () => {} } as never,
      structured: { listMemories: async () => [], saveMemory: async () => {} } as never,
    });
    expect(res.researched).toEqual([]);
    expect(uploads).toEqual([]); // aborted before any upload/ingest
    expect(canary.isGdrivePaused()).toBe(true);
  });

  it('NLM default return route canary-checks content before any model reads it', async () => {
    const moves: Array<{ id: string; to?: string }> = [];
    const client = {
      async listChildren(fid: string) {
        return fid === 'FLD-ret' ? [{ id: 'r1', name: 'F45.studypack-notes.2026-07-28.md', mimeType: 'text/markdown' }] : [];
      },
      async filesDownload() { return `returned analysis quoting ${MARKER}`; },
      async filesUpdate(id: string, meta: { addParents?: string }) { moves.push({ id, to: meta.addParents }); return {}; },
      async filesCreate() { throw new Error('should not ingest'); },
    } as never;
    const res = await returns.processReturnsOnce({
      client,
      folders: {
        'notebooklm/returns': 'FLD-ret',
        'notebooklm/returns/processed': 'FLD-proc',
        'notebooklm/returns/held': 'FLD-held',
      } as never,
      audit: null,
      chunks: { storeChunk: () => { throw new Error('should not store'); } } as never,
      structured: { listMemories: async () => [], saveMemory: async () => { throw new Error('should not save'); } } as never,
    });
    expect(res.held).toEqual(['F45.studypack-notes.2026-07-28.md']);
    expect(moves).toEqual([{ id: 'r1', to: 'FLD-held' }]);
    expect(canary.isGdrivePaused()).toBe(true);
  });
});

describe('egress provability (audit item 8)', () => {
  it('flagged ops-screen results land a tamper-evident audit row via the seam', () => {
    const rows: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
    ops.setOpsScreenAudit({ record: (e: never) => { rows.push(e); } } as never);
    ops.screenOpsUpload('leak: token=AKIAABCDEFGHIJKLMNOP', 'test:item8');
    ops.setOpsScreenAudit(null);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe('gdrive.ops-screen');
    expect(rows[0]!.metadata?.['context']).toBe('test:item8');
    expect(Number(rows[0]!.metadata?.['redactions'])).toBeGreaterThan(0);
  });

  it('checkpoint audit row records per-blob zones explicitly', async () => {
    const rows: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
    const files = new Map<string, { name: string; parent: string }>();
    let seq = 0;
    const client = {
      async listChildren(fid: string) {
        return [...files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name }));
      },
      async filesCreate(meta: { name: string; parents?: string[] }) {
        const id = `f${++seq}`;
        files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '' });
        return { id, name: meta.name };
      },
      async filesUpdate(id: string) { return { id }; },
    } as never;
    await checkpoint.runCheckpoint({
      client,
      folders: { 'memory/blobs': 'FLD-blobs', manifest: 'FLD-man' } as never,
      keys: { hmacKey: randomBytes(32), encKey: randomBytes(32) } as never,
      snapshot: {
        chunks: {
          getActiveChunks: () => [
            { text: 'plain zone-2 fact', path: 'a', source: 's', hash: 'h1', isEvergreen: false, createdAt: 't' },
            { text: 'the password is hunter2', path: 'b', source: 's', hash: 'h2', isEvergreen: false, createdAt: 't' },
          ],
        } as never,
        structured: { listMemories: async () => [], saveMemory: async () => {} } as never,
        memoryMdPath: join(tmp, 'nonexistent-MEMORY.md'),
      },
      audit: { record: (e: never) => { rows.push(e); } } as never,
    });
    const row = rows.find((r) => r.action === 'gdrive.checkpoint');
    expect(row).toBeDefined();
    expect(Number(row!.metadata?.['zone1Blobs'])).toBeGreaterThan(0);
    expect(Number(row!.metadata?.['zone2Blobs'])).toBeGreaterThan(0);
    const blobZones = row!.metadata?.['blobZones'] as string[];
    expect(blobZones.some((b) => b.includes('.enc:z1'))).toBe(true);
  });
});
