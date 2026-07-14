/**
 * gw-refactor Phase 7 — SHADOW_REPORT.md generator.
 *
 * Takes the replay summary JSON produced by scripts/shadow-replay.mts and,
 * optionally, live-shadow rows from a gateway.db (rows written by runShadow
 * with caller='shadow' / purpose='live-shadow' when LLM_SHADOW=1). Emits
 * SHADOW_REPORT.md with a PASS verdict when material divergence < 1% across
 * everything measured (replay + live rows when present).
 *
 * Usage:
 *   npx tsx scripts/shadow-report.mts [--summary shadow-replay-summary.json]
 *     [--gateway-db data/gateway.db] [--out SHADOW_REPORT.md]
 */

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const summaryPath = arg('summary', 'shadow-replay-summary.json');
const gatewayDbPath = arg('gateway-db', '');
const outPath = arg('out', 'SHADOW_REPORT.md');

interface ReplaySummary {
  generated_at: string;
  db: string;
  limit: number;
  total: number;
  materialCount: number;
  materialPct: number;
  byField: Record<string, number>;
  skipped: Record<string, number>;
  response_side: { note: string; text_compared: number; text_skipped: number };
  examples: Array<{ trace_id: number; fields: string[] }>;
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as ReplaySummary;

// Optional live-shadow rows (counts only — ir_request in these rows already
// carries only field names + hashes, never content).
let live: { total: number; divergent: number; match: number } | null = null;
if (gatewayDbPath && existsSync(gatewayDbPath)) {
  const db = new Database(gatewayDbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT outcome, COUNT(*) AS n FROM llm_calls
          WHERE caller = 'shadow' AND purpose = 'live-shadow'
          GROUP BY outcome`,
      )
      .all() as Array<{ outcome: string | null; n: number }>;
    const divergent = rows.find((r) => r.outcome === 'shadow_divergent')?.n ?? 0;
    const match = rows.find((r) => r.outcome === 'shadow_match')?.n ?? 0;
    live = { total: divergent + match, divergent, match };
  } finally {
    db.close();
  }
}

const combinedTotal = summary.total + (live?.total ?? 0);
const combinedMaterial = summary.materialCount + (live?.divergent ?? 0);
const combinedPct = combinedTotal > 0 ? (combinedMaterial / combinedTotal) * 100 : 100;
const pass = combinedTotal > 0 && combinedPct < 1;

const fieldRows = Object.entries(summary.byField)
  .sort((a, b) => b[1] - a[1])
  .map(([f, n]) => `| ${f} | ${n} |`)
  .join('\n');

const md = `# SHADOW_REPORT — gw-refactor Phase 7

**Verdict: ${pass ? 'PASS' : 'FAIL'}** — material divergence ${combinedPct.toFixed(3)}% over ${combinedTotal} comparisons (threshold: < 1%).

Method (A19, PROGRESS.md): NO dual provider calls. The shadow compares
TRANSFORMATIONS on the same data — the legacy BrainRequest is mapped to IR and
egressed through the matching adapter, then the wire body's semantic content
(message count after folding, concatenated user/assistant/system/tool-result
text, tool names + schemas, max_tokens/temperature) is diffed against the
original legacy inputs. The response side round-trips the legacy result through
resultToIR and diffs stop-reason class, exact text, tool-call name/args, and
usage (±10% tolerance).

## Replay (recorded prod traces, zero cost / zero side effects)

- Source: \`${summary.db}\` (read-only), ${summary.limit} most recent \`brain_call\` traces with \`prompt_raw\`
- Generated: ${summary.generated_at}
- Replayed: **${summary.total}** — material: **${summary.materialCount}** (${summary.materialPct}%)
- Skipped: ${Object.entries(summary.skipped).map(([k, v]) => `${k}=${v}`).join(', ')}

### Response-side coverage limits (traces.db)

${summary.response_side.note}.
Text compared on ${summary.response_side.text_compared} rows, skipped on ${summary.response_side.text_skipped}.

### Material divergences by field

${fieldRows === '' ? '_none_' : `| field | count |\n|---|---|\n${fieldRows}`}

### Example material traces (ids + field names only)

${summary.examples.length === 0 ? '_none_' : summary.examples.map((e) => `- trace ${e.trace_id}: ${e.fields.join(', ')}`).join('\n')}

## Live shadow (gateway.db, LLM_SHADOW=1)

${
  live
    ? `- Rows: **${live.total}** — divergent: **${live.divergent}**, match: **${live.match}**`
    : '_No live-shadow rows yet — enable LLM_SHADOW=1 on the staging soak and re-run with --gateway-db data/gateway.db. Live rows add coverage the replay cannot: real streamed responses, usage figures, and tool-call results as brain.ts actually saw them._'
}
`;

writeFileSync(outPath, md);
console.log(`Wrote ${outPath} — verdict ${pass ? 'PASS' : 'FAIL'} (${combinedPct.toFixed(3)}% material over ${combinedTotal})`);
