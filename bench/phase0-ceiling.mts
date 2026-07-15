/**
 * Phase-0 savings-ceiling probe (llm-cache subsystem).
 *
 * Reads a gateway.db, computes the caching savings ceiling from REAL traffic,
 * and writes bench/ceiling-report.json. Pure-read on the given DB path.
 *
 *   npx tsx bench/phase0-ceiling.mts [dbPath] [outPath]
 *
 * Ceiling model (honest, marginal-over-L1):
 *  - L1 (provider prefix cache) is ALREADY deployed → tokens_cached/tokens_in is
 *    the input already discounted. cost_usd is POST-L1 actual spend.
 *  - L2 (exact-match full-response cache) would serve a duplicate ADMISSIBLE
 *    request for free, saving its post-L1 cost_usd. Marginal L2 ceiling $ =
 *    Σ cost_usd of the repeat occurrences (all-but-first) of each admissible
 *    content fingerprint. Blended % = that / Σ cost_usd(all).
 *  - Admissible for L2 = successful (error_class NULL) AND not a tool_use
 *    side-effect turn AND temperature == 0 (or absent→provider-default, reported
 *    separately since those are NOT safe to exact-cache).
 *
 * KILL gate: marginal L2 blended ceiling < 30% → rescope to L1-only.
 * Ratified target (if it survives) = 0.8 × marginal L2 blended ceiling.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { contentFingerprint } from '../src/llm/cache/canonical.js';
import type { IRRequest } from '../shared-types/ir/v1.js';

const dbPath = process.argv[2] ?? 'data/gateway.db';
const outPath = process.argv[3] ?? 'bench/ceiling-report.json';

interface Row {
  trace_id: string;
  caller: string;
  ir_request: string | null;
  ir_response: string | null;
  error_class: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  ts: string;
}

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare('SELECT * FROM llm_calls').all() as Row[];
db.close();

let minTs = '', maxTs = '';
let sumCost = 0, sumIn = 0, sumOut = 0, sumCached = 0;
const perCallerTotal = new Map<string, number>();
const perCallerDup = new Map<string, number>();
const fpAll = new Map<string, number>();

// admissible bookkeeping
interface Adm { fp: string; cost: number }
const admissible: Adm[] = [];
let tempZero = 0, tempPos = 0, tempAbsent = 0;
let errRows = 0, toolUseRows = 0, parseFail = 0;

for (const r of rows) {
  if (r.ts && (minTs === '' || r.ts < minTs)) minTs = r.ts;
  if (r.ts && r.ts > maxTs) maxTs = r.ts;
  sumCost += r.cost_usd ?? 0;
  sumIn += r.tokens_in ?? 0;
  sumOut += r.tokens_out ?? 0;
  sumCached += r.tokens_cached ?? 0;

  if (!r.ir_request) { parseFail++; continue; }
  let ir: IRRequest;
  try { ir = JSON.parse(r.ir_request) as IRRequest; } catch { parseFail++; continue; }
  const fp = contentFingerprint(ir);
  fpAll.set(fp, (fpAll.get(fp) ?? 0) + 1);
  perCallerTotal.set(r.caller, (perCallerTotal.get(r.caller) ?? 0) + 1);

  // temperature classification
  const t = (ir as { temperature?: number }).temperature;
  if (t === 0) tempZero++; else if (typeof t === 'number') tempPos++; else tempAbsent++;

  // admissibility
  if (r.error_class) { errRows++; continue; }
  let stopReason: string | undefined;
  if (r.ir_response) { try { stopReason = (JSON.parse(r.ir_response) as { stop_reason?: string }).stop_reason; } catch { /* ignore */ } }
  if (stopReason === 'tool_use') { toolUseRows++; continue; }
  if (t !== 0) continue; // only temp==0 is safe to exact-cache
  admissible.push({ fp, cost: r.cost_usd ?? 0 });
}

// raw exact-dup rate (all fingerprinted rows)
const fingerprinted = [...fpAll.values()].reduce((a, b) => a + b, 0);
const distinct = fpAll.size;
const rawDup = fingerprinted - distinct;

// per-caller dup
for (const [caller] of perCallerTotal) perCallerDup.set(caller, 0);
{
  const perCallerFp = new Map<string, Map<string, number>>();
  // recompute per-caller distinct (need caller+fp) — second pass
  for (const r of rows) {
    if (!r.ir_request) continue;
    let ir: IRRequest; try { ir = JSON.parse(r.ir_request) as IRRequest; } catch { continue; }
    const fp = contentFingerprint(ir);
    if (!perCallerFp.has(r.caller)) perCallerFp.set(r.caller, new Map());
    const m = perCallerFp.get(r.caller)!; m.set(fp, (m.get(fp) ?? 0) + 1);
  }
  for (const [caller, m] of perCallerFp) {
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    perCallerDup.set(caller, tot - m.size);
  }
}

// L2 marginal savings: for each admissible fp, sum cost of all-but-cheapest? No —
// the FIRST occurrence pays, the rest are served free. Sum cost of repeats
// (all occurrences minus one per fp). We drop the single most-expensive as the
// "first" (conservative: keep the priciest as the paid miss).
const admByFp = new Map<string, number[]>();
for (const a of admissible) { if (!admByFp.has(a.fp)) admByFp.set(a.fp, []); admByFp.get(a.fp)!.push(a.cost); }
let l2SavingUsd = 0, admDupReqs = 0, admTotalReqs = admissible.length;
for (const costs of admByFp.values()) {
  if (costs.length < 2) continue;
  costs.sort((x, y) => y - x); // desc; index 0 = paid miss
  for (let i = 1; i < costs.length; i++) { l2SavingUsd += costs[i]; admDupReqs++; }
}

const l1CapturedPct = sumIn > 0 ? +(100 * sumCached / sumIn).toFixed(1) : 0;
const l2BlendedPct = sumCost > 0 ? +(100 * l2SavingUsd / sumCost).toFixed(1) : 0;
const days = minTs && maxTs ? +((Date.parse(maxTs) - Date.parse(minTs)) / 86400000).toFixed(2) : 0;
const KILL_THRESHOLD = 30;
const verdict = l2BlendedPct < KILL_THRESHOLD ? 'KILL→L1-only (marginal L2 < 30%)' : 'PROCEED→L2 viable';
const ratifiedTarget = +(0.8 * l2BlendedPct).toFixed(1);

const report = {
  generated_from: dbPath,
  window_days: days,
  sample_note: 'SHORT window; mostly automated/background traffic — NOT 7-day representative. Re-run after 72h live collection.',
  rows_total: rows.length,
  fingerprinted, parse_failures: parseFail,
  raw_exact_dup: { distinct_content_keys: distinct, duplicate_requests: rawDup, dup_pct: +(100 * rawDup / fingerprinted).toFixed(1) },
  cost_split: { total_cost_usd: +sumCost.toFixed(4), tokens_in: sumIn, tokens_cached: sumCached, tokens_out: sumOut, output_share_of_tokens_pct: +(100 * sumOut / (sumIn + sumOut)).toFixed(2) },
  l1_already_deployed: { input_tokens_cached_pct: l1CapturedPct, note: 'provider prefix cache already live (egress-anthropic cache_control)' },
  temperature_mix: { temp_zero: tempZero, temp_positive: tempPos, temp_absent_provider_default: tempAbsent },
  non_admissible: { error_rows: errRows, tool_use_side_effect_rows: toolUseRows },
  l2_admissible: { admissible_requests: admTotalReqs, admissible_duplicate_requests: admDupReqs, marginal_saving_usd: +l2SavingUsd.toFixed(4), marginal_blended_pct_of_total_spend: l2BlendedPct },
  kill_gate: { threshold_pct: KILL_THRESHOLD, marginal_l2_blended_pct: l2BlendedPct, verdict },
  proposed_ratified_target_pct: ratifiedTarget,
  per_caller: Object.fromEntries([...perCallerTotal].map(([c, tot]) => [c, { requests: tot, duplicate_requests: perCallerDup.get(c) ?? 0, dup_pct: +(100 * (perCallerDup.get(c) ?? 0) / tot).toFixed(1) }])),
};

writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
