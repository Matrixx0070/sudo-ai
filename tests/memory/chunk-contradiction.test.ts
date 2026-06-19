/**
 * @file tests/memory/chunk-contradiction.test.ts
 * @description Semantic contradiction detection + supersession for the free-text
 * chunks store (audit follow-up #7). Covers the pure helpers, the MindDB
 * supersession helpers + additive migration, the two-stage detector (cosine
 * narrow → LLM opposition judge), graceful degradation, and recall exclusion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { MindDB } from '../../src/core/memory/db.js';
import { EmbeddingService } from '../../src/core/memory/embeddings.js';
import { hybridSearch } from '../../src/core/memory/hybrid-search.js';
import {
  resolveChunkContradictions,
  isChunkContradictionEnabled,
  resolveSimThreshold,
  cosineSimilarity,
  type ChunkContradictionDeps,
  type ContradictionJudge,
} from '../../src/core/memory/chunk-contradiction.js';

let tmpDir: string;
let dbPath: string;
let db: MindDB;
let savedFlag: string | undefined;
let savedSim: string | undefined;

/**
 * Deterministic fake embedder: a vector keyed by the chunk's *topic* (first word
 * after a "topic:" tag, else the whole text). Same topic → identical vector
 * (cosine 1, clears threshold); different topic → orthogonal vector (cosine 0).
 * Lets a test control "same subject" independently of the opposition judge.
 */
function fakeEmbedder(): (text: string) => Promise<Float32Array | null> {
  const topics = new Map<string, number>();
  return async (text: string) => {
    const m = text.match(/topic:(\w+)/);
    const topic = m ? m[1]! : text;
    if (!topics.has(topic)) topics.set(topic, topics.size);
    const idx = topics.get(topic)!;
    const v = new Float32Array(8);
    v[idx % 8] = 1;
    return v;
  };
}

const judgeYes: ContradictionJudge = async () => true;
const judgeNo: ContradictionJudge = async () => false;

/**
 * Embedder producing a controlled cosine ~`sim` between any "near:" text and a
 * fixed anchor, used to probe the threshold gate. Two unit vectors at angle θ
 * have cosine cos θ; we place "near:" texts at a fixed small angle from the
 * anchor and everything else orthogonal.
 */
function gradedEmbedder(sim: number): (text: string) => Promise<Float32Array | null> {
  const anchor = new Float32Array([1, 0]);
  const near = new Float32Array([sim, Math.sqrt(Math.max(0, 1 - sim * sim))]);
  return async (text: string) => (text.includes('near:') ? near : (text.includes('anchor') ? anchor : new Float32Array([0, 1])));
}

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `sudo-chunk-contra-${Date.now()}-${Math.floor(performance.now())}`);
  mkdirSync(tmpDir, { recursive: true });
  dbPath = path.join(tmpDir, 'mind.db');
  db = new MindDB(dbPath);
  savedFlag = process.env['SUDO_CHUNK_CONTRADICT'];
  savedSim = process.env['SUDO_CHUNK_CONTRADICT_SIM'];
  delete process.env['SUDO_CHUNK_CONTRADICT'];
  delete process.env['SUDO_CHUNK_CONTRADICT_SIM'];
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  if (savedFlag === undefined) delete process.env['SUDO_CHUNK_CONTRADICT'];
  else process.env['SUDO_CHUNK_CONTRADICT'] = savedFlag;
  if (savedSim === undefined) delete process.env['SUDO_CHUNK_CONTRADICT_SIM'];
  else process.env['SUDO_CHUNK_CONTRADICT_SIM'] = savedSim;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function deps(embed = fakeEmbedder(), judge: ContradictionJudge = judgeYes): ChunkContradictionDeps {
  return { db, embed, judge };
}

// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('H-1: isChunkContradictionEnabled requires exact "1"', () => {
    delete process.env['SUDO_CHUNK_CONTRADICT'];
    expect(isChunkContradictionEnabled()).toBe(false);
    process.env['SUDO_CHUNK_CONTRADICT'] = 'true';
    expect(isChunkContradictionEnabled()).toBe(false);
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    expect(isChunkContradictionEnabled()).toBe(true);
  });

  it('H-2: cosineSimilarity — identical=1, orthogonal=0, mismatch/zero=0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a, new Float32Array([0, 0, 0]))).toBe(0); // zero vector
    expect(cosineSimilarity(a, new Float32Array([1, 0]))).toBe(0);    // length mismatch
  });

  it('H-3: resolveSimThreshold — default, env override, clamp, malformed fallback', () => {
    delete process.env['SUDO_CHUNK_CONTRADICT_SIM'];
    expect(resolveSimThreshold()).toBeCloseTo(0.65, 6);      // calibrated default
    expect(resolveSimThreshold(0.9)).toBeCloseTo(0.9, 6);    // explicit wins
    expect(resolveSimThreshold(5)).toBe(1);                  // explicit clamped high
    expect(resolveSimThreshold(-1)).toBe(0);                 // explicit clamped low
    process.env['SUDO_CHUNK_CONTRADICT_SIM'] = '0.72';
    expect(resolveSimThreshold()).toBeCloseTo(0.72, 6);      // env override
    process.env['SUDO_CHUNK_CONTRADICT_SIM'] = '9';          // out of [0,1]
    expect(resolveSimThreshold()).toBeCloseTo(0.65, 6);      // → default
    process.env['SUDO_CHUNK_CONTRADICT_SIM'] = 'abc';        // non-numeric
    expect(resolveSimThreshold()).toBeCloseTo(0.65, 6);      // → default
  });
});

describe('MindDB supersession helpers', () => {
  it('DB-1: markChunkSuperseded flips an active row; idempotent + self no-op', () => {
    const a = db.storeChunk('topic:editor old fact', 'memory/x.md', 'conversation');
    const b = db.storeChunk('topic:editor new fact', 'memory/x.md', 'conversation');
    expect(db.markChunkSuperseded(a.id, b.id)).toBe(true);
    expect(db.markChunkSuperseded(a.id, b.id)).toBe(false); // already superseded
    expect(db.markChunkSuperseded(b.id, b.id)).toBe(false); // self never supersedes
    expect(db.getChunk(a.id)!.supersededBy).toBe(b.id);
    expect(db.getChunk(a.id)!.supersededAt).toBeTruthy();
  });

  it('DB-2: getActiveChunks excludes superseded rows', () => {
    const a = db.storeChunk('topic:editor old', 'p', 'conversation');
    const b = db.storeChunk('topic:editor new', 'p', 'conversation');
    db.markChunkSuperseded(a.id, b.id);
    const active = db.getActiveChunks();
    expect(active.map((c) => c.id)).toContain(b.id);
    expect(active.map((c) => c.id)).not.toContain(a.id);
  });

  it('DB-3: additive migration adds columns to a pre-existing chunks table', () => {
    // Seed an OLD-schema chunks table (no supersession columns), then open via MindDB.
    const p2 = path.join(tmpDir, 'old.db');
    const seed = new Database(p2);
    seed.exec(`CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'conversation', start_line INTEGER, end_line INTEGER,
      hash TEXT NOT NULL UNIQUE, model TEXT, is_evergreen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')) );`);
    seed.close();

    const migrated = new MindDB(p2); // must ALTER TABLE without throwing
    const cols = new Set((migrated.db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((c) => c.name));
    expect(cols.has('superseded_by')).toBe(true);
    expect(cols.has('superseded_at')).toBe(true);
    const a = migrated.storeChunk('topic:e a', 'p', 'conversation');
    const b = migrated.storeChunk('topic:e b', 'p', 'conversation');
    expect(migrated.markChunkSuperseded(a.id, b.id)).toBe(true); // works on migrated table
    migrated.close();
  });
});

describe('resolveChunkContradictions (two-stage detector)', () => {
  it('C-1: flag OFF → no-op even with deps + a yes-judge', async () => {
    const a = db.storeChunk('topic:editor prefers spaces', 'p', 'conversation');
    const b = db.storeChunk('topic:editor prefers tabs', 'p', 'conversation');
    const res = await resolveChunkContradictions(b, deps(fakeEmbedder(), judgeYes));
    expect(res.supersededIds).toEqual([]);
    expect(db.getChunk(a.id)!.supersededBy).toBeUndefined();
  });

  it('C-2: same subject + judge=true → supersedes the older chunk', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    const a = db.storeChunk('topic:editor prefers spaces', 'p', 'conversation');
    const b = db.storeChunk('topic:editor prefers tabs', 'p', 'conversation');
    const res = await resolveChunkContradictions(b, deps(fakeEmbedder(), judgeYes));
    expect(res.supersededIds).toEqual([a.id]);
    expect(db.getChunk(a.id)!.supersededBy).toBe(b.id);
    expect(db.getActiveChunks().map((c) => c.id)).not.toContain(a.id);
  });

  it('C-3: same subject but judge=false (restatement) → no supersede', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    const a = db.storeChunk('topic:editor prefers spaces', 'p', 'conversation');
    const b = db.storeChunk('topic:editor likes using spaces', 'p', 'conversation');
    const res = await resolveChunkContradictions(b, deps(fakeEmbedder(), judgeNo));
    expect(res.supersededIds).toEqual([]);
    expect(db.getChunk(a.id)!.supersededBy).toBeUndefined();
  });

  it('C-4: different subject (low cosine) → judge never consulted, no supersede', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    db.storeChunk('topic:editor prefers spaces', 'p', 'conversation');
    const other = db.storeChunk('topic:database uses postgres', 'p', 'conversation');
    let judged = 0;
    const countingJudge: ContradictionJudge = async () => { judged++; return true; };
    const res = await resolveChunkContradictions(other, deps(fakeEmbedder(), countingJudge));
    expect(res.supersededIds).toEqual([]);
    expect(judged).toBe(0); // nothing cleared the similarity threshold
  });

  it('C-5: no embeddings available (embed → null) → graceful no-op', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    const a = db.storeChunk('topic:editor prefers spaces', 'p', 'conversation');
    const b = db.storeChunk('topic:editor prefers tabs', 'p', 'conversation');
    const res = await resolveChunkContradictions(b, deps(async () => null, judgeYes));
    expect(res.supersededIds).toEqual([]);
    expect(db.getChunk(a.id)!.supersededBy).toBeUndefined();
  });

  it('C-7a: candidate at cosine ~0.70 is admitted at the default threshold (0.65) → judged → superseded', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    const a = db.storeChunk('anchor existing fact', 'p', 'conversation');
    const b = db.storeChunk('near: incoming fact', 'p', 'conversation');
    const res = await resolveChunkContradictions(b, deps(gradedEmbedder(0.70), judgeYes));
    expect(res.supersededIds).toEqual([a.id]);
  });

  it('C-7b: SUDO_CHUNK_CONTRADICT_SIM=0.75 excludes the ~0.70 candidate → judge never reached', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    process.env['SUDO_CHUNK_CONTRADICT_SIM'] = '0.75';
    const a = db.storeChunk('anchor existing fact', 'p', 'conversation');
    const b = db.storeChunk('near: incoming fact', 'p', 'conversation');
    let judged = 0;
    const countingJudge: ContradictionJudge = async () => { judged++; return true; };
    const res = await resolveChunkContradictions(b, deps(gradedEmbedder(0.70), countingJudge));
    expect(res.supersededIds).toEqual([]);
    expect(judged).toBe(0);
    expect(db.getChunk(a.id)!.supersededBy).toBeUndefined();
  });

  it('C-8: candidateFilter scopes eligible candidates — filtered-out chunks are never judged', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    // An earlier same-subject fact in a DIFFERENT source (e.g. session-meta).
    const meta = db.storeChunk('topic:editor prefers spaces', 'session:x:meta', 'conversation');
    const learn = db.storeChunk('topic:editor prefers tabs', 'memory/auto-dream', 'learning');
    let judged = 0;
    const countingYes: ContradictionJudge = async () => { judged++; return true; };
    // Filter to source==='learning' → the 'conversation' meta chunk is excluded.
    const res = await resolveChunkContradictions(
      learn,
      deps(fakeEmbedder(), countingYes),
      { candidateFilter: (c) => c.source === 'learning' },
    );
    expect(judged).toBe(0);                       // meta chunk never reached the judge
    expect(res.supersededIds).toEqual([]);
    expect(db.getChunk(meta.id)!.supersededBy).toBeUndefined();
  });

  it('C-6: judge throwing is swallowed — never blocks, candidate skipped', async () => {
    process.env['SUDO_CHUNK_CONTRADICT'] = '1';
    const a = db.storeChunk('topic:editor prefers spaces', 'p', 'conversation');
    const b = db.storeChunk('topic:editor prefers tabs', 'p', 'conversation');
    const throwingJudge: ContradictionJudge = async () => { throw new Error('LLM down'); };
    const res = await resolveChunkContradictions(b, deps(fakeEmbedder(), throwingJudge));
    expect(res.supersededIds).toEqual([]);
    expect(db.getChunk(a.id)!.supersededBy).toBeUndefined();
  });
});

describe('recall exclusion (BM25 hybrid-search path)', () => {
  it('R-1: a superseded chunk is dropped from search results', async () => {
    const a = db.storeChunk('the deployment runs on kubernetes', 'p', 'conversation');
    const b = db.storeChunk('the deployment runs on nomad instead', 'p', 'conversation');
    const embeddings = new EmbeddingService(db); // no API key → BM25-only, fine

    const before = await hybridSearch(db, embeddings, { query: 'deployment runs', minScore: 0 });
    expect(before.map((r) => r.chunk.id)).toContain(a.id);

    db.markChunkSuperseded(a.id, b.id);

    const after = await hybridSearch(db, embeddings, { query: 'deployment runs', minScore: 0 });
    expect(after.map((r) => r.chunk.id)).not.toContain(a.id); // retired chunk excluded
    expect(after.map((r) => r.chunk.id)).toContain(b.id);      // active chunk still found
  });
});
