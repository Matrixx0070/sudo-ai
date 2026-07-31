/**
 * @file hybrid-search.ts
 * @description Hybrid vector + BM25 search over the chunks table.
 *
 * Algorithm pipeline:
 *   1. Generate query embedding (if sqlite-vec loaded and API key available)
 *   2. Vector search: top N*4 candidates from chunks_vec via cosine distance
 *   3. BM25 search:  top N*4 candidates from chunks_fts via FTS5 rank
 *   4. Merge results — weighted RRF sets the ORDER, calibrated score keeps
 *      the minScore gate (see hybrid-fusion.ts)
 *   5. Apply temporal decay to non-evergreen chunks (optional)
 *   6. Apply MMR re-ranking for diversity (optional)
 *   7. Filter by minScore, apply pathFilter, return top N
 *
 * If sqlite-vec is not loaded, only steps 3, 4 (BM25-only path), 5, 6, 7 run.
 */

import { createLogger } from '../shared/logger.js';
import type { MindDB } from './db.js';
import type { EmbeddingService } from './embeddings.js';
import { LocalEmbeddingProvider } from './local-embeddings.js';
export { mergeHybridResults } from './hybrid-fusion.js';
export { mmrRerank } from './mmr-rerank.js';
import { mmrRerank } from './mmr-rerank.js';
import { mergeHybridResults } from './hybrid-fusion.js';
import type { MemoryChunk, SearchOptions, SearchResult } from './types.js';

const log = createLogger('memory:hybrid-search');

/**
 * Minimal embedder shape for the local fallback (satisfied by
 * {@link LocalEmbeddingProvider}). Injectable so the routing is unit-testable
 * without loading the ONNX model.
 */
export interface LocalEmbedderLike {
  readonly isAvailable: boolean;
  embed(text: string): Promise<Float32Array | null>;
}

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

/** Session-metadata plumbing rows — see the exclusion note in Step 2. */
function isSessionMetaPath(path: string): boolean {
  return path.startsWith('session:') && path.endsWith(':meta');
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
  localEmbedder?: LocalEmbedderLike,
): Promise<SearchResult[]> {
  const {
    query: rawQuery,
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

  // 2026-07-29 wedge guard: a session-fork summary once arrived here as a
  // 712KB "query". Both retrieval lanes are bounded-signal — the embedder
  // truncates at its model context and BM25 gains nothing past a few dozen
  // terms — but the FTS5 OR-of-prefix-terms expression built from unbounded
  // text is SUPERLINEAR in SQLite (measured 6.5s at 150KB, minutes at 712KB)
  // and runs synchronously on the event loop. Clamp once at the chokepoint.
  const query = rawQuery.length > MAX_QUERY_CHARS ? rawQuery.slice(0, MAX_QUERY_CHARS) : rawQuery;

  const candidateN = maxResults * 4;

  let vectorResults: SearchResult[] = [];
  let bm25Results: SearchResult[]   = [];

  // -------------------------------------------------------------------------
  // Step 1: Vector search (conditional)
  //
  // Three embedding spaces, NEVER mixed (cross-model vectors aren't comparable):
  //   • primary EmbeddingService space → chunks_vec_768 (local Ollama, 768) or
  //     chunks_vec (OpenAI 1536) — selected by the service's dims
  //   • MiniLM 384 → chunks_vec_local (fallback, when the primary is down)
  // Prefer the primary; use the MiniLM space only when the primary yields no
  // query vector (unavailable / embed failed). Neither usable → BM25-only.
  // -------------------------------------------------------------------------

  const primaryUsable = db.vecLoaded && embeddings.isAvailable;
  // The primary service's table follows its embedding width (768 = local
  // Ollama space; anything else = the legacy OpenAI 1536 space).
  const primaryTable = embeddings.dims === 768 ? ('chunks_vec_768' as const) : ('chunks_vec' as const);
  const openaiUsable = primaryUsable;
  const local        = localEmbedder ?? new LocalEmbeddingProvider();
  const localUsable  = db.vecLoaded && local.isAvailable;

  if (openaiUsable || localUsable) {
    // Query-time embedding resilience (B5.2): a terminal embed() failure must
    // NOT sink the search — fall through to the local space, then BM25, so the
    // caller still gets results instead of an exception (and an empty RAG
    // context). Default-ON; SUDO_EMBED_QUERY_DEGRADE=0 restores propagate-throw
    // for the OpenAI leg.
    const degradeOnEmbedFailure = process.env['SUDO_EMBED_QUERY_DEGRADE'] !== '0';
    let queryVec: Float32Array | null = null;
    let vecTable: 'chunks_vec' | 'chunks_vec_768' | 'chunks_vec_local' = primaryTable;

    // Primary: the EmbeddingService's own space.
    if (openaiUsable) {
      try {
        queryVec = await embeddings.embed(query);
      } catch (err) {
        if (!degradeOnEmbedFailure) throw err;
        log.debug({ err: String(err) }, 'hybrid-search: primary query embedding failed — trying local/BM25');
        queryVec = null;
      }
    }

    // Fallback: local space when OpenAI produced no vector (down / unavailable).
    if (!queryVec && localUsable) {
      try {
        const lv = await local.embed(query);
        if (lv) {
          queryVec = lv;
          vecTable = 'chunks_vec_local';
          log.debug('hybrid-search: using MiniLM fallback space (primary unavailable)');
        }
      } catch (err) {
        log.debug({ err: String(err) }, 'hybrid-search: local query embedding failed — degrading to BM25-only');
      }
    }

    if (queryVec) {
      // sqlite-vec KNN query — L2 (Euclidean) distance, ascending (0=identical).
      // vecTable is a whitelisted literal, never user input.
      const vecRows = db.db.prepare<{ embedding: Buffer; k: number }, VecRow>(`
        SELECT chunk_id, distance
        FROM ${vecTable}
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

        // vec0 returns L2 distance; for unit vectors L2²=2(1−cos), so cosine
        // similarity = 1 − d²/2 (RAG-2; was treating L2 as cosine → score deflation).
        const score = Math.max(0, Math.min(1, 1 - (vr.distance * vr.distance) / 2));
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
    // Session-metadata JSON blobs (session:<id>:meta) are plumbing read via
    // direct path lookups (SessionManager / admin handlers), never meaningful
    // semantic-search answers — vector-backfill already excludes them. Left in,
    // they are ~27% of the FTS corpus and burn BM25 candidate slots on JSON
    // key/id noise.
    if (isSessionMetaPath(row.path)) continue;
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
    // Vector-only fallback — pass the raw [0,1] score through. There is no second
    // source to blend with, so down-weighting by vectorWeight only pushes results
    // toward (and below) the minScore gate for no reason (RAG-1).
    results = vectorResults.map((r) => ({ ...r, score: r.score }));
  } else {
    // BM25-only fallback — raw score, NOT textWeight*score. The latter caps at
    // ≤0.3 (bm25 ≤ 1.0) which is below the default minScore 0.35, so BM25-only
    // mode (no sqlite-vec / embeddings down) returned nothing at all (RAG-1).
    results = bm25Results.map((r) => ({ ...r, score: r.score, matchType: 'bm25' as const }));
  }

  // -------------------------------------------------------------------------
  // Step 4: Temporal decay
  // -------------------------------------------------------------------------

  if (temporalDecay) {
    results = results.map((r) => {
      if (r.chunk.isEvergreen) return r;
      const age = chunkAgeInDays(r.chunk);
      // Decay is a pure multiplier — apply it to BOTH keys so age demotes a
      // chunk in the RRF ordering exactly as it does in the score gate.
      const factor = applyTemporalDecay(1, age, halfLifeDays);
      return {
        ...r,
        score: r.score * factor,
        ...(r.rankScore !== undefined ? { rankScore: r.rankScore * factor } : {}),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Step 4.5: Epistemic ranking rider — provenance-aware multiplier supplied
  // by the caller (trustWeight × validationState; see memory/epistemic-score).
  // Neutral when absent; a throwing adjuster must not break retrieval.
  // -------------------------------------------------------------------------

  const epistemicAdjuster = options.epistemicAdjuster;
  if (epistemicAdjuster) {
    results = results.map((r) => {
      try {
        const adjusted = epistemicAdjuster(r.chunk.path, r.score);
        // Propagate the adjuster's relative effect onto the RRF ordering key,
        // so provenance demotes/promotes rank as well as the gate score.
        const factor = r.score > 0 ? adjusted / r.score : 1;
        return {
          ...r,
          score: adjusted,
          ...(r.rankScore !== undefined ? { rankScore: r.rankScore * factor } : {}),
        };
      } catch {
        return r;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Score filter + sort
  // -------------------------------------------------------------------------

  // Gate on the calibrated score (absolute quality — minScore semantics are
  // unchanged for every caller), but ORDER by the RRF key when present: the
  // raw scores of the two engines are incommensurable, so sorting by them
  // structurally favours BM25 (see hybrid-fusion.ts).
  results = results
    .filter((r) => r.score >= minScore)
    .sort((a, b) => (b.rankScore ?? b.score) - (a.rankScore ?? a.score));

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
 * Hard cap on the query text hybridSearch will consider. Retrieval signal is
 * bounded (embedding model context; BM25 term saturation), so anything past
 * this is pure cost — including the 2026-07-29 event-loop wedge where a 712KB
 * fork-summary prompt became a ~110k-term FTS5 query that pinned the daemon
 * at 100% CPU for 9+ minutes.
 */
export const MAX_QUERY_CHARS = 2000;

/**
 * Max unique prefix terms in the generated FTS5 MATCH expression. Each term is
 * a separate index scan; relevance saturates long before cost does.
 */
export const MAX_FTS_TOKENS = 64;

/**
 * Sanitise a natural-language query string for FTS5 MATCH syntax.
 * FTS5 uses a subset of special characters; unbalanced quotes or operators
 * will throw. We escape double-quotes and wrap the whole query in phrase
 * mode to avoid operator interpretation.
 *
 * The output is BOUNDED: tokens are deduplicated and capped at
 * {@link MAX_FTS_TOKENS} — each OR'd prefix term is a separate FTS5 index
 * scan, and an unbounded expression is superlinear in query size (the
 * 2026-07-29 wedge).
 */
export function sanitiseFtsQuery(raw: string): string {
  // Remove characters that break FTS5 MATCH: parentheses, unbalanced quotes
  const cleaned = raw
    .replace(/[()]/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Wrap each token as a prefix term so partial words match; dedupe (repeats
  // add scans, not relevance) and cap the term count.
  const tokens = [...new Set(cleaned.split(' ').filter(Boolean))].slice(0, MAX_FTS_TOKENS);
  if (tokens.length === 0) return '""';

  // Use OR between tokens for broad recall; prefix * for partial matching
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}
