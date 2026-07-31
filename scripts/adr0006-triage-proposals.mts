/**
 * ADR-0006 one-time triage of pending KAIROS proposals in data/proposals.db.
 *
 * Rule (ADR-0006 Alternative B): a pending proposal whose target files have
 * changed since it was created is stale — the proposed contents were computed
 * against a codebase that no longer exists. Staleness test: any listed file
 * has at least one git commit after the proposal's created_at (or no longer
 * exists). Stale rows are marked status='rejected' (the schema has no 'stale'
 * status) with an explicit reject_reason; nothing is deleted.
 *
 * Usage:  npx tsx scripts/adr0006-triage-proposals.mts [--apply] [--db path]
 * Default is a dry run that prints per-row verdicts and a summary.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const APPLY = process.argv.includes('--apply');
const dbArg = process.argv.indexOf('--db');
const DB_PATH = dbArg > -1 ? process.argv[dbArg + 1]! : path.join(ROOT, 'data', 'proposals.db');

interface Row { id: string; created_at: string; delta_json: string; rationale: string }

function filesChangedSince(files: string[], sinceIso: string): string[] {
  const changed: string[] = [];
  for (const f of files) {
    try {
      const out = execFileSync(
        'git', ['log', '--oneline', '-1', `--since=${sinceIso}`, '--', f],
        { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 },
      ).trim();
      if (out.length > 0) changed.push(f);
    } catch {
      changed.push(f); // unreadable/missing → treat as changed (stale)
    }
  }
  return changed;
}

const db = new Database(DB_PATH);
const rows = db.prepare(
  `SELECT id, created_at, delta_json, rationale FROM proposals WHERE status='pending' ORDER BY created_at`,
).all() as Row[];

let stale = 0, fresh = 0, unparseable = 0, superseded = 0;
const mark = db.prepare(
  `UPDATE proposals SET status='rejected', reject_reason=?, updated_at=? WHERE id=?`,
);

// Pass 1 — exact-duplicate collapse. The pre-latch loop (and the restart bug
// it patched) wrote many byte-identical observations against the same file
// set; only the NEWEST row per file set can possibly be current. Rows are
// created_at-ordered, so the last writer per key wins.
const newestByFileSet = new Map<string, string>();
for (const row of rows) {
  try {
    const delta = JSON.parse(row.delta_json) as { files?: string[] };
    if (delta.files?.length) newestByFileSet.set(JSON.stringify([...delta.files].sort()), row.id);
  } catch { /* handled in pass 2 */ }
}
const dupIds = new Set<string>();
for (const row of rows) {
  try {
    const delta = JSON.parse(row.delta_json) as { files?: string[] };
    const key = delta.files?.length ? JSON.stringify([...delta.files].sort()) : null;
    if (key && newestByFileSet.get(key) !== row.id) dupIds.add(row.id);
  } catch { /* handled in pass 2 */ }
}

for (const row of rows) {
  if (dupIds.has(row.id)) {
    superseded++;
    console.log(`SUPERSEDED (newer duplicate of same file set exists)  ${row.id}`);
    if (APPLY) mark.run('ADR-0006 triage 2026-07-31: superseded — newer pending duplicate targets the identical file set', new Date().toISOString(), row.id);
    continue;
  }
  let files: string[] = [];
  try {
    const delta = JSON.parse(row.delta_json) as { files?: string[]; edits?: { filePath: string }[] };
    files = delta.files ?? delta.edits?.map(e => e.filePath) ?? [];
  } catch { /* fall through to unparseable */ }

  if (files.length === 0) {
    unparseable++;
    console.log(`STALE (no parseable file list)  ${row.id}`);
    if (APPLY) mark.run('ADR-0006 triage 2026-07-31: no parseable target files', new Date().toISOString(), row.id);
    continue;
  }
  const changed = filesChangedSince(files, row.created_at);
  if (changed.length > 0) {
    stale++;
    console.log(`STALE (${changed.length}/${files.length} files changed since ${row.created_at})  ${row.id}`);
    if (APPLY) {
      mark.run(
        `ADR-0006 triage 2026-07-31: stale — computed against pre-change ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? '…' : ''}`,
        new Date().toISOString(), row.id,
      );
    }
  } else {
    fresh++;
    console.log(`FRESH  ${row.id}  (${files.length} files unchanged)`);
  }
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${rows.length} pending → ${superseded} superseded, ${stale} stale, ${unparseable} unparseable (all → rejected), ${fresh} left pending`);
db.close();
