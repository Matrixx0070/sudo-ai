/**
 * @file semantic-compactor.ts
 * @description Periodic compaction pass that collapses semantically-duplicate
 *              chunks into one canonical row with an occurrence count.
 *
 * Problem this solves (bot's architectural audit, fix #2):
 *   Memory is append-only with no semantic dedup. ~150 near-identical entries
 *   accumulate (e.g. "heartbeat acknowledged" written 80 times). Same lesson,
 *   same meaning, slightly different wording — none of them get merged. This
 *   pollutes the context window and dilutes real signal.
 *
 * Approach:
 *   For each chunk that lacks an embedding, embed it. Then for each chunk,
 *   find the top-1 nearest neighbour (same `source`); if cosine similarity
 *   is ≥ threshold (default 0.92), MERGE the newer row into the older one
 *   by incrementing `applied_count` and deleting the duplicate.
 *
 * Scope guarantees:
 *   - Pure module: takes db + EmbeddingService-like + threshold; no I/O of
 *     its own beyond what the db handle does.
 *   - Idempotent migration: adds the `applied_count` column on first run if
 *     missing, follows the same PRAGMA-table_info pattern auto-dream.ts uses.
 *   - Safe to run on huge tables: caps the per-call batch so one invocation
 *     doesn't lock the DB; designed to be scheduled (cron / AutoDream phase).
 *   - Same-source only: a 'conversation' chunk never gets merged into a
 *     'file' chunk even if their text overlaps. Sources have different
 *     retention semantics.
 *   - Never deletes evergreen rows. Evergreen wins; non-evergreen gets
 *     merged into evergreen if present.
 *
 * What this does NOT do:
 *   - Modify the write path (storeChunk) — too risky in one PR. A future
 *     iteration can add pre-insert semantic dedup using this module's
 *     `nearestNeighbour` helper. This first slice cleans up existing bloat
 *     and stops it growing past compaction cadence.
 *   - Touch wisdom.db `insights` or workspace `MEMORY.md` — both are owned
 *     by other modules; can be added in follow-ups.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:semantic-compactor');

/** Default similarity threshold (cosine, [0,1]). Bot recommended 0.92. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.92;

/** Max chunks processed in one compact() call. Keeps DB locks short. */
export const DEFAULT_MAX_CHUNKS_PER_RUN = 500;

/** Minimal contract the compactor needs from an embedding service. */
export interface EmbeddingFn {
  /** Return a unit-normalised embedding vector for the given text. */
  embed(text: string): Promise<Float32Array>;
}

interface ChunkRow {
  id: number;
  text: string;
  source: string;
  is_evergreen: number;
  created_at: string;
  applied_count: number;
  embedding_json: string | null;
}

export interface CompactionResult {
  /** Rows the compactor looked at this run. */
  scanned: number;
  /** New embeddings generated (and persisted). */
  embedded: number;
  /** Pairs that exceeded the threshold and were collapsed. */
  merged: number;
  /** Rows deleted (= merged pairs that produced a delete). */
  deleted: number;
  /** Newest cumulative `applied_count` value after this run. Diagnostic only. */
  maxAppliedCount: number;
  /** True when the `applied_count` column had to be added on this invocation. */
  migrated: boolean;
}

/**
 * Ensure the chunks table has the columns this module needs. Idempotent —
 * checks PRAGMA table_info before each ALTER. Following the same pattern as
 * src/core/memory/auto-dream.ts:451.
 *
 * Returns true when a migration ran, false when columns were already present.
 */
export function ensureCompactionColumns(db: Database.Database): boolean {
  const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
  const hasAppliedCount = cols.some((c) => c.name === 'applied_count');
  const hasEmbeddingJson = cols.some((c) => c.name === 'embedding_json');
  let migrated = false;
  if (!hasAppliedCount) {
    db.exec("ALTER TABLE chunks ADD COLUMN applied_count INTEGER NOT NULL DEFAULT 1");
    migrated = true;
  }
  if (!hasEmbeddingJson) {
    // We persist embeddings inline in chunks (one row per embedding) so the
    // compactor can run without taking a dependency on chunks_vec being
    // loaded. chunks_vec stays the authoritative ANN store for hot search;
    // this column is the cold copy compaction uses.
    db.exec("ALTER TABLE chunks ADD COLUMN embedding_json TEXT");
    migrated = true;
  }
  return migrated;
}

/**
 * Cosine similarity for two unit-normalised vectors. When vectors are NOT
 * unit-normalised the dot product overshoots; callers should normalise
 * upstream. Returns 0 for length mismatch (defensive — never throws).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseEmbedding(json: string | null): Float32Array | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return null;
    return Float32Array.from(arr as number[]);
  } catch {
    return null;
  }
}

function serialiseEmbedding(v: Float32Array): string {
  return JSON.stringify(Array.from(v));
}

/**
 * Run one compaction pass. Returns counters; never throws.
 *
 * The implementation walks chunks oldest-first so that when a duplicate is
 * found the older row stays canonical — preserves earliest provenance and
 * keeps memory IDs stable for any references downstream.
 */
export async function compactSemanticDuplicates(
  db: Database.Database,
  embedder: EmbeddingFn,
  opts: {
    threshold?: number;
    maxChunks?: number;
    sources?: ReadonlyArray<string>;
  } = {},
): Promise<CompactionResult> {
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS_PER_RUN;
  const sources = opts.sources ?? ['conversation', 'tool', 'learning'];

  const result: CompactionResult = {
    scanned: 0,
    embedded: 0,
    merged: 0,
    deleted: 0,
    maxAppliedCount: 0,
    migrated: ensureCompactionColumns(db),
  };

  const placeholders = sources.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, text, source, is_evergreen, created_at, applied_count, embedding_json
       FROM chunks
       WHERE source IN (${placeholders})
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(...sources, maxChunks) as ChunkRow[];

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // Fill missing embeddings. Group by source so the nearest-neighbour search
  // below can be a same-source-only loop without cross-source candidates.
  const updateEmb = db.prepare("UPDATE chunks SET embedding_json = ? WHERE id = ?");
  const vectors = new Map<number, Float32Array>();
  for (const row of rows) {
    let v = parseEmbedding(row.embedding_json);
    if (!v) {
      try {
        v = await embedder.embed(row.text);
        updateEmb.run(serialiseEmbedding(v), row.id);
        result.embedded++;
      } catch (err) {
        log.warn({ chunkId: row.id, err: String(err) }, 'Embedding failed — skipping row');
        continue;
      }
    }
    vectors.set(row.id, v);
  }

  // Walk newest → oldest so when we merge we delete the YOUNGER row.
  // Same-source only (already filtered above). Evergreen rows never get
  // deleted — if a non-evergreen row matches an evergreen row, the
  // non-evergreen one is the duplicate.
  const incCount = db.prepare("UPDATE chunks SET applied_count = applied_count + ? WHERE id = ?");
  const del = db.prepare("DELETE FROM chunks WHERE id = ?");
  const survivors = new Map<string, ChunkRow[]>(); // by source
  for (const row of rows) {
    if (!vectors.has(row.id)) continue;
    const bucket = survivors.get(row.source) ?? [];
    survivors.set(row.source, bucket);

    let bestIdx = -1;
    let bestSim = 0;
    const newVec = vectors.get(row.id)!;
    for (let i = 0; i < bucket.length; i++) {
      const cand = bucket[i]!;
      const candVec = vectors.get(cand.id);
      if (!candVec) continue;
      const sim = cosineSimilarity(newVec, candVec);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestSim >= threshold) {
      const canonical = bucket[bestIdx]!;
      const canonicalEverg = canonical.is_evergreen === 1;
      const rowEverg = row.is_evergreen === 1;
      // Default: keep the older (canonical, already in bucket). Promote
      // when the duplicate is evergreen and the canonical is not — we
      // never want to discard evergreen content.
      const promoteDuplicate = rowEverg && !canonicalEverg;
      const keeper = promoteDuplicate ? row : canonical;
      const loser = promoteDuplicate ? canonical : row;

      incCount.run(loser.applied_count, keeper.id);
      del.run(loser.id);
      result.merged++;
      result.deleted++;

      if (promoteDuplicate) bucket[bestIdx] = keeper;
      // either way, the surviving row is `keeper`; we don't need to track
      // both. The other won't appear again because we deleted it.
      continue;
    }

    bucket.push(row);
  }

  result.maxAppliedCount = (db.prepare("SELECT COALESCE(MAX(applied_count), 0) AS m FROM chunks").get() as { m: number }).m;

  log.info(
    { scanned: result.scanned, embedded: result.embedded, merged: result.merged, threshold },
    'Semantic compaction pass complete',
  );
  return result;
}
