/**
 * @file hybrid-rrf-ordering.test.ts
 * @description RRF ordering key (rankScore) — the two engines' raw scores are
 * incommensurable (BM25 clusters 0.67–0.95, cosine 0.4–0.7), so ORDER comes
 * from reciprocal-rank fusion while the calibrated `score` remains the
 * absolute minScore gate. See hybrid-fusion.ts.
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
const rankOf = (rows: SearchResult[], id: number): number =>
  rows.find((r) => r.chunk.id === id)?.rankScore ?? -1;

describe('mergeHybridResults — RRF rank key', () => {
  it('every merged result carries a rankScore', () => {
    const merged = mergeHybridResults([res(1, 0.5)], [res(2, 0.9)]);
    for (const r of merged) expect(r.rankScore).toBeGreaterThan(0);
  });

  it("each engine's #1 gets equal per-weight franchise regardless of raw score scale", () => {
    // dense #1 scores 0.55 (typical cosine), BM25 #1 scores 0.95 (typical FTS5) —
    // under raw-score sorting BM25 wins structurally; under RRF both are rank-1
    // in their own list, so the rank key must reflect the weights, not the scales.
    const merged = mergeHybridResults([res(1, 0.55)], [res(2, 0.95)], 0.7, 0.3);
    expect(rankOf(merged, 1)).toBeGreaterThan(rankOf(merged, 2));
  });

  it('a dual-source hit out-ranks either single-source hit of the same per-engine rank', () => {
    // chunk 1 is rank-2 on BOTH engines; chunks 2/3 are each a rank-1 single hit…
    // no — corroboration must beat a single rank-2, and a rank-1 single must beat
    // a chunk found only deep in one list.
    const merged = mergeHybridResults(
      [res(2, 0.9), res(1, 0.5)],
      [res(3, 0.95), res(1, 0.6)],
    );
    // both-engines rank-2 (0.7/62 + 0.3/62 ≈ .0161) beats bm25-only rank-1 (0.3/61 ≈ .0049)
    expect(rankOf(merged, 1)).toBeGreaterThan(rankOf(merged, 3));
    // and vec rank-1 (0.7/61 ≈ .0115) still loses to the corroborated chunk
    expect(rankOf(merged, 1)).toBeGreaterThan(rankOf(merged, 2));
  });

  it('rank order is set by per-engine position, not raw score magnitude', () => {
    // vec list arrives unsorted; rank must follow score order within the engine
    const merged = mergeHybridResults([res(1, 0.4), res(2, 0.7)], []);
    expect(rankOf(merged, 2)).toBeGreaterThan(rankOf(merged, 1));
  });

  it('calibrated score is untouched by the rank key (gate semantics preserved)', () => {
    const merged = mergeHybridResults([], [res(7, 0.9)]);
    expect(merged[0]!.score).toBe(0.9);
  });
});
