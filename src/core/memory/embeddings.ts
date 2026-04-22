/**
 * @file embeddings.ts
 * @description EmbeddingService — generates and caches OpenAI text embeddings.
 *
 * Design decisions:
 *  - Uses raw fetch() rather than the OpenAI SDK to keep the memory module
 *    light and avoid circular imports with the AI-SDK layer.
 *  - Embeddings are cached in embedding_cache by SHA-256 hash of the input
 *    text, so identical text never hits the API twice.
 *  - If OPENAI_API_KEY is not set, embed() returns null and callers degrade
 *    to BM25-only search gracefully.
 */

import { createHash } from 'node:crypto';
import type { MindDB } from './db.js';

/** Default model — 1536 dimensions, cheap and accurate */
const DEFAULT_MODEL = 'text-embedding-3-small';

/** OpenAI embeddings endpoint */
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/** Maximum texts per batch request (OpenAI allows up to 2048, we use a safe limit) */
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// EmbeddingService
// ---------------------------------------------------------------------------

/**
 * Generates vector embeddings via the OpenAI API with transparent local caching.
 *
 * When no API key is configured, all methods return null/nulls so callers
 * can degrade gracefully to text-only search.
 */
export class EmbeddingService {
  private readonly db: MindDB;
  private readonly model: string;
  private readonly apiKey: string | null;

  /**
   * @param db    - MindDB instance used for embedding_cache persistence.
   * @param model - Embedding model identifier (default: text-embedding-3-small).
   */
  constructor(db: MindDB, model = DEFAULT_MODEL) {
    this.db    = db;
    this.model = model;
    this.apiKey = process.env['OPENAI_API_KEY'] ?? null;

    if (!this.apiKey) {
      console.warn('[EmbeddingService] OPENAI_API_KEY not set — running in BM25-only mode');
    }
  }

  /** True when an API key is available and embedding calls can succeed */
  get isAvailable(): boolean {
    return this.apiKey !== null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate (or retrieve from cache) the embedding for a single string.
   *
   * @param text - Input text to embed.
   * @returns A 1536-dimension Float32Array, or null if no API key is set.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.apiKey) return null;

    const hash = this._sha256(text);

    // Check cache first (synchronous — cheaper than any async path)
    const cached = this._getCached(hash);
    if (cached) return cached;

    // Fetch from API
    const vectors = await this._fetchEmbeddings([text]);
    if (vectors.length === 0) return null;

    const embedding = vectors[0]!;
    this._putCached(hash, embedding);
    return embedding;
  }

  /**
   * Generate embeddings for multiple texts in a single batched API call.
   * Results are cached individually so subsequent single-text calls are free.
   *
   * @param texts - Array of input strings.
   * @returns Array of Float32Array (same order as input). null entries mean
   *          the text was skipped due to an API failure.
   */
  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    if (!this.apiKey) return texts.map(() => null);
    if (texts.length === 0) return [];

    const results: (Float32Array | null)[] = new Array(texts.length).fill(null);
    const toFetch: Array<{ idx: number; text: string; hash: string }> = [];

    // Populate from cache where possible
    for (let i = 0; i < texts.length; i++) {
      const hash = this._sha256(texts[i]!);
      const cached = this._getCached(hash);
      if (cached) {
        results[i] = cached;
      } else {
        toFetch.push({ idx: i, text: texts[i]!, hash });
      }
    }

    if (toFetch.length === 0) return results;

    // Chunk into safe batch sizes
    for (let offset = 0; offset < toFetch.length; offset += BATCH_SIZE) {
      const chunk = toFetch.slice(offset, offset + BATCH_SIZE);
      const vectors = await this._fetchEmbeddings(chunk.map((c) => c.text));

      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j]!;
        const vec  = vectors[j] ?? null;
        results[item.idx] = vec;
        if (vec) {
          this._putCached(item.hash, vec);
        }
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Private: OpenAI API
  // -------------------------------------------------------------------------

  /**
   * Call the OpenAI embeddings endpoint for a batch of texts.
   * Returns vectors in the same order as the input array.
   */
  private async _fetchEmbeddings(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[EmbeddingService] API error ${response.status}: ${body}`);
    }

    const json = await response.json() as OpenAIEmbeddingResponse;

    // Sort by index to guarantee order matches input
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((item) => new Float32Array(item.embedding));
  }

  // -------------------------------------------------------------------------
  // Private: Cache (synchronous — better-sqlite3)
  // -------------------------------------------------------------------------

  private _getCached(hash: string): Float32Array | null {
    const row = this.db.db
      .prepare<{ hash: string; model: string }, { embedding: Buffer }>(
        'SELECT embedding FROM embedding_cache WHERE hash = :hash AND model = :model',
      )
      .get({ hash, model: this.model });

    if (!row) return null;

    // Stored as raw IEEE-754 float32 bytes in a BLOB
    return new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
  }

  private _putCached(hash: string, embedding: Float32Array): void {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (hash, embedding, model)
      VALUES (:hash, :embedding, :model)
    `).run({ hash, embedding: blob, model: this.model });
  }

  // -------------------------------------------------------------------------
  // Private: utilities
  // -------------------------------------------------------------------------

  private _sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }
}

// ---------------------------------------------------------------------------
// OpenAI response shape (minimal — we only parse what we use)
// ---------------------------------------------------------------------------

interface OpenAIEmbeddingResponse {
  data: Array<{
    index: number;
    embedding: number[];
  }>;
}
