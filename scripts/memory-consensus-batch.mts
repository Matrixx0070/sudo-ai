/**
 * @file memory-consensus-batch.mts
 * @description Two-reader consensus batch for retroactive memory hygiene
 * (CLAUDE.md invariant 9). Two operations, both requiring TWO independent
 * LLM readers to agree before anything is written:
 *
 *   TWINS     — active same-source fact pairs at cosine ≥ threshold (0.95):
 *               both readers must agree "duplicate" AND pick the same
 *               canonical row. The loser is SUPERSEDED (superseded_by =
 *               winner — retained for audit, excluded from recall, exactly
 *               the chunk-contradiction mechanism; never DELETEd) and its
 *               applied_count folds into the winner.
 *   EVERGREEN — active learning facts classified durable-vs-dated; both
 *               readers must agree "durable" before is_evergreen=1 is set
 *               (temporal-decay exemption; annotation only).
 *
 * Disagreement NEVER executes — it lands in the escalation section of the
 * report artifact (data/consensus-batch-<runid>.json).
 *
 * Judge independence (invariant 7): the two readers use different aliases
 * (sudo/cheap, sudo/judge) and the run HOLDS (skips) any item where both
 * aliases resolve to the same concrete model.
 *
 * Budgets (invariant 10): hard caps on pairs, facts and total LLM calls;
 * exhaustion halts gracefully and is reported.
 *
 * Usage (operator-run, not scheduled):
 *   npx tsx scripts/memory-consensus-batch.mts --db data/mind.db --dry
 *   npx tsx scripts/memory-consensus-batch.mts --db data/mind.db --execute
 *   flags: --max-pairs N (300) --max-facts N (700) --threshold F (0.95)
 */

import fs from 'node:fs';
import path from 'node:path';
import { MindDB } from '../src/core/memory/db.js';
import { chatIR } from '../src/llm/client.js';
import { resolveAlias } from '../src/llm/aliases.js';
import { ensureCompactionColumns } from '../src/core/memory/semantic-compactor.js';

const READER_A = 'sudo/cheap';
const READER_B = 'sudo/judge';
const MAX_LLM_CALLS = 400;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EXECUTE = argv.includes('--execute');
const dbPath = flag('--db') ?? 'data/mind.db';
const MAX_PAIRS = Number(flag('--max-pairs') ?? 300);
const MAX_FACTS = Number(flag('--max-facts') ?? 700);
const THRESHOLD = Number(flag('--threshold') ?? 0.95);

let llmCalls = 0;
async function ask(alias: string, purpose: string, prompt: string): Promise<string> {
  if (llmCalls >= MAX_LLM_CALLS) throw new Error(`LLM call budget exhausted (${MAX_LLM_CALLS})`);
  llmCalls++;
  const resp = await chatIR({
    alias,
    caller: 'memory-consensus-batch',
    purpose,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 600,
    priority: 'background',
  });
  return resp.text;
}

interface FactRow { id: number; text: string; source: string; created_at: string; applied_count: number; is_evergreen: number }

function loadVec(db: MindDB): Map<number, Float32Array> {
  const rows = db.db.prepare(`
    SELECT c.id, v.embedding FROM chunks c JOIN chunks_vec_768 v ON v.chunk_id = c.id
    WHERE c.superseded_by IS NULL AND c.path NOT LIKE 'session:%:meta'
  `).all() as Array<{ id: number; embedding: Buffer }>;
  return new Map(rows.map((r) => [
    r.id,
    new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  ]));
}

const cos = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

function parseJson<T>(raw: string): T | null {
  const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const db = new MindDB(dbPath);
ensureCompactionColumns(db.db);

// Judge independence: HOLD if both aliases resolve to the same concrete model.
const modelA = resolveAlias(READER_A);
const modelB = resolveAlias(READER_B);
if (modelA === modelB) {
  console.error(`HOLD: both readers resolve to ${modelA} — no independent second reader; refusing to run.`);
  process.exit(2);
}
console.error(`[consensus] readerA=${READER_A}→${modelA} readerB=${READER_B}→${modelB} mode=${EXECUTE ? 'EXECUTE' : 'DRY'}`);

const facts = db.db.prepare(`
  SELECT id, text, source, created_at, applied_count, is_evergreen FROM chunks
  WHERE superseded_by IS NULL AND path NOT LIKE 'session:%:meta'
  ORDER BY id
`).all() as FactRow[];
const byId = new Map(facts.map((f) => [f.id, f]));
const vecs = loadVec(db);

const report = {
  runAt: new Date().toISOString(),
  mode: EXECUTE ? 'execute' : 'dry',
  readers: { a: `${READER_A}→${modelA}`, b: `${READER_B}→${modelB}` },
  twins: { candidates: 0, agreedSuperseded: [] as unknown[], escalated: [] as unknown[], errors: 0 },
  evergreen: { judged: 0, agreedMarked: [] as number[], escalated: [] as unknown[], errors: 0 },
  llmCalls: 0,
  budgetHalted: false,
};

// ---------------------------------------------------------------------------
// Phase 1 — twins
// ---------------------------------------------------------------------------

// Build candidate pairs: same-source, cos >= THRESHOLD, each id in one pair
// (greedy by best-neighbour; supersede chains resolve over repeat runs).
const paired = new Set<number>();
const pairs: Array<{ a: FactRow; b: FactRow; sim: number }> = [];
const ids = [...vecs.keys()];
for (const idA of ids) {
  if (paired.has(idA)) continue;
  const fa = byId.get(idA);
  if (!fa) continue;
  let best: { id: number; sim: number } | null = null;
  for (const idB of ids) {
    if (idB === idA || paired.has(idB)) continue;
    const fb = byId.get(idB);
    if (!fb || fb.source !== fa.source) continue;
    const sim = cos(vecs.get(idA)!, vecs.get(idB)!);
    if (sim >= THRESHOLD && (!best || sim > best.sim)) best = { id: idB, sim };
  }
  if (best) {
    pairs.push({ a: fa, b: byId.get(best.id)!, sim: best.sim });
    paired.add(idA); paired.add(best.id);
    if (pairs.length >= MAX_PAIRS) break;
  }
}
report.twins.candidates = pairs.length;
console.error(`[consensus] twin candidate pairs: ${pairs.length}`);

const twinPrompt = (a: FactRow, b: FactRow): string => [
  'Two stored memory facts follow. Decide if they are DUPLICATES — the same underlying fact, one adding no real information over the other.',
  'If duplicates, pick the CANONICAL one to keep: the more specific/complete/recent-in-content one.',
  'Reply with ONLY JSON: {"duplicate": true|false, "canonical": "A"|"B"}',
  '',
  `A (id ${a.id}, created ${a.created_at}): ${a.text}`,
  `B (id ${b.id}, created ${b.created_at}): ${b.text}`,
].join('\n');

interface TwinVerdict { duplicate: boolean; canonical?: 'A' | 'B' }

const supersede = db.db.prepare(
  "UPDATE chunks SET superseded_by = :winner, superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :loser",
);
const foldCount = db.db.prepare(
  'UPDATE chunks SET applied_count = applied_count + :n WHERE id = :winner',
);

for (const p of pairs) {
  try {
    const [ra, rb] = await Promise.all([
      ask(READER_A, 'consensus-twin', twinPrompt(p.a, p.b)),
      ask(READER_B, 'consensus-twin', twinPrompt(p.a, p.b)),
    ]);
    const va = parseJson<TwinVerdict>(ra);
    const vb = parseJson<TwinVerdict>(rb);
    if (!va || !vb) { report.twins.errors++; continue; }

    if (va.duplicate && vb.duplicate && va.canonical && va.canonical === vb.canonical) {
      const winner = va.canonical === 'A' ? p.a : p.b;
      const loser  = va.canonical === 'A' ? p.b : p.a;
      report.twins.agreedSuperseded.push({ winner: winner.id, loser: loser.id, sim: +p.sim.toFixed(4) });
      if (EXECUTE) {
        supersede.run({ winner: winner.id, loser: loser.id });
        foldCount.run({ n: loser.applied_count, winner: winner.id });
      }
    } else if (va.duplicate !== vb.duplicate || (va.duplicate && va.canonical !== vb.canonical)) {
      report.twins.escalated.push({ a: p.a.id, b: p.b.id, sim: +p.sim.toFixed(4), va, vb });
    }
    // both said not-duplicate → no action, no escalation
  } catch (err) {
    if (String(err).includes('budget exhausted')) { report.budgetHalted = true; break; }
    report.twins.errors++;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — evergreen (batched 20 facts per call)
// ---------------------------------------------------------------------------

const evergreenCandidates = facts
  .filter((f) => f.is_evergreen === 0 && !report.twins.agreedSuperseded.some((s) => (s as { loser: number }).loser === f.id))
  .slice(0, MAX_FACTS);

const evPrompt = (batch: FactRow[]): string => [
  'Classify each stored memory fact as DURABLE or DATED.',
  'DURABLE: a lasting preference, configuration, convention, capability, or invariant that stays true regardless of date.',
  'DATED: status snapshots, metrics, spend figures, incidents, anything tied to a specific day or transient state.',
  'Reply with ONLY a JSON array of {"id": <id>, "durable": true|false} for every fact listed.',
  '',
  ...batch.map((f) => `id ${f.id}: ${f.text}`),
].join('\n');

const markEvergreen = db.db.prepare('UPDATE chunks SET is_evergreen = 1 WHERE id = :id');

for (let i = 0; i < evergreenCandidates.length; i += 20) {
  const batch = evergreenCandidates.slice(i, i + 20);
  try {
    const [ra, rb] = await Promise.all([
      ask(READER_A, 'consensus-evergreen', evPrompt(batch)),
      ask(READER_B, 'consensus-evergreen', evPrompt(batch)),
    ]);
    const va = parseJson<Array<{ id: number; durable: boolean }>>(ra);
    const vb = parseJson<Array<{ id: number; durable: boolean }>>(rb);
    if (!va || !vb) { report.evergreen.errors++; continue; }
    const mapA = new Map(va.map((v) => [v.id, v.durable]));
    const mapB = new Map(vb.map((v) => [v.id, v.durable]));
    for (const f of batch) {
      const da = mapA.get(f.id);
      const dbv = mapB.get(f.id);
      if (da === undefined || dbv === undefined) continue;
      report.evergreen.judged++;
      if (da && dbv) {
        report.evergreen.agreedMarked.push(f.id);
        if (EXECUTE) markEvergreen.run({ id: f.id });
      } else if (da !== dbv) {
        report.evergreen.escalated.push({ id: f.id, a: da, b: dbv });
      }
    }
  } catch (err) {
    if (String(err).includes('budget exhausted')) { report.budgetHalted = true; break; }
    report.evergreen.errors++;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

report.llmCalls = llmCalls;
const outPath = path.join(path.dirname(dbPath), `consensus-batch-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  mode: report.mode,
  twinPairs: report.twins.candidates,
  superseded: report.twins.agreedSuperseded.length,
  twinEscalations: report.twins.escalated.length,
  evergreenJudged: report.evergreen.judged,
  evergreenMarked: report.evergreen.agreedMarked.length,
  evergreenEscalations: report.evergreen.escalated.length,
  llmCalls,
  budgetHalted: report.budgetHalted,
  report: outPath,
}, null, 2));
