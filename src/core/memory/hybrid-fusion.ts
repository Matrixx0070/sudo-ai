/**
 * @file hybrid-fusion.ts
 * @description Score fusion for hybrid retrieval — the one place vector and
 * BM25 results are combined.
 *
 * Extracted from hybrid-search.ts (max-lines ratchet) and worth its own file:
 * the rule here is subtle, was wrong for a long time, and silently degraded
 * every memory lookup in the system.
 */

import type { MemoryChunk, SearchResult } from './types.js';

/**
 * Extra credit when BOTH retrievers surface the same chunk. Small on purpose:
 * it must break ties toward agreement without letting a mediocre double-hit
 * outrank an excellent single-engine match.
 */
const AGREEMENT_BONUS = 0.1;

export function mergeHybridResults(
  vectorResults: SearchResult[],
  bm25Results: SearchResult[],
  vectorWeight = 0.7,
  textWeight = 0.3,
): SearchResult[] {
  const merged = new Map<number, { chunk: MemoryChunk; vecScore: number; bm25Score: number }>();

  for (const r of vectorResults) {
    merged.set(r.chunk.id, { chunk: r.chunk, vecScore: r.score, bm25Score: 0 });
  }
  for (const r of bm25Results) {
    const existing = merged.get(r.chunk.id);
    if (existing) {
      existing.bm25Score = r.score;
    } else {
      merged.set(r.chunk.id, { chunk: r.chunk, vecScore: 0, bm25Score: r.score });
    }
  }

  return Array.from(merged.values()).map(({ chunk, vecScore, bm25Score }) => ({
    chunk,
    // A single-source match keeps its raw [0,1] score — otherwise a strong
    // BM25-exclusive hit (vecScore=0) scores textWeight*bm25 ≤ 0.3, below the
    // default minScore 0.35, and is silently dropped despite being an exact
    // keyword match (RAG-1).
    //
    // A DUAL-source match can then never score below what the same chunk would
    // have scored on one engine alone: the old code averaged the two, so a
    // chunk both engines found (vec .5, bm25 .95 -> .635) lost to a dense-only
    // hit (.8). Measured cost of that inversion: hybrid recall@5 68% vs
    // BM25-only 98% on the same 60 queries. Agreement between two independent
    // retrievers is EVIDENCE, so it earns a bounded bonus — never a penalty.
    score: vecScore > 0 && bm25Score > 0
      ? Math.min(
          1,
          Math.max(
            Math.max(vecScore, bm25Score),
            vectorWeight * vecScore + textWeight * bm25Score,
          ) + AGREEMENT_BONUS * Math.min(vecScore, bm25Score),
        )
      : Math.max(vecScore, bm25Score),
    matchType: 'hybrid' as const,
  }));
}
