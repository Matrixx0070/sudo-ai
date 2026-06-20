/**
 * @file tests/memory/vector-backfill.test.ts
 * @description Corpus ANN backfill — embeds active chunks lacking a vector into
 * the index. Orchestration is tested against a fake ChunkVectorStore + fake
 * embedder (no sqlite-vec required); covers the embedder-unavailable no-op,
 * exclusion of session-meta + superseded chunks, the maxPerRun bound, skipping
 * already-indexed chunks, and null/wrong-dimension guards.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { MindDB } from '../../src/core/memory/db.js';
import {
  backfillChunkVectors,
  isVectorBackfillEnabled,
  MindDBVectorStore,
  type ChunkVectorStore,
  type BackfillEmbedder,
} from '../../src/core/memory/vector-backfill.js';

const DIM = 1536;

class FakeStore implements ChunkVectorStore {
  ids = new Set<number>();
  puts: Array<{ id: number; dim: number }> = [];
  existingChunkIds(): Set<number> { return new Set(this.ids); }
  put(id: number, emb: Float32Array): void { this.ids.add(id); this.puts.push({ id, dim: emb.length }); }
}

/** Embedder returning a DIM-vector per text; null for texts containing 'NULL',
 *  wrong-dim for texts containing 'BADDIM'. */
function fakeEmbedder(available = true, dim = DIM): BackfillEmbedder {
  return {
    isAvailable: available,
    embedBatch: async (texts) =>
      texts.map((t) => (t.includes('NULL') ? null : new Float32Array(t.includes('BADDIM') ? 8 : dim))),
  };
}

let tmpDir: string;
let db: MindDB;
let savedFlag: string | undefined;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `sudo-vecbf-${Date.now()}-${Math.floor(performance.now())}`);
  mkdirSync(tmpDir, { recursive: true });
  db = new MindDB(path.join(tmpDir, 'mind.db'));
  savedFlag = process.env['SUDO_VECTOR_BACKFILL'];
  delete process.env['SUDO_VECTOR_BACKFILL'];
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  if (savedFlag === undefined) delete process.env['SUDO_VECTOR_BACKFILL']; else process.env['SUDO_VECTOR_BACKFILL'] = savedFlag;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('isVectorBackfillEnabled', () => {
  it('requires exact "1"', () => {
    delete process.env['SUDO_VECTOR_BACKFILL'];
    expect(isVectorBackfillEnabled()).toBe(false);
    process.env['SUDO_VECTOR_BACKFILL'] = 'true';
    expect(isVectorBackfillEnabled()).toBe(false);
    process.env['SUDO_VECTOR_BACKFILL'] = '1';
    expect(isVectorBackfillEnabled()).toBe(true);
  });
});

describe('backfillChunkVectors', () => {
  it('VB-1: embedder unavailable → no-op', async () => {
    db.storeChunk('a fact', 'memory/auto-dream', 'learning');
    const store = new FakeStore();
    const res = await backfillChunkVectors(db, fakeEmbedder(false), store);
    expect(res).toEqual({ pending: 0, embedded: 0, skipped: 0 });
    expect(store.puts).toHaveLength(0);
  });

  it('VB-2: embeds pending chunks and upserts 1536-dim vectors', async () => {
    const a = db.storeChunk('fact one', 'memory/auto-dream', 'learning');
    const b = db.storeChunk('fact two', 'insight:x', 'learning');
    const store = new FakeStore();
    const res = await backfillChunkVectors(db, fakeEmbedder(), store);
    expect(res.pending).toBe(2);
    expect(res.embedded).toBe(2);
    expect(new Set(store.puts.map((p) => p.id))).toEqual(new Set([a.id, b.id]));
    expect(store.puts.every((p) => p.dim === DIM)).toBe(true);
  });

  it('VB-3: excludes session-meta JSON and superseded chunks', async () => {
    db.storeChunk('{"session":"meta"}', 'session:abc:meta', 'conversation'); // excluded by path
    const old = db.storeChunk('old fact', 'memory/auto-dream', 'learning');
    const fresh = db.storeChunk('new fact', 'memory/auto-dream', 'learning');
    db.markChunkSuperseded(old.id, fresh.id); // old now excluded
    const store = new FakeStore();
    const res = await backfillChunkVectors(db, fakeEmbedder(), store);
    expect(res.pending).toBe(1);
    expect(store.puts.map((p) => p.id)).toEqual([fresh.id]);
  });

  it('VB-4: skips chunks already in the index', async () => {
    const a = db.storeChunk('fact one', 'memory/auto-dream', 'learning');
    const b = db.storeChunk('fact two', 'memory/auto-dream', 'learning');
    const store = new FakeStore();
    store.ids.add(a.id); // pretend a is already embedded
    const res = await backfillChunkVectors(db, fakeEmbedder(), store);
    expect(res.pending).toBe(1);
    expect(store.puts.map((p) => p.id)).toEqual([b.id]);
  });

  it('VB-5: maxPerRun bounds embeddings; pending reflects the full backlog', async () => {
    for (let i = 0; i < 5; i++) db.storeChunk(`fact ${i}`, 'memory/auto-dream', 'learning');
    const store = new FakeStore();
    const res = await backfillChunkVectors(db, fakeEmbedder(), store, { maxPerRun: 2 });
    expect(res.pending).toBe(5);
    expect(res.embedded).toBe(2);
    expect(store.puts).toHaveLength(2);
  });

  it('VB-6: null and wrong-dimension embeddings are skipped, not stored', async () => {
    db.storeChunk('good fact', 'memory/auto-dream', 'learning');
    db.storeChunk('NULL fact', 'memory/auto-dream', 'learning');     // embedder → null
    db.storeChunk('BADDIM fact', 'memory/auto-dream', 'learning');   // embedder → wrong dim
    const store = new FakeStore();
    const res = await backfillChunkVectors(db, fakeEmbedder(), store);
    expect(res.pending).toBe(3);
    expect(res.embedded).toBe(1);
    expect(res.skipped).toBe(2);
    expect(store.puts).toHaveLength(1);
  });

  // Integration: exercises the REAL vec0-backed store (catches the BigInt
  // primary-key binding that a fake store can't). Skips when sqlite-vec is
  // unavailable in the environment.
  it('VB-7: MindDBVectorStore writes chunks_vec and deleteChunk removes the vector', async () => {
    if (!db.vecLoaded) return; // sqlite-vec not loaded — nothing to exercise
    const c = db.storeChunk('a real indexed fact', 'memory/auto-dream', 'learning');
    const store = new MindDBVectorStore(db.db);
    const res = await backfillChunkVectors(db, fakeEmbedder(), store);
    expect(res.embedded).toBe(1);
    const rows = () => (db.db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n;
    expect(rows()).toBe(1);
    expect(store.existingChunkIds().has(c.id)).toBe(true);
    db.deleteChunk(c.id);          // delete-sync should drop the vec row
    expect(rows()).toBe(0);
  });
});
