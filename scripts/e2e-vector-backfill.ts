/**
 * Live end-to-end proof that the corpus vector backfill closes the gap:
 * after a backfill pass, chunks_vec is populated and hybrid-search's VECTOR
 * path returns matches (instead of the silent BM25-only fallback).
 *
 * Uses real services on a throwaway temp DB (never touches prod mind.db):
 *   - sqlite-vec loaded (vector search enabled),
 *   - real EmbeddingService (text-embedding-3-small, 1536-dim),
 *   - real backfillChunkVectors + MindDBVectorStore + hybridSearch.
 *
 * Usage: OPENAI_API_KEY=sk-... npx tsx scripts/e2e-vector-backfill.ts
 */

import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { MindDB } from '../src/core/memory/db.js';
import { EmbeddingService } from '../src/core/memory/embeddings.js';
import { backfillChunkVectors, MindDBVectorStore } from '../src/core/memory/vector-backfill.js';
import { hybridSearch } from '../src/core/memory/hybrid-search.js';

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-vecbf-'));
  const db = new MindDB(path.join(dir, 'mind.db'));
  if (!db.vecLoaded) throw new Error('sqlite-vec not loaded — cannot prove the vector path');

  // Seed facts + one session-meta chunk (which must NOT be embedded).
  db.storeChunk('The production database for this project is PostgreSQL.', 'memory/auto-dream', 'learning');
  db.storeChunk('Deployments run on the us-east-1 AWS region.', 'memory/auto-dream', 'learning');
  db.storeChunk('The user prefers spaces over tabs for indentation.', 'insight:pref', 'learning');
  db.storeChunk('{"id":"s1","channel":"telegram"}', 'session:s1:meta', 'conversation');

  const embeddings = new EmbeddingService(db);
  const store = new MindDBVectorStore(db.db);

  const before = (db.db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n;
  const res = await backfillChunkVectors(db, embeddings, store);
  const after = (db.db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n;

  // Query the vector path with a paraphrase that shares NO keywords with the
  // stored fact — so a hit can only come from semantic vector search, not BM25.
  const results = await hybridSearch(db, embeddings, { query: 'which relational datastore backs prod?', maxResults: 3, minScore: 0 });
  const vectorHit = results.find((r) => r.matchType === 'vector' || r.matchType === 'hybrid');

  console.log(`chunks_vec rows: ${before} -> ${after}  (backfill embedded=${res.embedded}, pending=${res.pending}, skipped=${res.skipped})`);
  console.log(`session-meta excluded: ${after === 3 ? 'YES (3 facts, meta skipped)' : 'NO — got ' + after}`);
  console.log(`top result: ${results[0] ? `[${results[0].matchType}] ${results[0].chunk.text.slice(0, 50)}` : '(none)'}`);

  const ok =
    after === 3 &&                 // 3 facts embedded, session-meta excluded
    res.embedded === 3 &&
    vectorHit !== undefined &&      // vector path produced a semantic match
    /PostgreSQL/i.test(results[0]?.chunk.text ?? '');

  db.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(ok ? '\nPASS — backfill populated chunks_vec and vector search returns semantic matches' : '\nFAIL');
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
