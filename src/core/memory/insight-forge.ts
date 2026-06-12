/**
 * @file insight-forge.ts
 * @description InsightForge — query decomposition + parallel hybrid search with
 * Reciprocal Rank Fusion (RRF) merging for SUDO-AI v4.
 *
 * Pipeline:
 *   1. Decompose the user query into N sub-questions (via decomposeQueryFn)
 *   2. Run hybridSearchFn for ALL sub-questions in parallel (Promise.all)
 *   3. Merge results with RRF: score = Σ 1/(k + rank) across all result sets
 *   4. Return top finalMaxResults unique results sorted by RRF score
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SubQuestion {
  question: string;
  intent: 'factual' | 'contextual' | 'procedural' | 'temporal' | 'relational';
}

export interface ForgeResult {
  originalQuery:  string;
  subQuestions:   SubQuestion[];
  results:        Array<{ subQuestion: string; hits: any[] }>;
  merged:         any[];
  forgeMs:        number;
}

export interface ForgeOptions {
  /** Maximum number of sub-questions to generate (default: 5) */
  maxSubQuestions?: number;
  /** Maximum results per sub-question search (default: 8) */
  maxResultsPerSub?: number;
  /** Final number of merged results to return (default: 10) */
  finalMaxResults?: number;
  /** RRF k parameter — higher = less steep rank penalty (default: 60) */
  rrfK?: number;
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/**
 * Merge multiple ranked result sets using Reciprocal Rank Fusion.
 *
 * For each unique item (identified by idKey) that appears in any result set:
 *   rrfScore = Σ  1 / (k + rank)   for each set in which it appears
 *              (rank is 0-based)
 *
 * Items are returned sorted descending by rrfScore (best first).
 * The first occurrence of each item (from the highest-scoring set) is used as
 * the representative object; an `_rrfScore` property is added for transparency.
 *
 * @param resultSets - Array of ranked result arrays (best first within each set)
 * @param idKey      - Property name used to identify unique items (default: 'id')
 * @param k          - RRF k constant (default: 60)
 */
export function reciprocalRankFusion(
  resultSets: any[][],
  idKey: string = 'id',
  k: number = 60,
): any[] {
  const scoreMap = new Map<string | number, number>();
  const itemMap  = new Map<string | number, any>();

  for (const resultSet of resultSets) {
    for (let rank = 0; rank < resultSet.length; rank++) {
      const item = resultSet[rank]!;
      const id   = item[idKey];
      if (id === undefined || id === null) continue;

      const contribution = 1 / (k + rank);
      scoreMap.set(id, (scoreMap.get(id) ?? 0) + contribution);

      // Keep the first seen copy of the item (from best-ranked set appearance)
      if (!itemMap.has(id)) {
        itemMap.set(id, item);
      }
    }
  }

  // Sort by RRF score descending and attach score to each item
  return Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...itemMap.get(id), _rrfScore: score }));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Decompose a query into sub-questions, search in parallel, and merge with RRF.
 *
 * @param hybridSearchFn   - Async function that runs hybrid search for a single query
 * @param decomposeQueryFn - Async function that breaks a query into SubQuestions
 * @param query            - The original user query
 * @param options          - Optional tuning parameters
 */
export async function forgeInsights(
  hybridSearchFn:   (query: string, limit?: number) => Promise<any[]>,
  decomposeQueryFn: (query: string, maxSubs: number) => Promise<SubQuestion[]>,
  query:            string,
  options:          ForgeOptions = {},
): Promise<ForgeResult> {
  const {
    maxSubQuestions  = 5,
    maxResultsPerSub = 8,
    finalMaxResults  = 10,
    rrfK             = 60,
  } = options;

  const startMs = Date.now();

  // -------------------------------------------------------------------------
  // Step 1: Decompose query into sub-questions
  // -------------------------------------------------------------------------
  let subQuestions: SubQuestion[];

  try {
    subQuestions = await decomposeQueryFn(query, maxSubQuestions);
    if (!subQuestions || subQuestions.length === 0) {
      subQuestions = [{ question: query, intent: 'factual' }];
    }
  } catch {
    // Graceful fallback: treat the original query as a single factual sub-question
    subQuestions = [{ question: query, intent: 'factual' }];
  }

  // -------------------------------------------------------------------------
  // Step 2: Search all sub-questions in parallel
  // -------------------------------------------------------------------------
  const searchPromises = subQuestions.map((sq) =>
    hybridSearchFn(sq.question, maxResultsPerSub).catch(() => []),
  );

  const perSubResults: any[][] = await Promise.all(searchPromises);

  // Build the per-sub-question results array for the ForgeResult
  const results: ForgeResult['results'] = subQuestions.map((sq, i) => ({
    subQuestion: sq.question,
    hits:        perSubResults[i] ?? [],
  }));

  // -------------------------------------------------------------------------
  // Step 3: Merge with RRF
  // -------------------------------------------------------------------------
  const merged = reciprocalRankFusion(perSubResults, 'id', rrfK)
    .slice(0, finalMaxResults);

  return {
    originalQuery: query,
    subQuestions,
    results,
    merged,
    forgeMs: Date.now() - startMs,
  };
}
