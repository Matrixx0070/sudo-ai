/**
 * @file vector-backfill.ts
 * @description Corpus-side embedding backfill for the chunks ANN index.
 *
 * The `chunks` store is written synchronously (storeChunk + raw INSERTs in
 * auto-dream / saveInsight), so nothing ever embeds a stored chunk into the
 * `chunks_vec` (vec0) table that hybrid-search's vector path reads. Result:
 * `chunks_vec` stays empty and vector search silently degrades to BM25-only,
 * regardless of whether embeddings are available.
 *
 * This closes that gap with a bounded background pass: it finds active chunks
 * with no vector yet (excluding session-meta JSON, which isn't a recall target),
 * embeds them, and upserts `(chunk_id, embedding)` into the index. Run it on a
 * cron — it's idempotent and self-healing, and clears any backlog over a few
 * passes. Opt-in via SUDO_VECTOR_BACKFILL=1.
 *
 * The vec0 table is abstracted behind {@link ChunkVectorStore} so the
 * orchestration is unit-testable without the sqlite-vec extension loaded.
 */

import type { MindDB } from './db.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:vector-backfill');

/** Embedding dimension of text-embedding-3-small, matching chunks_vec FLOAT[1536]. */
const EXPECTED_DIM = 1536;

/** Whether corpus vector backfill is enabled (read per-call). */
export function isVectorBackfillEnabled(): boolean {
  return process.env['SUDO_VECTOR_BACKFILL'] === '1';
}

/** Minimal subset of EmbeddingService the backfill needs. */
export interface BackfillEmbedder {
  readonly isAvailable: boolean;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
}

/** The ANN index, abstracted so the backfill is testable without sqlite-vec. */
export interface ChunkVectorStore {
  /** Ids that already have a vector (so we skip them). */
  existingChunkIds(): Set<number>;
  /** Upsert one chunk's embedding. */
  put(chunkId: number, embedding: Float32Array): void;
}

export interface BackfillOptions {
  /** Max chunks embedded per run (bounds API cost + latency). Default 256. */
  maxPerRun?: number;
}

export interface BackfillResult {
  /** Active, embeddable chunks missing a vector at the start of this run. */
  pending: number;
  /** Vectors newly written this run. */
  embedded: number;
  /** Texts the embedder returned null/invalid for (skipped). */
  skipped: number;
}

/**
 * vec0-backed {@link ChunkVectorStore}. Only valid when sqlite-vec is loaded
 * (`db.vecLoaded`). Stores embeddings as raw IEEE-754 float32 bytes, the same
 * encoding hybrid-search and embedding_cache use.
 */
export class MindDBVectorStore implements ChunkVectorStore {
  constructor(private readonly raw: import('better-sqlite3').Database) {}

  existingChunkIds(): Set<number> {
    const rows = this.raw.prepare('SELECT chunk_id FROM chunks_vec').all() as Array<{ chunk_id: number }>;
    return new Set(rows.map((r) => r.chunk_id));
  }

  put(chunkId: number, embedding: Float32Array): void {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    // sqlite-vec rejects a plain JS number for the vec0 primary key ("Only
    // integers are allowed…") — it must be bound as a BigInt, positionally.
    this.raw
      .prepare('INSERT OR REPLACE INTO chunks_vec(chunk_id, embedding) VALUES (?, ?)')
      .run(BigInt(chunkId), blob);
  }
}

/**
 * Embed active chunks that have no vector yet and upsert them into the index.
 * No-op (returns zeros) when the embedder is unavailable. Session-meta JSON and
 * superseded chunks are excluded — they aren't recall targets. Never throws:
 * a per-chunk embed/store failure is logged and skipped.
 *
 * @returns counts of pending / embedded / skipped for this run.
 */
export async function backfillChunkVectors(
  db: MindDB,
  embedder: BackfillEmbedder,
  store: ChunkVectorStore,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const result: BackfillResult = { pending: 0, embedded: 0, skipped: 0 };
  if (!embedder.isAvailable) return result;

  const maxPerRun = options.maxPerRun && options.maxPerRun > 0 ? options.maxPerRun : 256;

  const existing = store.existingChunkIds();
  // Active, embeddable chunks (skip session-meta JSON + superseded rows),
  // newest-first so fresh memory gets indexed first.
  const rows = db.db
    .prepare(
      `SELECT id, text FROM chunks
       WHERE superseded_by IS NULL AND path NOT LIKE 'session:%:meta'
       ORDER BY id DESC`,
    )
    .all() as Array<{ id: number; text: string }>;

  const pending = rows.filter((r) => !existing.has(r.id));
  result.pending = pending.length;
  if (pending.length === 0) return result;

  const batch = pending.slice(0, maxPerRun);
  let vectors: (Float32Array | null)[];
  try {
    vectors = await embedder.embedBatch(batch.map((r) => r.text));
  } catch (err) {
    log.warn({ err: String(err) }, 'vector backfill: embedBatch failed — skipping run');
    return result;
  }

  for (let i = 0; i < batch.length; i++) {
    const vec = vectors[i];
    const id = batch[i]!.id;
    if (!vec || vec.length !== EXPECTED_DIM) {
      result.skipped++;
      continue;
    }
    try {
      store.put(id, vec);
      result.embedded++;
    } catch (err) {
      result.skipped++;
      log.warn({ chunkId: id, err: String(err) }, 'vector backfill: store.put failed — skipping chunk');
    }
  }

  log.info(
    { pending: result.pending, embedded: result.embedded, skipped: result.skipped, remaining: result.pending - result.embedded },
    'vector backfill pass complete',
  );
  return result;
}
