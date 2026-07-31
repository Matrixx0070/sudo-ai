/**
 * @file mmr-rerank.ts
 * @description Maximal Marginal Relevance re-ranking for hybrid search results.
 * Extracted from hybrid-search.ts (max-lines ratchet), mirroring the
 * hybrid-fusion.ts split.
 */

import type { SearchResult } from './types.js';

/**
 * Maximal Marginal Relevance re-ranking.
 *
 * Iteratively selects the next result that maximises:
 *   lambda * relevance(result) - (1-lambda) * max_similarity(result, selected)
 *
 * Because we don't store full embedding vectors in the result set, we use
 * normalised relevance as a proxy for query similarity and a score-overlap
 * heuristic for inter-result similarity.
 *
 * @param results - Sorted (best first) result set
 * @param lambda  - 1.0 = pure relevance, 0.0 = pure diversity (default: 0.7)
 */
export function mmrRerank(results: SearchResult[], lambda = 0.7): SearchResult[] {
  if (results.length <= 1) return results;

  // Relevance term = the effective RANKING key, normalised to [0,1] over this
  // result set. Using raw calibrated scores here would re-sort by the two
  // engines' incommensurable scales and silently undo the RRF ordering for
  // every mmr:true caller (rag-engine is one). The score-proximity similarity
  // heuristic below still uses calibrated scores — it compares like with like.
  const keys = results.map((r) => r.rankScore ?? r.score);
  const kMin = Math.min(...keys);
  const kRange = Math.max(...keys) - kMin;
  const relevance = new Map<SearchResult, number>(
    results.map((r, i) => [r, kRange > 0 ? (keys[i]! - kMin) / kRange : 1]),
  );

  const selected: SearchResult[] = [];
  const remaining = [...results];

  // Greedy MMR selection
  while (remaining.length > 0 && selected.length < results.length) {
    let bestIdx = 0;
    let bestMmrScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;

      // Proxy for max similarity to already-selected set:
      // use 1 - (score gap), bounded to [0,1].
      const maxSimilarityToSelected =
        selected.length === 0
          ? 0
          : Math.max(
              ...selected.map((s) =>
                // Simple score-proximity heuristic: chunks with similar
                // relevance scores are assumed to be similar in content.
                1 - Math.min(1, Math.abs(candidate.score - s.score)),
              ),
            );

      const mmrScore =
        lambda * relevance.get(candidate)! - (1 - lambda) * maxSimilarityToSelected;

      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}
