/**
 * gw-refactor Phase 7 — shadow replay against recorded prod brain_call traces.
 *
 * Reads the N most recent trace_type='brain_call' rows with prompt_raw NOT NULL
 * from a traces.db (READ-ONLY — better-sqlite3 `readonly: true`, which opens
 * with SQLITE_OPEN_READONLY, the same guarantee as a `file:...?mode=ro` URI),
 * replays each request through requestShadowDiff, and — using the recorded
 * finishReason/response_raw as the "legacy result" — runs resultToIR +
 * compareShadow on the response side.
 *
 * Response-side limitations (documented, by design):
 *   - usage is NOT stored in traces → usage comparison skipped entirely.
 *   - toolCalls are NOT stored → tool-call comparison skipped.
 *   - text equality vs response_raw is only meaningful when finishReason==='stop';
 *     truncated response_raw (contains '[...truncated') is skipped too.
 *
 * Output: a summary JSON (counts + byField histogram + first 5 material trace
 * ids with FIELD NAMES ONLY — never trace content), printed to stdout and
 * written to --out.
 *
 * Usage:
 *   npx tsx scripts/shadow-replay.mts [--db /root/sudo-ai-v4/data/traces.db]
 *     [--limit 500] [--out shadow-replay-summary.json]
 */

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { requestShadowDiff, resultToIR, compareShadow } from '../src/llm/shadow.js';
import type { ShadowBrainRequest, ShadowLegacyMessage, ShadowLegacyResult } from '../src/llm/shadow.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const dbPath = arg('db', '/root/sudo-ai-v4/data/traces.db');
const limit = Number(arg('limit', '500'));
const outPath = arg('out', 'shadow-replay-summary.json');

interface TraceRow {
  id: number;
  prompt_raw: string;
  response_raw: string | null;
  model_params: string | null;
}

// READ-ONLY open — never writes, never creates.
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db
  .prepare(
    `SELECT id, prompt_raw, response_raw, model_params
       FROM traces
      WHERE trace_type = 'brain_call' AND prompt_raw IS NOT NULL
      ORDER BY id DESC
      LIMIT ?`,
  )
  .all(limit) as TraceRow[];
db.close();

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function toLegacyMessages(parsed: unknown): ShadowLegacyMessage[] | null {
  if (!Array.isArray(parsed)) return null;
  const out: ShadowLegacyMessage[] = [];
  for (const m of parsed) {
    if (typeof m !== 'object' || m === null) continue;
    const rec = m as Record<string, unknown>;
    const role = typeof rec.role === 'string' && VALID_ROLES.has(rec.role) ? (rec.role as ShadowLegacyMessage['role']) : null;
    if (!role) continue;
    const msg: ShadowLegacyMessage = {
      role,
      content: typeof rec.content === 'string' ? rec.content : '',
    };
    if (Array.isArray(rec.toolCalls)) msg.toolCalls = rec.toolCalls as ShadowLegacyMessage['toolCalls'];
    if (typeof rec.toolCallId === 'string') msg.toolCallId = rec.toolCallId;
    if (Array.isArray(rec.images)) msg.images = rec.images as ShadowLegacyMessage['images'];
    out.push(msg);
  }
  return out;
}

let total = 0;
let materialCount = 0;
let skippedTruncatedPrompt = 0;
let skippedBadJson = 0;
let skippedNoModel = 0;
let responseTextCompared = 0;
let responseTextSkipped = 0;
const byField: Record<string, number> = {};
const examples: Array<{ trace_id: number; fields: string[] }> = [];

for (const row of rows) {
  // Trace capture caps prompt_raw (~16KB) and hard-truncates mid-JSON with an
  // "…[+N chars truncated]" tail — unparseable by design, not a divergence.
  if (/chars truncated\]$/.test(row.prompt_raw) || !row.prompt_raw.trimEnd().endsWith(']')) {
    skippedTruncatedPrompt++;
    continue;
  }
  let messages: ShadowLegacyMessage[] | null = null;
  let params: Record<string, unknown> = {};
  try {
    messages = toLegacyMessages(JSON.parse(row.prompt_raw));
    if (row.model_params) params = JSON.parse(row.model_params) as Record<string, unknown>;
  } catch {
    skippedBadJson++;
    continue;
  }
  if (!messages || messages.length === 0) {
    skippedBadJson++;
    continue;
  }
  const model = typeof params.model === 'string' ? params.model : null;
  if (!model) {
    skippedNoModel++;
    continue;
  }

  total++;

  const request: ShadowBrainRequest = { messages };
  if (typeof params.source === 'string') request.source = params.source;
  if (typeof params.temperature === 'number') request.temperature = params.temperature;
  if (typeof params.maxTokens === 'number') request.maxTokens = params.maxTokens;

  const fields: string[] = [];

  // Request side: legacy request → IR → adapter wire body → semantic compare.
  const reqDiff = requestShadowDiff(request, model);
  for (const f of reqDiff.fields) fields.push(`req:${f}`);

  // Response side: LIMITED to fields the traces carry. usage/toolCalls absent
  // from traces → skipped. Text only when finishReason==='stop' and not truncated.
  const finishReason = typeof params.finishReason === 'string' ? params.finishReason : undefined;
  const legacy: ShadowLegacyResult = {};
  if (finishReason !== undefined) legacy.finishReason = finishReason;
  const truncated = typeof row.response_raw === 'string' && row.response_raw.includes('[...truncated');
  if (finishReason === 'stop' && typeof row.response_raw === 'string' && !truncated) {
    legacy.text = row.response_raw;
    responseTextCompared++;
  } else {
    responseTextSkipped++;
  }
  const respDiff = compareShadow(legacy, resultToIR(legacy, `replay-${row.id}`));
  for (const f of respDiff.fields) fields.push(`resp:${f}`);

  if (fields.length > 0) {
    materialCount++;
    for (const f of fields) byField[f] = (byField[f] ?? 0) + 1;
    if (examples.length < 5) examples.push({ trace_id: row.id, fields });
  }
}

const summary = {
  generated_at: new Date().toISOString(),
  db: dbPath,
  limit,
  rows_fetched: rows.length,
  total,
  materialCount,
  materialPct: total > 0 ? Number(((materialCount / total) * 100).toFixed(3)) : 0,
  byField,
  skipped: {
    truncated_prompt_raw: skippedTruncatedPrompt,
    bad_prompt_json: skippedBadJson,
    no_model: skippedNoModel,
  },
  response_side: {
    note: 'usage and toolCalls are not stored in traces.db — skipped; text compared only when finishReason=stop and response_raw not truncated',
    text_compared: responseTextCompared,
    text_skipped: responseTextSkipped,
  },
  examples, // trace ids + field names ONLY — never content
};

writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
