/**
 * @file retrieval-eval.mts
 * @description Reusable retrieval-quality harness for the memory hybrid search.
 *
 * Measures recall@1 / recall@5 / MRR over a snapshot of mind.db, per arm:
 *   • hybrid  — the production hybridSearch path (primary embedding space)
 *   • bm25    — same path with embeddings unavailable (BM25-only degrade lane)
 *
 * Query sets:
 *   • verbatim   — generated on the fly: a mid-chunk sentence from each
 *                  deterministically-sampled chunk (favours BM25 by design;
 *                  regression floor, not a semantic-quality measure).
 *   • paraphrase — checked-in fixture scripts/fixtures/retrieval-paraphrase.json
 *                  ({chunkId, query}[]); measures semantic retrieval, the case
 *                  dense embeddings exist to win.
 *
 * Usage (ollama must be up for the hybrid arm):
 *   npx tsx scripts/retrieval-eval.mts --db /root/eval-scratch/mind-eval.db --set verbatim
 *   npx tsx scripts/retrieval-eval.mts --db ... --set paraphrase
 *   npx tsx scripts/retrieval-eval.mts --db ... --set verbatim --dump-sample 40 > chunks.json
 *
 * History: PR #1021 (fusion averaging bug, recall@1 33%→73%) and the RRF
 * rewrite were both decided on this recipe; earlier runs used throwaway
 * scripts that were lost — this file is the durable replacement.
 */

import fs from 'node:fs';
import { MindDB } from '../src/core/memory/db.js';
import { EmbeddingService } from '../src/core/memory/embeddings.js';
import { hybridSearch } from '../src/core/memory/hybrid-search.js';

interface EvalQuery { chunkId: number; query: string }

function parseArgs(): { db: string; set: string; dumpSample: number } {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const db = get('--db');
  if (!db) throw new Error("required: --db <path to mind.db snapshot>");
  return { db, set: get('--set') ?? 'verbatim', dumpSample: Number(get('--dump-sample') ?? 0) };
}

/** Deterministic even-stride sample of chunks that have a 768-space vector. */
function sampleChunks(db: MindDB, n: number): Array<{ id: number; content: string }> {
  const rows = db.db.prepare<[], { id: number; content: string }>(`
    SELECT c.id, c.text AS content FROM chunks c
    JOIN chunks_vec_768 v ON v.chunk_id = c.id
    WHERE c.superseded_by IS NULL AND c.path NOT LIKE 'session:%:meta'
    ORDER BY c.id
  `).all();
  if (rows.length <= n) return rows;
  const stride = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * stride)]!);
}

/** Mid-chunk sentence, ≥40 chars when available — the verbatim query. */
function midSentence(content: string): string {
  const sentences = content.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 40);
  if (sentences.length === 0) return content.slice(0, 120);
  return sentences[Math.floor(sentences.length / 2)]!.slice(0, 200);
}

interface ArmResult { name: string; r1: number; r5: number; mrr: number; n: number }

async function runArm(
  name: string,
  db: MindDB,
  embeddings: EmbeddingService,
  queries: EvalQuery[],
  localEmbedder: { isAvailable: boolean; embed: (t: string) => Promise<Float32Array | null> },
  extraOptions: Record<string, unknown> = {},
): Promise<ArmResult> {
  let r1 = 0, r5 = 0, mrr = 0, n = 0;
  for (const q of queries) {
    const results = await hybridSearch(
      db, embeddings,
      { query: q.query, maxResults: 5, minScore: 0, ...extraOptions },
      localEmbedder,
    );
    const rank = results.findIndex((r) => r.chunk.id === q.chunkId);
    if (rank === -1 && process.argv.includes('--misses')) {
      console.error(`[miss] arm=${name} chunk=${q.chunkId} q="${q.query}" top=[${results.slice(0, 3).map((r) => r.chunk.id).join(',')}]`);
    }
    n++;
    if (rank === 0) r1++;
    if (rank >= 0 && rank < 5) r5++;
    if (rank >= 0) mrr += 1 / (rank + 1);
  }
  return { name, r1: r1 / n, r5: r5 / n, mrr: mrr / n, n };
}

const { db: dbPath, set, dumpSample } = parseArgs();
const db = new MindDB(dbPath);

if (dumpSample > 0) {
  const sample = sampleChunks(db, dumpSample);
  console.log(JSON.stringify(sample.map((c) => ({ id: c.id, content: c.content.slice(0, 400) })), null, 2));
  process.exit(0);
}

let queries: EvalQuery[];
if (set === 'verbatim') {
  queries = sampleChunks(db, 60).map((c) => ({ chunkId: c.id, query: midSentence(c.content) }));
} else {
  const fixture = new URL('./fixtures/retrieval-paraphrase.json', import.meta.url).pathname;
  queries = (JSON.parse(fs.readFileSync(fixture, 'utf8')) as EvalQuery[])
    // fixture survives DB drift: skip targets that no longer exist / got superseded
    .filter((q) => db.db.prepare<{ id: number }, { c: number }>(
      "SELECT COUNT(*) c FROM chunks WHERE id = :id AND superseded_by IS NULL",
    ).get({ id: q.chunkId })!.c > 0);
}
console.error(`[eval] set=${set} queries=${queries.length} db=${dbPath}`);

const noLocal = { isAvailable: false, embed: async () => null };
const primary = new EmbeddingService(db);
const deadEmb = new EmbeddingService(db, 'text-embedding-3-small'); // no OpenAI key → BM25-only lane

const arms: ArmResult[] = [];
arms.push(await runArm('hybrid', db, primary, queries, noLocal));
// The exact option set rag-engine.ts retrieveContext uses — the production surface.
arms.push(await runArm('hybrid-rag', db, primary, queries, noLocal,
  { minScore: 0.2, temporalDecay: true, halfLifeDays: 30, mmr: true, mmrLambda: 0.7 }));
arms.push(await runArm('bm25-only', db, deadEmb, queries, noLocal));

console.log(`\nset=${set}  n=${arms[0]!.n}`);
console.log('arm         recall@1  recall@5  MRR');
for (const a of arms) {
  console.log(`${a.name.padEnd(11)} ${(a.r1 * 100).toFixed(0).padStart(7)}%  ${(a.r5 * 100).toFixed(0).padStart(7)}%  ${a.mrr.toFixed(3)}`);
}
