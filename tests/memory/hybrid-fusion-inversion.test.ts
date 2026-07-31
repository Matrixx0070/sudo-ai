/**
 * @file hybrid-fusion-inversion.test.ts
 * @description Regression: hybrid fusion must never rank a chunk BOTH retrievers
 * found below one only a single retriever found.
 *
 * The old blend averaged dual-source hits (0.7*vec + 0.3*bm25) while giving
 * single-source hits their raw score via max(). So vec .5 / bm25 .95 scored
 * .635 and LOST to a dense-only .8 — agreement between two independent
 * retrievers was a penalty. Measured cost on 60 real corpus queries:
 * hybrid recall@1 33% / recall@5 68%, against BM25-only 93% / 98%.
 * After the fix: 73% / 93%.
 */

import { describe, it, expect } from 'vitest';
import { mergeHybridResults } from '../../src/core/memory/hybrid-search.js';
import type { MemoryChunk, SearchResult } from '../../src/core/memory/types.js';

function chunk(id: number): MemoryChunk {
  return { id, text: `chunk ${id}`, path: `p/${id}`, source: 'learning' } as unknown as MemoryChunk;
}
function res(id: number, score: number): SearchResult {
  return { chunk: chunk(id), score, matchType: 'vector' } as unknown as SearchResult;
}
const scoreOf = (rows: SearchResult[], id: number): number =>
  rows.find((r) => r.chunk.id === id)?.score ?? -1;

describe('mergeHybridResults — agreement must never be a penalty', () => {
  it('the historical inversion case: dual-source (.5/.95) outranks dense-only (.8)', () => {
    const merged = mergeHybridResults([res(1, 0.5), res(2, 0.8)], [res(1, 0.95)]);
    expect(scoreOf(merged, 1)).toBeGreaterThan(scoreOf(merged, 2));
  });

  it('a dual-source hit never scores below its own best single component', () => {
    for (const [v, b] of [[0.5, 0.95], [0.9, 0.1], [0.2, 0.3], [0.75, 0.75]] as const) {
      const merged = mergeHybridResults([res(1, v)], [res(1, b)]);
      expect(scoreOf(merged, 1)).toBeGreaterThanOrEqual(Math.max(v, b));
    }
  });

  it('keeps the RAG-1 property: a BM25-exclusive hit retains its raw score', () => {
    // Must stay above the default minScore (0.35) or exact keyword matches vanish.
    const merged = mergeHybridResults([], [res(7, 0.9)]);
    expect(scoreOf(merged, 7)).toBe(0.9);
  });

  it('scores stay within [0,1] even when both components are maximal', () => {
    const merged = mergeHybridResults([res(1, 1)], [res(1, 1)]);
    expect(scoreOf(merged, 1)).toBeLessThanOrEqual(1);
    expect(scoreOf(merged, 1)).toBeGreaterThan(0);
  });

  it('agreement breaks ties: equal best-component, but one has corroboration', () => {
    const merged = mergeHybridResults([res(1, 0.8), res(2, 0.8)], [res(1, 0.6)]);
    expect(scoreOf(merged, 1)).toBeGreaterThan(scoreOf(merged, 2));
  });
});
