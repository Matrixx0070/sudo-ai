/**
 * @file tests/memory/hybrid-search-wedge.test.ts
 * @description Regression for the 2026-07-29 event-loop wedge: a session-fork
 * summary arrived at RAG retrieval as a 712KB "query"; sanitiseFtsQuery turned
 * it into a ~110k-term OR-of-prefix-terms FTS5 MATCH whose evaluation is
 * SUPERLINEAR in SQLite (measured: 34ms @5KB → 6.5s @150KB → 9+ MINUTES at
 * 712KB) and synchronous — the prod daemon pinned one core at 100% with the
 * event loop (all channels, all crons) dead until a manual restart.
 *
 * The fix bounds both layers: hybridSearch clamps the query to MAX_QUERY_CHARS
 * at entry, and sanitiseFtsQuery dedupes + caps prefix terms at MAX_FTS_TOKENS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { MindDB } from '../../src/core/memory/db.js';
import {
  hybridSearch,
  sanitiseFtsQuery,
  MAX_FTS_TOKENS,
  MAX_QUERY_CHARS,
} from '../../src/core/memory/hybrid-search.js';
import type { EmbeddingService } from '../../src/core/memory/embeddings.js';

const noEmbeddings = { isAvailable: false, embed: async () => null } as unknown as EmbeddingService;

/** Diverse-vocabulary filler — unique tokens, like real conversation text. */
function bigDiverseText(chars: number): string {
  const words: string[] = [];
  let len = 0;
  let i = 0;
  while (len < chars) {
    const w = `tok${i.toString(36)}word${(i * 7919).toString(36)}`;
    words.push(w);
    len += w.length + 1;
    i++;
  }
  return words.join(' ');
}

let tmpDir: string;
let mind: MindDB;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `hybrid-wedge-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mind = new MindDB(path.join(tmpDir, 'mind.db'));
  mind.storeChunk('failover chain domain schedule budget telegram gateway', 'm/1', 'conversation');
  mind.storeChunk('quarterly revenue dashboard deploy notes', 'm/2', 'conversation');
});

afterEach(() => {
  mind.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('sanitiseFtsQuery — bounded output (2026-07-29 wedge)', () => {
  it('WEDGE-1: caps unique prefix terms at MAX_FTS_TOKENS', () => {
    const q = sanitiseFtsQuery(bigDiverseText(712_000));
    const terms = q.split(' OR ');
    expect(terms.length).toBeLessThanOrEqual(MAX_FTS_TOKENS);
  });

  it('WEDGE-2: dedupes repeated tokens instead of repeating scans', () => {
    const q = sanitiseFtsQuery('alpha alpha alpha beta beta gamma');
    expect(q).toBe('"alpha"* OR "beta"* OR "gamma"*');
  });

  it('WEDGE-3: short genuine queries are byte-identical to the old behavior', () => {
    expect(sanitiseFtsQuery('how do I monetise youtube shorts?')).toBe(
      '"how"* OR "do"* OR "I"* OR "monetise"* OR "youtube"* OR "shorts?"*',
    );
    expect(sanitiseFtsQuery('')).toBe('""');
  });

  it('WEDGE-4: sanitising 712KB of text is effectively instant', () => {
    const t0 = Date.now();
    sanitiseFtsQuery(bigDiverseText(712_000));
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('hybridSearch — giant-query clamp (2026-07-29 wedge)', () => {
  it('WEDGE-5: a 712KB query completes in bounded time and still matches', async () => {
    // Put the matching terms at the FRONT so they survive the clamp — mirrors
    // the real fork prompt whose instructions/topic lead the text.
    const query = `failover chain domain telegram ${bigDiverseText(712_000)}`;
    expect(query.length).toBeGreaterThan(700_000);

    const t0 = Date.now();
    const results = await hybridSearch(mind, noEmbeddings, { query, maxResults: 5, minScore: 0.0 });
    const ms = Date.now() - t0;

    // Pre-fix this took MINUTES (event loop dead). Generous CI bound: 5s.
    expect(ms).toBeLessThan(5_000);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.chunk.text).toContain('failover');
  });

  it('WEDGE-6: clamp constant is sane and exported', () => {
    expect(MAX_QUERY_CHARS).toBeGreaterThanOrEqual(500);
    expect(MAX_QUERY_CHARS).toBeLessThanOrEqual(20_000);
  });
});
