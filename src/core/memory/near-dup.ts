/**
 * @file near-dup.ts
 * @description Write-time near-duplicate admission control for learning facts.
 *
 * Measured 2026-07-31 (PR #1023 audit): 263/649 active learning facts (41%)
 * had a ≥0.95-cosine nearest neighbour — daily status snapshots and re-learned
 * lessons pile up because content-hash dedup only stops byte-identical text.
 * The redundancy crowds retrieval candidates and dilutes RAG context.
 *
 * This is ADMISSION CONTROL on facts that have not been stored yet — it never
 * deprecates, rewrites, merges or decays existing memory, so it does not fall
 * under the two-reader-consensus rule for automated memory surgery
 * (CLAUDE.md invariant 9). On a hit the producer skips the INSERT and instead
 * bumps the twin's applied_count / updated_at — an annotation, not surgery.
 *
 * Fail-open by design: any error (embedder down, vec table missing) returns
 * null and the fact is stored normally.
 *
 * Relationship to semantic-compactor.ts: complementary, not overlapping. The
 * compactor is a RETROACTIVE sweep that deletes existing duplicate rows —
 * memory surgery, gated behind SUDO_SEMANTIC_COMPACT and invariant 9's
 * two-reader consensus. This module is PREVENTIVE and touches nothing that is
 * already stored; it shares the compactor's applied_count column/migration.
 */

import type { MindDB } from './db.js';
import type { EmbeddingService } from './embeddings.js';
import { ensureCompactionColumns } from './semantic-compactor.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:near-dup');

/** Default cosine-similarity threshold — matches the audit's twin criterion. */
const DEFAULT_THRESHOLD = 0.95;

export interface NearDupHit {
  /** id of the existing active chunk this fact duplicates */
  chunkId: number;
  /** cosine similarity in [0,1] */
  similarity: number;
}

export type NearDupFinder = (text: string) => Promise<NearDupHit | null>;

/**
 * Build a finder that answers: "does an ACTIVE fact ≥threshold-similar to this
 * text already exist?" KNN runs in the primary embedding space only — the
 * vec table follows the service's dims exactly as in hybrid-search.ts; no
 * cross-space comparison, no MiniLM fallback (384-d vectors are not
 * comparable to the 768/1536 stores).
 */
export function makeNearDupFinder(
  db: MindDB,
  embeddings: EmbeddingService,
  threshold = Number(process.env['SUDO_MEMORY_NEAR_DUP_THRESHOLD']) || DEFAULT_THRESHOLD,
): NearDupFinder {
  const vecTable = embeddings.dims === 768 ? 'chunks_vec_768' : 'chunks_vec';

  return async (text: string): Promise<NearDupHit | null> => {
    try {
      if (!db.vecLoaded || !embeddings.isAvailable) return null;
      const queryVec = await embeddings.embed(text);
      if (!queryVec) return null;

      const rows = db.db.prepare<{ embedding: Buffer; k: number }, { chunk_id: number; distance: number }>(`
        SELECT chunk_id, distance
        FROM ${vecTable}
        WHERE embedding MATCH :embedding
        ORDER BY distance
        LIMIT :k
      `).all({
        embedding: Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
        k: 3,
      });

      for (const r of rows) {
        // L2²=2(1−cos) for unit vectors — same conversion as hybrid-search.
        const similarity = Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2));
        if (similarity < threshold) break; // rows arrive distance-ascending
        const chunk = db.db
          .prepare<{ id: number }, { id: number; superseded_by: number | null }>(
            'SELECT id, superseded_by FROM chunks WHERE id = :id',
          ).get({ id: r.chunk_id });
        // Only an ACTIVE row blocks admission — a superseded twin must not
        // stop a fact from re-entering memory (mirrors RAG-6 in storeChunk).
        if (chunk && chunk.superseded_by == null) {
          return { chunkId: chunk.id, similarity };
        }
      }
      return null;
    } catch (err) {
      log.debug({ err: String(err) }, 'near-dup check failed — admitting fact (fail-open)');
      return null;
    }
  };
}

/**
 * Record that an existing fact was re-derived: bump its applied_count and
 * refresh updated_at. Annotation only — text/path/provenance untouched.
 */
export function recordReDerivation(db: MindDB, chunkId: number): void {
  // applied_count lives behind the semantic-compactor's idempotent migration
  // (schema.ts doesn't declare it) — ensure it before touching the column.
  ensureCompactionColumns(db.db);
  db.db.prepare(`
    UPDATE chunks
    SET applied_count = applied_count + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = :id
  `).run({ id: chunkId });
}
