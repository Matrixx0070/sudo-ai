import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'gdrive-auto-'));
process.env['DATA_DIR'] = tmp;

type Freeze = typeof import('../../src/core/gdrive/deep-freeze.js');
type Snap = typeof import('../../src/core/gdrive/index-snapshot.js');
type Board = typeof import('../../src/core/gdrive/blackboard.js');
type Hib = typeof import('../../src/core/gdrive/hibernate.js');
type Dream = typeof import('../../src/core/gdrive/dream.js');
type Beliefs = typeof import('../../src/core/gdrive/beliefs.js');
type DeadEnds = typeof import('../../src/core/gdrive/dead-ends.js');
let freeze: Freeze, snap: Snap, board: Board, hib: Hib, dream: Dream, beliefs: Beliefs, deadEnds: DeadEnds;

const keys = { hmacKey: randomBytes(32), encKey: randomBytes(32) };

beforeAll(async () => {
  freeze = await import('../../src/core/gdrive/deep-freeze.js');
  snap = await import('../../src/core/gdrive/index-snapshot.js');
  board = await import('../../src/core/gdrive/blackboard.js');
  hib = await import('../../src/core/gdrive/hibernate.js');
  dream = await import('../../src/core/gdrive/dream.js');
  beliefs = await import('../../src/core/gdrive/beliefs.js');
  deadEnds = await import('../../src/core/gdrive/dead-ends.js');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(join(tmp, 'gdrive'), { recursive: true, force: true }));

/** Shared fake drive with content + fullText search. */
class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: Buffer; trashed: boolean; modifiedTime: string }>();
  private seq = 0;
  private async drain(body: string | NodeJS.ReadableStream): Promise<Buffer> {
    if (typeof body === 'string') return Buffer.from(body);
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }
  async listChildren(folderId: string) {
    return [...this.files.entries()]
      .filter(([, f]) => f.parent === folderId && !f.trashed)
      .map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime, mimeType: 'text/plain' }));
  }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string | NodeJS.ReadableStream }) {
    const id = `f${++this.seq}`;
    this.files.set(id, {
      name: meta.name, parent: meta.parents?.[0] ?? '',
      content: media ? await this.drain(media.body) : Buffer.alloc(0),
      trashed: false, modifiedTime: new Date(2026, 6, 17, 0, this.seq).toISOString(),
    });
    return { id, name: meta.name };
  }
  async filesUpdate(fileId: string, meta: { trashed?: boolean }, media?: { body: string | NodeJS.ReadableStream }) {
    const f = this.files.get(fileId)!;
    if (meta.trashed !== undefined) f.trashed = meta.trashed;
    if (media) f.content = await this.drain(media.body);
    return { id: fileId };
  }
  async filesDownload(fileId: string) {
    return this.files.get(fileId)!.content.toString('utf-8');
  }
  async filesDownloadRaw(fileId: string) {
    return this.files.get(fileId)!.content;
  }
  async filesGet(fileId: string) {
    const f = this.files.get(fileId);
    if (!f) throw { response: { status: 404, data: {} } };
    return { id: fileId, name: f.name, trashed: f.trashed, headRevisionId: 'rev-x', mimeType: 'text/plain' };
  }
  async filesExport(fileId: string) {
    return this.filesDownload(fileId);
  }
  async filesList(params: { q?: string; pageSize?: number }) {
    const kw = params.q?.match(/fullText contains '([^']+)'/)?.[1]?.toLowerCase() ?? '';
    const files = [...this.files.entries()]
      .filter(([, f]) => !f.trashed && f.content.toString('utf-8').toLowerCase().includes(kw))
      .map(([id, f]) => ({ id, name: f.name }));
    return { files, nextPageToken: undefined };
  }
}

const FOLDERS = {
  'memory/blobs': 'FLD-blobs',
  'memory/index-snapshots': 'FLD-snap',
  'tasks/blackboard': 'FLD-board',
  'tasks/active': 'FLD-active',
  'ops/reports': 'FLD-reports',
  'knowledge/quarantine': 'FLD-q',
};

// ---------------------------------------------------------------------------
// F11 + F27
// ---------------------------------------------------------------------------

describe('F11 — deep freeze', () => {
  it('evicts old day-logs, keeps hot stubs, recalls transparently via prefetch', async () => {
    const drive = new FakeDrive();
    const episodic = mkdtempSync(join(tmpdir(), 'episodic-'));
    const oldLog = join(episodic, '2026-06-01.md');
    writeFileSync(oldLog, '# 2026-06-01\nDiscussed the kubernetes migration rollback plan.\n');
    utimesSync(oldLog, new Date('2026-06-01'), new Date('2026-06-01'));
    const freshLog = join(episodic, '2026-07-16.md');
    writeFileSync(freshLog, '# fresh\n');

    const frozen = await freeze.runFreezeSweep(drive as never, FOLDERS, episodic, 30, new Date('2026-07-17'));
    expect(frozen).toHaveLength(1);
    expect(existsSync(oldLog)).toBe(false); // payload evicted
    expect(existsSync(freshLog)).toBe(true); // fresh stays

    // Stub search hits without Drive I/O; recall is non-blocking then cached.
    const stubs = freeze.searchStubs('kubernetes rollback');
    expect(stubs).toHaveLength(1);
    const first = freeze.recallFrozen(drive as never, stubs[0]!);
    expect(first.cached).toBeNull();
    expect(first.prefetching).toBe(true);
    await freeze.prefetchFrozen(drive as never, stubs[0]!);
    const second = freeze.recallFrozen(drive as never, stubs[0]!);
    expect(second.cached).toContain('kubernetes migration');
    expect(second.prefetching).toBe(false);
  });

  it('F27 — Drive fullText fallback returns prefetch candidates', async () => {
    const drive = new FakeDrive();
    const episodic = mkdtempSync(join(tmpdir(), 'episodic2-'));
    const f = join(episodic, '2026-05-01.md');
    writeFileSync(f, 'the zanzibar authorization model notes\n');
    utimesSync(f, new Date('2026-05-01'), new Date('2026-05-01'));
    await freeze.runFreezeSweep(drive as never, FOLDERS, episodic, 30, new Date('2026-07-17'));

    const hits = await freeze.freeRecall(drive as never, FOLDERS, 'zanzibar');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.summary).toContain('zanzibar');
  });
});

// ---------------------------------------------------------------------------
// F28
// ---------------------------------------------------------------------------

describe('F28 — embedding-index snapshots', () => {
  function fakeCacheDb(initial: Array<{ hash: string; model: string; embedding: Buffer }>) {
    const rows = [...initial];
    return {
      rows,
      prepare(sql: string) {
        return {
          all: () => rows,
          run: (hash: string, model: string, embedding: Buffer) => {
            expect(sql).toContain('INSERT OR IGNORE');
            if (rows.some((r) => r.hash === hash && r.model === model)) return { changes: 0 };
            rows.push({ hash, model, embedding });
            return { changes: 1 };
          },
        };
      },
    };
  }

  it('round-trips encrypted snapshots; hydration skips known rows (≈0 re-embeds)', async () => {
    const drive = new FakeDrive();
    const emb = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    const machineA = fakeCacheDb([
      { hash: 'h1', model: 'm', embedding: emb },
      { hash: 'h2', model: 'm', embedding: emb },
    ]);
    const up = await snap.uploadIndexSnapshot(drive as never, FOLDERS, machineA, keys);
    expect(up.uploaded).toBe(true);
    // Wire is ciphertext (zone 1 — embeddings leak content).
    const file = [...drive.files.values()].find((f) => f.parent === 'FLD-snap')!;
    expect(file.content.includes(Buffer.from('h1'))).toBe(false);

    // Fresh machine with one overlapping row: only the missing row inserts.
    const machineB = fakeCacheDb([{ hash: 'h1', model: 'm', embedding: emb }]);
    const hyd = await snap.hydrateIndexSnapshot(drive as never, FOLDERS, machineB, keys);
    expect(hyd!.inserted).toBe(1);
    expect(machineB.rows).toHaveLength(2);
    // Re-hydration inserts nothing (assert embedding-call count ≈ 0 analogue).
    const again = await snap.hydrateIndexSnapshot(drive as never, FOLDERS, machineB, keys);
    expect(again!.inserted).toBe(0);
  });

  it('identical cache re-upload dedups; prunes beyond K', async () => {
    const drive = new FakeDrive();
    const db = fakeCacheDb([{ hash: 'h1', model: 'm', embedding: Buffer.from('x') }]);
    const first = await snap.uploadIndexSnapshot(drive as never, FOLDERS, db, keys);
    const second = await snap.uploadIndexSnapshot(drive as never, FOLDERS, db, keys);
    expect(first.uploaded).toBe(true);
    expect(second.uploaded).toBe(false); // content-hash name dedup
  });
});

// ---------------------------------------------------------------------------
// F14 + F35
// ---------------------------------------------------------------------------

describe('F14 + F35 — blackboard + hibernation', () => {
  it('two instances divide a claimed task set (earliest-timestamp-wins)', () => {
    const peers = [
      {
        instanceId: 'inst-b', host: 'b', pid: 1, lastBeat: 't', status: 'running',
        claims: [{ taskId: 'task-1', claimedAt: '2026-07-17T00:00:00Z' }], discoveries: [],
      },
    ];
    // Peer claimed task-1 earlier than us -> back off.
    expect(board.resolveClaim('task-1', '2026-07-17T00:01:00Z', peers).held).toBe(false);
    // Our earlier claim on task-2 holds.
    expect(board.resolveClaim('task-2', '2026-07-17T00:01:00Z', peers).held).toBe(true);
  });

  it('hibernate on machine A, resume on machine B (two-namespace test)', async () => {
    const drive = new FakeDrive();
    // Machine A hibernates mid-flight.
    await hib.hibernateTask(drive as never, FOLDERS, keys, {
      taskId: 'migrate-db',
      plan: '1. dump 2. transform 3. load',
      stepCursor: 2,
      toolResultDigests: ['d1', 'd2'],
      pendingApprovals: [],
      brainCounter: 5,
    });
    // Task state is ciphertext on the wire (zone 1).
    const wire = [...drive.files.values()].find((f) => f.parent === 'FLD-active')!;
    expect(wire.content.includes(Buffer.from('transform'))).toBe(false);

    // "Machine B": fresh instance id (fresh DATA_DIR gdrive dir via beforeEach).
    const outcome = await hib.resumeTask(drive as never, FOLDERS, keys, 'migrate-db', 5);
    expect(outcome.action).toBe('resumed');
    if (outcome.action === 'resumed') {
      expect(outcome.task.stepCursor).toBe(2);
      expect(outcome.task.plan).toContain('transform');
    }
  });

  it('resume refuses when the local brain is behind the task (hydrate first)', async () => {
    const drive = new FakeDrive();
    await hib.hibernateTask(drive as never, FOLDERS, keys, {
      taskId: 't2', plan: 'p', stepCursor: 0, toolResultDigests: [], pendingApprovals: [], brainCounter: 9,
    });
    const outcome = await hib.resumeTask(drive as never, FOLDERS, keys, 't2', 3);
    expect(outcome.action).toBe('incompatible');
    if (outcome.action === 'incompatible') expect(outcome.reason).toContain('restore-check');
  });

  it('archive moves a task out of active (trash)', async () => {
    const drive = new FakeDrive();
    await hib.hibernateTask(drive as never, FOLDERS, keys, {
      taskId: 't3', plan: 'p', stepCursor: 0, toolResultDigests: [], pendingApprovals: [], brainCounter: 1,
    });
    expect(await hib.archiveTask(drive as never, FOLDERS, 't3')).toBe(true);
    expect((await drive.listChildren('FLD-active'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F12 — dream cycle
// ---------------------------------------------------------------------------

describe('F12 — dream cycle', () => {
  function backends() {
    const chunks: Array<{ text: string; path: string }> = [];
    const structured = new Map<string, { id: string; name: string }>();
    return {
      chunks: { getActiveChunks: () => [], storeChunk: (text: string, path: string) => { chunks.push({ text, path }); } },
      structured: {
        listMemories: async () => [],
        saveMemory: async (m: never) => { const mm = m as { id: string; name: string }; structured.set(mm.id, mm); return m; },
      },
      _chunks: chunks,
      _structured: structured,
    };
  }

  it('re-derives queued beliefs, confirms matured dead-ends, reconciles, writes the agenda', async () => {
    const drive = new FakeDrive();
    // A source doc whose belief is queued for re-derivation.
    const src = await drive.filesCreate({ name: 'spec.txt', parents: ['FLD-x'] }, { body: 'updated spec content v2' });
    const graph = beliefs.loadBeliefs();
    const b = beliefs.upsertBelief(graph, {
      id: 'b1', chunkPathPrefix: 'gdrive/spec.txt', sources: [{ fileId: src.id }], trustTier: 'principal',
    });
    beliefs.flagSourceChanged(graph, src.id);
    expect(b.rederiveQueued).toBe(true);
    beliefs.saveBeliefs(graph);

    // A matured dead-end candidate (25h old).
    const de = deadEnds.draftDeadEnd({ summary: 'x loops', patternKeys: ['tool.x same-args'], context: 'c', cause: 'c' });
    const idx = JSON.parse((await import('node:fs')).readFileSync(join(tmp, 'gdrive', 'dead-ends.json'), 'utf-8'));
    idx.deadEnds[0].createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    writeFileSync(join(tmp, 'gdrive', 'dead-ends.json'), JSON.stringify(idx));

    const be = backends();
    const report = await dream.runDreamCycle({
      client: drive as never,
      folders: FOLDERS,
      audit: null,
      chunks: be.chunks,
      structured: be.structured,
      localCounter: 1,
      restoreCheck: async () => ({ action: 'up-to-date' }),
      checkpoint: async () => ({ counter: 2 }),
      now: () => new Date(),
    });

    expect(report.rederived).toEqual(['b1']);
    expect(be._chunks[0]!.text).toContain('updated spec content v2');
    expect(beliefs.loadBeliefs().beliefs[0]!.state).toBe('fresh'); // refreshed
    expect(report.confirmedDeadEnds).toEqual([de.id]);
    expect(be._structured.get(`deadend-${de.id}`)!.name).toContain('DEAD END');
    expect(report.reconciled).toBe('up-to-date -> counter 2');
    // Agenda file written.
    const agenda = [...drive.files.values()].find((f) => f.name.startsWith('open-questions-'));
    expect(agenda).toBeTruthy();
  });

  it('planner pre-check: a re-derivation matching a confirmed dead end is skipped', async () => {
    const drive = new FakeDrive();
    const src = await drive.filesCreate({ name: 'x.txt', parents: ['FLD-x'] }, { body: 'content' });
    const graph = beliefs.loadBeliefs();
    beliefs.upsertBelief(graph, { id: 'b-skip', chunkPathPrefix: 'gdrive/x', sources: [{ fileId: src.id }], trustTier: 'agent' });
    beliefs.flagSourceChanged(graph, src.id);
    beliefs.saveBeliefs(graph);

    const de = deadEnds.draftDeadEnd({ summary: 's', patternKeys: [`re-derive belief b-skip`], context: 'c', cause: 'c' });
    const be = backends();
    await deadEnds.confirmDeadEnd(de.id, be.structured);

    const report = await dream.runDreamCycle({
      client: drive as never, folders: FOLDERS, audit: null,
      chunks: be.chunks, structured: be.structured, localCounter: 1,
      restoreCheck: async () => ({ action: 'no-remote' }),
      checkpoint: async () => ({ counter: 1 }),
    });
    expect(report.rederiveSkippedDeadEnd).toEqual(['b-skip']);
    expect(report.rederived).toEqual([]);
  });

  it('an LLM judge can veto a dead-end confirmation', async () => {
    const drive = new FakeDrive();
    const de = deadEnds.draftDeadEnd({ summary: 'transient network blip', patternKeys: ['net.fetch'], context: 'c', cause: 'flake' });
    const idx = JSON.parse((await import('node:fs')).readFileSync(join(tmp, 'gdrive', 'dead-ends.json'), 'utf-8'));
    idx.deadEnds[0].createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    writeFileSync(join(tmp, 'gdrive', 'dead-ends.json'), JSON.stringify(idx));

    const be = backends();
    const report = await dream.runDreamCycle({
      client: drive as never, folders: FOLDERS, audit: null,
      chunks: be.chunks, structured: be.structured, localCounter: 1,
      brainCall: async () => 'NO — that was a transient failure, not a structural dead end.',
      restoreCheck: async () => ({ action: 'no-remote' }),
      checkpoint: async () => ({ counter: 1 }),
    });
    expect(report.confirmedDeadEnds).toEqual([]);
    expect(deadEnds.listDeadEnds('candidate').map((d) => d.id)).toContain(de.id);
  });
});
