/**
 * @file hybrid-search.ts
 * @description Hybrid vector + BM25 search over the chunks table.
 *
 * Algorithm pipeline:
 *   1. Generate query embedding (if sqlite-vec loaded and API key available)
 *   2. Vector search: top N*4 candidates from chunks_vec via cosine distance
 *   3. BM25 search:  top N*4 candidates from chunks_fts via FTS5 rank
 *   4. Merge results with configurable vector/text weights
 *   5. Apply temporal decay to non-evergreen chunks (optional)
 *   6. Apply MMR re-ranking for diversity (optional)
 *   7. Filter by minScore, apply pathFilter, return top N
 *
 * If sqlite-vec is not loaded, only steps 3, 4 (BM25-only path), 5, 6, 7 run.
 */

import { createLogger } from '../shared/logger.js';
import type { MindDB } from './db.js';
import type { EmbeddingService } from './embeddings.js';
import type { MemoryChunk, SearchOptions, SearchResult } from './types.js';

const log = createLogger('memory:hybrid-search');

// ---------------------------------------------------------------------------
// Scoring helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Convert an FTS5 BM25 rank value to a normalised [0,1) relevance score.
 *
 * FTS5 returns negative rank values where more-negative = more relevant.
 * We convert to a positive score using a sigmoid-like transform that keeps
 * very-high-relevance items near 1.0 and irrelevant items near 0.
 *
 * @param rank - Raw FTS5 rank (typically negative, e.g. -5.3)
 */
export function bm25RankToScore(rank: number): number {
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  // Positive rank means no relevance (shouldn't happen in practice)
  return 1 / (1 + rank);
}

/**
 * Apply exponential temporal decay to a relevance score.
 * Evergreen chunks bypass this function (callers check isEvergreen first).
 *
 * Formula:  score' = score * e^(-λ * ageInDays)   where λ = ln2 / halfLifeDays
 *
 * @param score       - Original relevance score in [0,1]
 * @param ageInDays   - How many days old the chunk is
 * @param halfLifeDays - Age at which the score is halved (default: 30)
 */
export function applyTemporalDecay(
  score: number,
  ageInDays: number,
  halfLifeDays = 30,
): number {
  const lambda = Math.LN2 / halfLifeDays;
  return score * Math.exp(-lambda * ageInDays);
}

/**
 * Merge vector and BM25 result sets using a weighted reciprocal rank fusion
 * that respects explicit scores from both sources.
 *
 * For each unique chunk ID that appears in either list:
 *   finalScore = vectorWeight * vectorScore + textWeight * bm25Score
 *
 * If a chunk only appears in one list its other-side score is 0.
 *
 * @param vectorResults - Results from vector search with .score in [0,1]
 * @param bm25Results   - Results from BM25 search with .score in [0,1]
 * @param vectorWeight  - Blend weight for vector score (default: 0.7)
 * @param textWeight    - Blend weight for BM25 score (default: 0.3)
 */
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
    score: vectorWeight * vecScore + textWeight * bm25Score,
    matchType: 'hybrid' as const,
  }));
}

/**
 * Maximal Marginal Relevance re-ranking.
 *
 * Iteratively selects the next result that maximises:
 *   lambda * similarity(result, query) - (1-lambda) * max_similarity(result, selected)
 *
 * Because we don't store full embedding vectors in the result set, we use
 * normalised relevance scores as a proxy for query similarity and a
 * score-overlap heuristic for inter-result similarity.
 *
 * @param results - Sorted (highest score first) result set
 * @param lambda  - 1.0 = pure relevance, 0.0 = pure diversity (default: 0.7)
 */
export function mmrRerank(results: SearchResult[], lambda = 0.7): SearchResult[] {
  if (results.length <= 1) return results;

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
        lambda * candidate.score - (1 - lambda) * maxSimilarityToSelected;

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

// ---------------------------------------------------------------------------
// Vector search helpers
// ---------------------------------------------------------------------------

interface VecRow {
  chunk_id: number;
  distance: number;
}

interface FtsRow {
  rowid: number;
  rank: number;
}

interface ChunkRow {
  id: number;
  text: string;
  path: string;
  source: 'conversation' | 'file' | 'tool' | 'learning';
  start_line: number | null;
  end_line: number | null;
  hash: string;
  model: string | null;
  is_evergreen: number;
  superseded_by: number | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToChunk(row: ChunkRow): MemoryChunk {
  return {
    id:          row.id,
    text:        row.text,
    path:        row.path,
    source:      row.source,
    startLine:   row.start_line  ?? undefined,
    endLine:     row.end_line    ?? undefined,
    hash:        row.hash,
    model:       row.model       ?? undefined,
    isEvergreen: row.is_evergreen === 1,
    supersededBy: row.superseded_by ?? undefined,
    supersededAt: row.superseded_at ?? undefined,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

function chunkAgeInDays(chunk: MemoryChunk): number {
  const created = new Date(chunk.createdAt).getTime();
  const now = Date.now();
  return Math.max(0, (now - created) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Execute a hybrid search over the SUDO-AI memory store.
 *
 * When sqlite-vec is loaded and an OpenAI API key is available, uses both
 * vector similarity and BM25 text matching combined with configurable weights.
 * Falls back transparently to BM25-only when either capability is missing.
 *
 * @param db         - Open MindDB instance
 * @param embeddings - EmbeddingService instance
 * @param options    - Search configuration (see SearchOptions type)
 * @returns          - Ranked array of SearchResult, best first
 */
export async function hybridSearch(
  db: MindDB,
  embeddings: EmbeddingService,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const {
    query,
    maxResults    = 6,
    minScore      = 0.35,
    vectorWeight  = 0.7,
    textWeight    = 0.3,
    temporalDecay = false,
    halfLifeDays  = 30,
    mmr           = false,
    mmrLambda     = 0.7,
    pathFilter,
  } = options;

  const candidateN = maxResults * 4;
  const useVec     = db.vecLoaded && embeddings.isAvailable;

  let vectorResults: SearchResult[] = [];
  let bm25Results: SearchResult[]   = [];

  // -------------------------------------------------------------------------
  // Step 1: Vector search (conditional)
  // -------------------------------------------------------------------------

  if (useVec) {
    // Query-time embedding resilience (B5.2): a terminal embed() failure (e.g.
    // the provider stays down after the #467 backoff is exhausted) must NOT sink
    // the whole search — degrade to the BM25 path so the caller still gets text
    // matches instead of an exception (and an empty RAG context). Default-ON;
    // SUDO_EMBED_QUERY_DEGRADE=0 restores the old propagate-the-throw behavior.
    const degradeOnEmbedFailure = process.env['SUDO_EMBED_QUERY_DEGRADE'] !== '0';
    let queryVec: Float32Array | null = null;
    try {
      queryVec = await embeddings.embed(query);
    } catch (err) {
      if (!degradeOnEmbedFailure) throw err;
      log.debug({ err: String(err) }, 'hybrid-search: query embedding failed — degrading to BM25-only');
      queryVec = null;
    }
    if (queryVec) {
      // sqlite-vec KNN query — returns cosine distance (0=identical, 2=opposite)
      const vecRows = db.db.prepare<{ embedding: Buffer; k: number }, VecRow>(`
        SELECT chunk_id, distance
        FROM chunks_vec
        WHERE embedding MATCH :embedding
        ORDER BY distance
        LIMIT :k
      `).all({
        embedding: Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
        k: candidateN,
      });

      // Fetch full chunk data for each result
      for (const vr of vecRows) {
        const row = db.db
          .prepare<{ id: number }, ChunkRow>('SELECT * FROM chunks WHERE id = :id')
          .get({ id: vr.chunk_id });
        if (!row) continue;
        if (row.superseded_by != null) continue; // retired by contradiction resolution
        if (pathFilter && !row.path.startsWith(pathFilter)) continue;

        // Convert cosine distance [0,2] → similarity [0,1]
        const score = Math.max(0, 1 - vr.distance / 2);
        vectorResults.push({ chunk: rowToChunk(row), score, matchType: 'vector' });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: BM25 full-text search
  // -------------------------------------------------------------------------

  const ftsRows = db.db.prepare<{ query: string; k: number }, FtsRow>(`
    SELECT rowid, rank
    FROM chunks_fts
    WHERE chunks_fts MATCH :query
    ORDER BY rank
    LIMIT :k
  `).all({ query: sanitiseFtsQuery(query), k: candidateN });

  for (const fr of ftsRows) {
    const row = db.db
      .prepare<{ id: number }, ChunkRow>('SELECT * FROM chunks WHERE id = :id')
      .get({ id: fr.rowid });
    if (!row) continue;
    if (row.superseded_by != null) continue; // retired by contradiction resolution
    if (pathFilter && !row.path.startsWith(pathFilter)) continue;

    bm25Results.push({
      chunk: rowToChunk(row),
      score: bm25RankToScore(fr.rank),
      matchType: 'bm25',
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: Merge
  // -------------------------------------------------------------------------

  let results: SearchResult[];

  if (vectorResults.length > 0 && bm25Results.length > 0) {
    results = mergeHybridResults(vectorResults, bm25Results, vectorWeight, textWeight);
  } else if (vectorResults.length > 0) {
    // Vector-only fallback — scale by weight so the score scale (and thus the
    // downstream minScore gate) matches the hybrid path's single-source scores.
    results = vectorResults.map((r) => ({ ...r, score: vectorWeight * r.score }));
  } else {
    // BM25-only fallback — scale by weight (matches hybrid single-source scale)
    // and normalise match type.
    results = bm25Results.map((r) => ({ ...r, score: textWeight * r.score, matchType: 'bm25' as const }));
  }

  // -------------------------------------------------------------------------
  // Step 4: Temporal decay
  // -------------------------------------------------------------------------

  if (temporalDecay) {
    results = results.map((r) => {
      if (r.chunk.isEvergreen) return r;
      const age = chunkAgeInDays(r.chunk);
      return { ...r, score: applyTemporalDecay(r.score, age, halfLifeDays) };
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Score filter + sort
  // -------------------------------------------------------------------------

  results = results
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);

  // -------------------------------------------------------------------------
  // Step 6: MMR diversity re-ranking
  // -------------------------------------------------------------------------

  if (mmr && results.length > 1) {
    results = mmrRerank(results, mmrLambda);
  }

  // -------------------------------------------------------------------------
  // Step 7: Trim to maxResults
  // -------------------------------------------------------------------------

  return results.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Sanitise a natural-language query string for FTS5 MATCH syntax.
 * FTS5 uses a subset of special characters; unbalanced quotes or operators
 * will throw. We escape double-quotes and wrap the whole query in phrase
 * mode to avoid operator interpretation.
 */
export function sanitiseFtsQuery(raw: string): string {
  // Remove characters that break FTS5 MATCH: parentheses, unbalanced quotes
  const cleaned = raw
    .replace(/[()]/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Wrap each token as a prefix term so partial words match
  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length === 0) return '""';

  // Use OR between tokens for broad recall; prefix * for partial matching
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}
