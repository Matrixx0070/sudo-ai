/**
 * @file tests/memory/hybrid-search-query-degrade.test.ts
 * @description B5.2 — query-time embedding resilience. When the embedding
 * provider throws at query time (terminal failure after the #467 backoff is
 * exhausted), hybridSearch must DEGRADE to the BM25 path and still return text
 * matches instead of propagating the exception. Default-ON; the kill-switch
 * SUDO_EMBED_QUERY_DEGRADE=0 restores the old propagate-the-throw behavior.
 *
 * Forces the vector branch on with a duck-typed db wrapper (vecLoaded:true)
 * over a real temp MindDB so the FTS/BM25 query runs against real data — no
 * sqlite-vec needed because the embed() throw short-circuits before the vector
 * SQL is reached.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { MindDB } from '../../src/core/memory/db.js';
import { hybridSearch } from '../../src/core/memory/hybrid-search.js';
import type { EmbeddingService } from '../../src/core/memory/embeddings.js';

let tmpDir: string;
let mind: MindDB;
let savedFlag: string | undefined;

/** EmbeddingService stub that is "available" but THROWS on every embed call. */
const throwingEmbeddings = {
  isAvailable: true,
  embed: async (_text: string): Promise<Float32Array | null> => {
    throw new Error('embedding provider down (simulated terminal failure)');
  },
} as unknown as EmbeddingService;

/** Force useVec=true: hybridSearch only reads {vecLoaded, db} off the db arg. */
function forceVecDb(real: MindDB): MindDB {
  return { vecLoaded: true, db: real.db } as unknown as MindDB;
}

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `hybrid-degrade-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mind = new MindDB(path.join(tmpDir, 'mind.db'));
  // Seed chunks whose text matches the query so BM25 has something to return.
  mind.storeChunk('how to monetise youtube shorts with affiliate links', 'm/1', 'conversation');
  mind.storeChunk('youtube shorts retention editing strategy guide', 'm/2', 'conversation');
  mind.storeChunk('unrelated note about sourdough bread baking', 'm/3', 'conversation');
  savedFlag = process.env['SUDO_EMBED_QUERY_DEGRADE'];
});

afterEach(() => {
  mind.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env['SUDO_EMBED_QUERY_DEGRADE'];
  else process.env['SUDO_EMBED_QUERY_DEGRADE'] = savedFlag;
});

describe('hybridSearch — query-time embedding degrade (B5.2)', () => {
  it('default-ON: a query-time embed() throw degrades to BM25 (no throw, BM25 results)', async () => {
    delete process.env['SUDO_EMBED_QUERY_DEGRADE']; // default behavior
    const results = await hybridSearch(forceVecDb(mind), throwingEmbeddings, {
      query: 'youtube shorts',
      maxResults: 5,
      minScore: 0, // BM25-only scores are scaled by textWeight; keep the gate open
    });
    expect(results.length).toBeGreaterThan(0);
    // Every result came from the BM25 fallback, not the (skipped) vector path.
    expect(results.every((r) => r.matchType === 'bm25')).toBe(true);
    // The matching chunks surfaced; the unrelated one did not.
    const texts = results.map((r) => r.chunk.text).join(' | ');
    expect(texts).toContain('youtube shorts');
  });

  it('kill-switch SUDO_EMBED_QUERY_DEGRADE=0: the embed() throw propagates (old behavior)', async () => {
    process.env['SUDO_EMBED_QUERY_DEGRADE'] = '0';
    await expect(
      hybridSearch(forceVecDb(mind), throwingEmbeddings, { query: 'youtube shorts', maxResults: 5, minScore: 0 }),
    ).rejects.toThrow(/provider down/);
  });
});
