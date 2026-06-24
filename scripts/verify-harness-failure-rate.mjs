#!/usr/bin/env node
/**
 * verify-harness-failure-rate.mjs
 *
 * Measures whether the Mythos harness slices (A: behavioral layer, B: JSON
 * repair + structured tool-error hints, C: uniform tool-use discipline) reduce
 * the failure classes they target — split BEFORE vs AFTER a deploy boundary.
 *
 * Why these data sources:
 *  - PRIMARY: data/exec-audit.jsonl — append-only, one row per repo-exec attempt
 *    with {at, allowed, reason}. NOT compacted, so it's a stable denominator for
 *    the dominant failure surface (shell/system.exec friction). We report the
 *    REFUSAL RATE (refused / total) and a by-reason breakdown. Slices B/C should
 *    drive the metacharacter / not-allowlisted refusals DOWN.
 *  - SECONDARY: mind.db failure_log — denominator-free SHARE of failures that
 *    are "preventable" (allowlist/pipe + bad-args/path). Robust to the
 *    messages-table compaction problem. Should drop if the slices work.
 *
 * Read-only. Usage:
 *   node scripts/verify-harness-failure-rate.mjs [--boundary=ISO] [--db=path] [--audit=path]
 * Default boundary is the slice-C deploy time.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DEFAULTS = {
  boundary: '2026-06-24T00:26:05Z', // slice-C (uniform discipline) deploy
  db: 'data/mind.db',
  audit: 'data/exec-audit.jsonl',
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function classifyExecReason(reason) {
  const r = (reason || '').toLowerCase();
  if (r.includes('metacharacter')) return 'metacharacters';
  if (r.includes('allowlist') || r.includes('not a repo-allowlisted')) return 'not_allowlisted';
  if (r.includes('sudo_repo_exec') || r.includes('not set')) return 'flag_not_set'; // config, not model behaviour
  return 'other';
}

function execAuditStats(path, boundaryMs) {
  let lines = [];
  try {
    lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return null;
  }
  const blank = () => ({ total: 0, refused: 0, byReason: { metacharacters: 0, not_allowlisted: 0, flag_not_set: 0, other: 0 } });
  const before = blank();
  const after = blank();
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o.at ?? '');
    if (Number.isNaN(ts)) continue;
    const bucket = ts < boundaryMs ? before : after;
    bucket.total++;
    if (o.allowed === false) {
      bucket.refused++;
      bucket.byReason[classifyExecReason(o.reason)]++;
    }
  }
  return { before, after };
}

function sqlite(db, sql) {
  return execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();
}

function failureLogStats(db, boundaryIso) {
  // Same keyword buckets used in the manual analysis. occurred_at is ISO.
  const sql = (cmp) => `SELECT
    SUM(CASE WHEN error LIKE '%metacharacters%' OR error LIKE '%allowlist%' OR error LIKE '%not a repo-allowlisted%' THEN 1 ELSE 0 END),
    SUM(CASE WHEN error LIKE '%unrecognized%' OR error LIKE '%invalid%' OR error LIKE '%unknown flag%' OR error LIKE '%no such%' OR error LIKE '%not found%' THEN 1 ELSE 0 END),
    SUM(CASE WHEN error LIKE '%stuck%' OR error LIKE '%loop%' OR error LIKE '%max iter%' OR error LIKE '%exhaust%' THEN 1 ELSE 0 END),
    COUNT(*)
    FROM failure_log WHERE occurred_at ${cmp} '${boundaryIso}';`;
  const parse = (row) => {
    const [allow, badarg, stuck, total] = row.split('|').map((x) => Number(x) || 0);
    return { allowlist_or_pipe: allow, bad_args_or_path: badarg, stuck_or_loop: stuck, total };
  };
  try {
    return { before: parse(sqlite(db, sql("<"))), after: parse(sqlite(db, sql(">="))) };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

function pct(n, d) {
  return d > 0 ? `${((100 * n) / d).toFixed(1)}%` : 'n/a';
}

const args = parseArgs(process.argv);
const boundaryMs = Date.parse(args.boundary);
if (Number.isNaN(boundaryMs)) {
  console.error(`Invalid --boundary: ${args.boundary}`);
  process.exit(1);
}

console.log('='.repeat(72));
console.log('HARNESS FAILURE-RATE VERIFICATION');
console.log(`boundary (deploy): ${args.boundary}`);
console.log(`sources: ${args.audit} (primary) + ${args.db} failure_log (secondary)`);
console.log('='.repeat(72));

const exec = execAuditStats(args.audit, boundaryMs);
console.log('\n## PRIMARY — repo-exec refusal rate (exec-audit.jsonl)');
if (!exec) {
  console.log('  exec-audit.jsonl not found.');
} else {
  for (const [label, b] of [['BEFORE', exec.before], ['AFTER ', exec.after]]) {
    const modelRefusals = b.byReason.metacharacters + b.byReason.not_allowlisted;
    console.log(
      `  ${label}: attempts=${b.total} refused=${b.refused} (${pct(b.refused, b.total)}) | ` +
      `model-fixable[metachar+not-allowlisted]=${modelRefusals} (${pct(modelRefusals, b.total)}) | ` +
      `metachar=${b.byReason.metacharacters} not-allowlisted=${b.byReason.not_allowlisted} flag-not-set=${b.byReason.flag_not_set} other=${b.byReason.other}`,
    );
  }
  console.log('  ↳ success = AFTER model-fixable refusal % is materially below BEFORE.');
}

const fail = failureLogStats(args.db, args.boundary);
console.log('\n## SECONDARY — preventable share of failure_log');
if (fail.error) {
  console.log(`  query failed: ${fail.error}`);
} else {
  for (const [label, b] of [['BEFORE', fail.before], ['AFTER ', fail.after]]) {
    const preventable = b.allowlist_or_pipe + b.bad_args_or_path;
    console.log(
      `  ${label}: failures=${b.total} preventable[allowlist+badarg]=${preventable} (${pct(preventable, b.total)}) | ` +
      `stuck/loop=${b.stuck_or_loop} (${pct(b.stuck_or_loop, b.total)})`,
    );
  }
  console.log('  ↳ success = AFTER preventable % below BEFORE; stuck/loop confirms swarm-rescue is low-value.');
}

console.log('\nNOTE: keyword buckets are heuristic; the signal (not the decimal) is what matters.');
console.log('Re-run this after several days of post-deploy traffic to populate the AFTER columns.');
