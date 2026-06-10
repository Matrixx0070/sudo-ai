/**
 * @file types.ts
 * @description Shared TypeScript types for the SUDO-AI memory subsystem.
 * All other memory modules import from here — never define types inline elsewhere.
 */

/**
 * A single unit of stored memory. Chunks are content-addressed via SHA-256 hash
 * so identical text is never stored twice regardless of source.
 */
export interface MemoryChunk {
  /** Auto-incremented primary key */
  id: number;
  /** Raw text content of the chunk */
  text: string;
  /**
   * Logical path the chunk belongs to, e.g. "memory/2026-03-26.md"
   * or "file:<project-root>/src/core/brain/index.ts".
   */
  path: string;
  /** Origin category of this chunk */
  source: 'conversation' | 'file' | 'tool' | 'learning';
  /** First line of the source file this chunk was extracted from (1-based, optional) */
  startLine?: number;
  /** Last line of the source file this chunk was extracted from (1-based, optional) */
  endLine?: number;
  /** SHA-256 of `text` — used for deduplication; unique-constrained in DB */
  hash: string;
  /** Embedding model used to generate the vector (null when no embedding stored) */
  model?: string;
  /**
   * Evergreen chunks are excluded from temporal decay scoring.
   * Use for permanent facts: project name, API keys path, user preferences, etc.
   */
  isEvergreen: boolean;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-update timestamp */
  updatedAt: string;
}

/**
 * A single item returned by a hybrid search query.
 */
export interface SearchResult {
  /** The matching memory chunk */
  chunk: MemoryChunk;
  /**
   * Normalized relevance score in [0, 1].
   * Higher is more relevant. Used for MMR re-ranking.
   */
  score: number;
  /** Which search path produced this result */
  matchType: 'vector' | 'bm25' | 'hybrid';
}

/**
 * Options for a hybrid search operation.
 */
export interface SearchOptions {
  /** Natural-language query string */
  query: string;
  /** Maximum results to return (default: 6) */
  maxResults?: number;
  /** Minimum score threshold — results below this are discarded (default: 0.35) */
  minScore?: number;
  /** Weight given to vector similarity in hybrid merge (default: 0.7) */
  vectorWeight?: number;
  /** Weight given to BM25 text relevance in hybrid merge (default: 0.3) */
  textWeight?: number;
  /**
   * When true, older non-evergreen chunks are penalised using exponential decay
   * (default: false).
   */
  temporalDecay?: boolean;
  /** Half-life for temporal decay in days (default: 30) */
  halfLifeDays?: number;
  /**
   * When true, apply Maximal Marginal Relevance re-ranking for result diversity
   * (default: false).
   */
  mmr?: boolean;
  /** MMR lambda — 1.0 = pure relevance, 0.0 = pure diversity (default: 0.7) */
  mmrLambda?: number;
  /** Only return chunks whose path starts with this prefix */
  pathFilter?: string;
}

/**
 * A cached embedding entry stored in `embedding_cache`.
 * Avoids redundant API calls for identical text across sessions.
 */
export interface EmbeddingCache {
  /** SHA-256 of the source text — matches chunks.hash */
  hash: string;
  /** Raw 1536-dimension vector */
  embedding: Float32Array;
  /** Model identifier, e.g. "text-embedding-3-small" */
  model: string;
  /** ISO-8601 timestamp of when this entry was cached */
  createdAt: string;
}
