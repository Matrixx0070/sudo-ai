/**
 * One-off backfill: populate content_sha256 for existing llm_calls rows so the
 * Phase-0 ceiling probe has data today (vs waiting 72h). Idempotent — only
 * touches rows where content_sha256 IS NULL. Safe against the live daemon:
 * busy_timeout + single ALTER (fast, no table rewrite) + row UPDATEs.
 *
 * CAVEAT: fingerprints here are computed from the STORED (redacted) ir_request,
 * whereas live record() fingerprints the RAW IR. They coincide except on rows
 * where redaction actually fired — acceptable for a measurement backfill.
 *
 *   npx tsx bench/phase0-backfill.mts [dbPath]
 */
import Database from 'better-sqlite3';
import { contentFingerprint } from '../src/llm/cache/canonical.js';
import type { IRRequest } from '../shared-types/ir/v1.js';

const dbPath = process.argv[2] ?? 'data/gateway.db';
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');

const cols = new Set((db.prepare('PRAGMA table_info(llm_calls)').all() as Array<{ name: string }>).map((c) => c.name));
if (!cols.has('content_sha256')) {
  db.exec('ALTER TABLE llm_calls ADD COLUMN content_sha256 TEXT');
  console.log('added content_sha256 column');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_llm_calls_content ON llm_calls(content_sha256)');

const rows = db.prepare('SELECT trace_id, ir_request FROM llm_calls WHERE content_sha256 IS NULL AND ir_request IS NOT NULL').all() as Array<{ trace_id: string; ir_request: string }>;
const upd = db.prepare('UPDATE llm_calls SET content_sha256 = :fp WHERE trace_id = :id');
let done = 0, skip = 0;
const tx = db.transaction((batch: typeof rows) => {
  for (const r of batch) {
    try { upd.run({ fp: contentFingerprint(JSON.parse(r.ir_request) as IRRequest), id: r.trace_id }); done++; }
    catch { skip++; }
  }
});
tx(rows);
const remaining = (db.prepare('SELECT count(*) n FROM llm_calls WHERE content_sha256 IS NULL').get() as { n: number }).n;
db.close();
console.log(JSON.stringify({ candidates: rows.length, backfilled: done, skipped: skip, still_null: remaining }));
