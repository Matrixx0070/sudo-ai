/**
 * Tests for compactSemanticDuplicates — periodic semantic-dedup pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  compactSemanticDuplicates,
  cosineSimilarity,
  ensureCompactionColumns,
  DEFAULT_SIMILARITY_THRESHOLD,
  type EmbeddingFn,
} from '../../src/core/memory/semantic-compactor.js';

function newDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'conversation',
      hash TEXT NOT NULL UNIQUE,
      is_evergreen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return db;
}

function insert(
  db: Database.Database,
  text: string,
  source: string,
  createdAt: string,
  isEvergreen = 0,
): number {
  const hash = `${text}|${createdAt}`;
  const info = db
    .prepare(
      "INSERT INTO chunks (text, source, hash, is_evergreen, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(text, source, hash, isEvergreen, createdAt);
  return info.lastInsertRowid as number;
}

/** Deterministic embedder: hashes each token, builds a sparse-ish vector. */
function makeEmbedder(): EmbeddingFn {
  return {
    async embed(text: string): Promise<Float32Array> {
      const v = new Float32Array(64);
      const tokens = text.toLowerCase().split(/\s+/);
      for (const t of tokens) {
        let h = 0;
        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
        const idx = ((h % 64) + 64) % 64;
        v[idx]! += 1;
      }
      // Normalise so cosine == dot product on unit vectors.
      let mag = 0;
      for (const x of v) mag += x * x;
      mag = Math.sqrt(mag) || 1;
      for (let i = 0; i < v.length; i++) v[i] = v[i]! / mag;
      return v;
    },
  };
}

let db: Database.Database;
let embed: EmbeddingFn;

beforeEach(() => {
  db = newDb();
  embed = makeEmbedder();
});

afterEach(() => {
  db.close();
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });
  it('returns 0 on length mismatch instead of throwing', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0);
  });
  it('returns 0 when either vector has zero magnitude', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe('ensureCompactionColumns', () => {
  it('adds applied_count and embedding_json on first run', () => {
    const migrated = ensureCompactionColumns(db);
    expect(migrated).toBe(true);
    const cols = (db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('applied_count');
    expect(cols).toContain('embedding_json');
  });
  it('is idempotent on subsequent runs', () => {
    ensureCompactionColumns(db);
    expect(ensureCompactionColumns(db)).toBe(false);
  });
});

describe('compactSemanticDuplicates', () => {
  it('default threshold matches the bot-recommended 0.92', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.92);
  });

  it('returns zeroes on an empty table', async () => {
    const r = await compactSemanticDuplicates(db, embed);
    expect(r.scanned).toBe(0);
    expect(r.embedded).toBe(0);
    expect(r.merged).toBe(0);
  });

  it('collapses near-identical rows into the older one with applied_count = N', async () => {
    insert(db, 'heartbeat acknowledged tick 1', 'conversation', '2026-06-14T22:00:00Z');
    insert(db, 'heartbeat acknowledged tick 2', 'conversation', '2026-06-14T22:01:00Z');
    insert(db, 'heartbeat acknowledged tick 3', 'conversation', '2026-06-14T22:02:00Z');

    const r = await compactSemanticDuplicates(db, embed, { threshold: 0.5 });

    expect(r.scanned).toBe(3);
    expect(r.merged).toBe(2);
    expect(r.deleted).toBe(2);

    const survivors = db.prepare("SELECT id, text, applied_count FROM chunks ORDER BY id").all() as Array<{ id: number; text: string; applied_count: number }>;
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.applied_count).toBe(3); // 1 (original) + 2 merged
    expect(survivors[0]!.text).toContain('tick 1'); // oldest kept
  });

  it('removes the deleted duplicate from chunks_vec (ANN sync — no orphan)', async () => {
    const a = insert(db, 'heartbeat acknowledged tick 1', 'conversation', '2026-06-14T22:00:00Z');
    const b = insert(db, 'heartbeat acknowledged tick 2', 'conversation', '2026-06-14T22:01:00Z'); // dup of A
    // Stand-in for the vec0 ANN table — a plain table exercises the DELETE path.
    db.exec('CREATE TABLE chunks_vec (chunk_id INTEGER)');
    db.prepare('INSERT INTO chunks_vec (chunk_id) VALUES (?)').run(a);
    db.prepare('INSERT INTO chunks_vec (chunk_id) VALUES (?)').run(b);

    const r = await compactSemanticDuplicates(db, embed, { threshold: 0.5 });
    expect(r.deleted).toBe(1);

    const vecIds = (db.prepare('SELECT chunk_id FROM chunks_vec ORDER BY chunk_id').all() as Array<{ chunk_id: number }>)
      .map((x) => x.chunk_id);
    expect(vecIds).toEqual([a]); // the deleted duplicate's vector is gone; the keeper's remains
  });

  it('does not merge rows below the threshold', async () => {
    insert(db, 'heartbeat acknowledged ping pong wow', 'conversation', '2026-06-14T22:00:00Z');
    insert(db, 'completely different rocket science topic xyz', 'conversation', '2026-06-14T22:01:00Z');

    const r = await compactSemanticDuplicates(db, embed, { threshold: 0.95 });

    expect(r.merged).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c).toBe(2);
  });

  it('does not collapse across different sources', async () => {
    insert(db, 'heartbeat ack', 'conversation', '2026-06-14T22:00:00Z');
    insert(db, 'heartbeat ack', 'tool', '2026-06-14T22:01:00Z');

    const r = await compactSemanticDuplicates(db, embed, { threshold: 0.5 });

    expect(r.merged).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c).toBe(2);
  });

  it('promotes a duplicate evergreen row over an older non-evergreen one', async () => {
    const olderNonEvergreenId = insert(db, 'core lesson alpha', 'learning', '2026-06-14T22:00:00Z', 0);
    insert(db, 'core lesson alpha', 'learning', '2026-06-14T22:01:00Z', 1);

    const r = await compactSemanticDuplicates(db, embed, { threshold: 0.5 });

    expect(r.merged).toBe(1);
    // The non-evergreen older row should be gone, the evergreen survives.
    const remaining = db.prepare("SELECT id, is_evergreen FROM chunks").all() as Array<{ id: number; is_evergreen: number }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.is_evergreen).toBe(1);
    expect(remaining[0]!.id).not.toBe(olderNonEvergreenId);
  });

  it('persists generated embeddings so subsequent runs do not re-embed', async () => {
    let embedCalls = 0;
    const counting: EmbeddingFn = {
      async embed(text) {
        embedCalls++;
        return embed.embed(text);
      },
    };
    insert(db, 'something to compact', 'conversation', '2026-06-14T22:00:00Z');
    insert(db, 'something to compact ish', 'conversation', '2026-06-14T22:01:00Z');

    await compactSemanticDuplicates(db, counting, { threshold: 0.99 }); // too high → no merge, just embed
    expect(embedCalls).toBe(2);
    await compactSemanticDuplicates(db, counting, { threshold: 0.99 });
    // Second run should hit cached embedding_json column — no new calls.
    expect(embedCalls).toBe(2);
  });

  it('respects maxChunks cap', async () => {
    for (let i = 0; i < 10; i++) {
      insert(db, `row ${i}`, 'conversation', `2026-06-14T22:0${i}:00Z`);
    }
    const r = await compactSemanticDuplicates(db, embed, { maxChunks: 4 });
    expect(r.scanned).toBe(4);
  });

  it('survives an embedder that throws — row stays untouched', async () => {
    insert(db, 'will fail to embed', 'conversation', '2026-06-14T22:00:00Z');
    const broken: EmbeddingFn = {
      async embed() { throw new Error('boom'); },
    };
    const r = await compactSemanticDuplicates(db, broken);
    expect(r.embedded).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c).toBe(1);
  });

  it('re-embeds a cached vector whose width != expectedDim (stale cross-dim cache)', async () => {
    ensureCompactionColumns(db);
    const id = insert(db, 'a chunk with a stale cache', 'conversation', '2026-06-14T22:00:00Z');
    // Plant a stale 3-dim cached embedding (e.g. a leftover 1536-dim OpenAI vector).
    db.prepare("UPDATE chunks SET embedding_json = ? WHERE id = ?").run(JSON.stringify([0.1, 0.2, 0.3]), id);

    let embedCalls = 0;
    const counting: EmbeddingFn = { async embed(t) { embedCalls++; return embed.embed(t); } };
    await compactSemanticDuplicates(db, counting, { expectedDim: 64 });

    expect(embedCalls).toBe(1); // wrong-dim cache invalidated → re-embedded
    const cached = JSON.parse((db.prepare("SELECT embedding_json AS e FROM chunks WHERE id = ?").get(id) as { e: string }).e);
    expect(cached).toHaveLength(64); // cache now holds the fresh 64-dim vector
  });

  it('reuses a cached vector whose width matches expectedDim (no re-embed)', async () => {
    insert(db, 'cached at the right dim', 'conversation', '2026-06-14T22:00:00Z');
    let embedCalls = 0;
    const counting: EmbeddingFn = { async embed(t) { embedCalls++; return embed.embed(t); } };
    await compactSemanticDuplicates(db, counting, { expectedDim: 64 });
    expect(embedCalls).toBe(1);
    await compactSemanticDuplicates(db, counting, { expectedDim: 64 }); // 64-dim cache matches → reuse
    expect(embedCalls).toBe(1);
  });
});
