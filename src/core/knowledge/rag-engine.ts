/**
 * @file rag-engine.ts
 * @description Retrieval-Augmented Generation engine for SUDO-AI v3.
 *
 * Wraps the existing hybrid-search (BM25 + optional vector) infrastructure
 * and formats retrieved chunks into a context block suitable for injection
 * into the system prompt's memoryContext slot.
 *
 * Design goals:
 *  - Zero circular imports: uses duck-typed RAGDbLike instead of importing MindDB
 *  - Fully graceful: every failure path returns '' rather than throwing
 *  - Delegates all search logic to hybridSearch (BM25 + sqlite-vec when available)
 */

import { createLogger } from '../shared/logger.js';
import { hybridSearch } from '../memory/hybrid-search.js';
import type { MindDB } from '../memory/db.js';
import type { EmbeddingService } from '../memory/embeddings.js';

const log = createLogger('knowledge:rag');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Duck-typed subset of MindDB required by RAGEngine.
 * Avoids a hard import cycle while remaining type-safe.
 */
export interface RAGDbLike {
  readonly db: import('better-sqlite3').Database;
  readonly vecLoaded: boolean;
}

/**
 * Duck-typed subset of KnowledgeGraph required by RAGEngine.
 * Uses the actual method name from KnowledgeGraph (findNodes).
 * Avoids a hard import cycle while remaining type-safe.
 */
export interface RAGKnowledgeGraphLike {
  findNodes(query: string, limit?: number): Array<{ title: string; content: string; type: string }>;
}

/**
 * Duck-typed subset of EmbeddingService required by RAGEngine.
 * Allows RAGEngine to be constructed without a real embedding service
 * (it will degrade gracefully to BM25-only in that case).
 */
export interface RAGEmbeddingsLike {
  readonly isAvailable: boolean;
  embed(text: string): Promise<Float32Array | null>;
}

// Minimal no-op embedding service used when none is provided.
const NULL_EMBEDDINGS: RAGEmbeddingsLike = {
  isAvailable: false,
  embed: async () => null,
};

// ---------------------------------------------------------------------------
// RAGEngine
// ---------------------------------------------------------------------------

/**
 * Retrieval-Augmented Generation context provider.
 *
 * Usage:
 * ```ts
 * const rag = new RAGEngine(mindDb);
 * const ctx = await rag.retrieveContext('how do I monetise YouTube Shorts?');
 * // ctx → markdown string with ## Relevant Memory / ## Relevant Insights sections
 * ```
 */
export class RAGEngine {
  private readonly mindDb: RAGDbLike;
  private readonly embeddings: RAGEmbeddingsLike;
  private knowledgeGraph: RAGKnowledgeGraphLike | null = null;

  /**
   * @param mindDb     - Open MindDB instance (or any RAGDbLike duck-type).
   * @param embeddings - Optional EmbeddingService; falls back to BM25-only when absent.
   */
  constructor(mindDb: RAGDbLike, embeddings?: RAGEmbeddingsLike) {
    this.mindDb = mindDb;
    this.embeddings = embeddings ?? NULL_EMBEDDINGS;
    log.info({ vecLoaded: mindDb.vecLoaded, embeddingsAvailable: this.embeddings.isAvailable }, 'RAG engine initialized');
  }

  /**
   * Attach a KnowledgeGraph to enrich context retrieval with graph-based results.
   * Accepts any duck-typed object implementing RAGKnowledgeGraphLike.
   *
   * @param kg - KnowledgeGraph instance (or any duck-type with findNodes).
   */
  setKnowledgeGraph(kg: RAGKnowledgeGraphLike): void {
    this.knowledgeGraph = kg;
    log.info('KnowledgeGraph connected to RAG engine');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Retrieve relevant context for a user query.
   *
   * Internally calls hybridSearch (BM25 + vector when available), then formats
   * results into a compact markdown string.
   *
   * @param query     - The user query to search against.
   * @param maxChunks - Maximum number of memory chunks to return (default: 5).
   * @returns         - Markdown context string, or '' when nothing useful is found.
   */
  async retrieveContext(query: string, maxChunks = 5): Promise<string> {
    if (!query || typeof query !== 'string' || query.trim().length < 5) {
      return '';
    }

    try {
      const results = await hybridSearch(
        this.mindDb as unknown as MindDB,
        this.embeddings as unknown as EmbeddingService,
        {
          query: query.trim(),
          maxResults: maxChunks,
          minScore: 0.2,
          temporalDecay: true,
          halfLifeDays: 30,
          mmr: true,
          mmrLambda: 0.7,
        },
      );

      if (results.length === 0) {
        log.debug({ queryLen: query.length }, 'RAG: no relevant chunks found');
        return '';
      }

      const lines: string[] = ['## Relevant Memory'];

      for (const r of results) {
        const preview = r.chunk.text.trim().substring(0, 220).replace(/\n+/g, ' ');
        const source = r.chunk.source ?? 'memory';
        const score = r.score.toFixed(2);
        lines.push(`- [${source} | score:${score}] ${preview}`);
      }

      // Append related knowledge graph nodes when available.
      if (this.knowledgeGraph !== null) {
        try {
          const kgNodes = this.knowledgeGraph.findNodes(query.trim(), 3);
          if (kgNodes.length > 0) {
            lines.push('\n## Related Knowledge');
            for (const node of kgNodes) {
              const preview = node.content.trim().substring(0, 200).replace(/\n+/g, ' ');
              lines.push(`- [${node.type}] **${node.title}**: ${preview}`);
            }
          }
        } catch (kgErr) {
          log.debug({ err: String(kgErr) }, 'KnowledgeGraph search error — skipping knowledge enrichment');
        }
      }

      const context = lines.join('\n');
      log.debug(
        { queryLen: query.length, chunks: results.length, contextLen: context.length },
        'RAG context retrieved',
      );
      return context;

    } catch (err) {
      // Never let RAG failures propagate — log and return empty.
      log.debug({ err: String(err) }, 'RAG retrieval error — continuing without context');
      return '';
    }
  }
}
