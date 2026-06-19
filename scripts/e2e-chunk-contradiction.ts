/**
 * Live end-to-end proof for #7 chunk contradiction resolution, exercising the
 * REAL services the daemon uses:
 *   - real EmbeddingService (text-embedding-3-small) for stage 1,
 *   - a real LLM opposition judge (OpenAI chat) for stage 2 — same boolean
 *     interface the daemon backs with Claude (brain.chat),
 *   - real MindDB.markChunkSuperseded + recall exclusion.
 *
 * Runs against a throwaway temp DB (never touches prod mind.db). Seeds three
 * independent subject pairs and asserts the detector's verdict on each:
 *   contradiction → supersede;  restatement → keep;  unrelated → keep.
 *
 * Usage: OPENAI_API_KEY=sk-... npx tsx scripts/e2e-chunk-contradiction.ts
 */

import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { MindDB } from '../src/core/memory/db.js';
import { EmbeddingService } from '../src/core/memory/embeddings.js';
import {
  resolveChunkContradictions,
  type ContradictionJudge,
} from '../src/core/memory/chunk-contradiction.js';

const JUDGE_MODEL = 'gpt-4o-mini';

const openaiJudge: ContradictionJudge = async (incoming, existing) => {
  const prompt = [
    'You compare two stored memory facts and decide if the NEW one CONTRADICTS the EXISTING one.',
    'Answer with exactly one word: YES or NO.',
    'YES only when they concern the SAME subject and assert incompatible/opposing things.',
    'NO when the new fact merely restates, refines, adds to, or is unrelated to the existing one.',
    '',
    `NEW fact:      ${incoming}`,
    `EXISTING fact: ${existing}`,
    '',
    'Does the NEW fact contradict the EXISTING fact? Answer YES or NO.',
  ].join('\n');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 4 }),
  });
  if (!res.ok) throw new Error(`judge ${res.status}: ${await res.text()}`);
  const j = await res.json() as { choices: Array<{ message: { content: string } }> };
  return j.choices[0]!.message.content.trim().toLowerCase().startsWith('yes');
};

const CASES = [
  { label: 'contradiction', existing: "The user's preferred editor indentation is spaces.", incoming: "The user's preferred editor indentation is tabs.", expectSupersede: true },
  { label: 'restatement',   existing: 'The production database for this project is PostgreSQL.', incoming: 'Production uses Postgres as its primary datastore.', expectSupersede: false },
  { label: 'unrelated',     existing: 'The cache TTL is five minutes.', incoming: 'Telegram is the main notification channel.', expectSupersede: false },
];

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
  // This harness exists to exercise the ENABLED path; force the flag on unless
  // the caller explicitly set it (the detector no-ops when it's off).
  process.env['SUDO_CHUNK_CONTRADICT'] = process.env['SUDO_CHUNK_CONTRADICT'] ?? '1';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-contra-'));
  const db = new MindDB(path.join(dir, 'mind.db'));
  const embeddings = new EmbeddingService(db);
  const deps = { db, embed: (t: string) => embeddings.embed(t), judge: openaiJudge };

  let pass = 0, fail = 0;
  try {
    for (const c of CASES) {
      const existing = db.storeChunk(c.existing, 'memory/auto-dream', 'learning');
      const incoming = db.storeChunk(c.incoming, 'memory/auto-dream', 'learning');
      const res = await resolveChunkContradictions(incoming, deps, { candidateFilter: (x) => x.source === 'learning' });
      const superseded = db.getChunk(existing.id)?.supersededBy === incoming.id;
      const ok = superseded === c.expectSupersede;
      ok ? pass++ : fail++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(13)} expected supersede=${c.expectSupersede}  got=${superseded}  (superseded ids: ${JSON.stringify(res.supersededIds)})`);
    }
  } finally {
    db.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n${pass}/${pass + fail} cases passed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
