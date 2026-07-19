/**
 * BO1 / scorecard-S1 — measure cache-read token share from the LLM ledger.
 *
 * Reads `gateway.db` `llm_calls` (see src/llm/logging.ts) and computes the
 * cache-read share over the last N turns for an optional route/caller, then
 * prints the JSON that proves S1:
 *   { turns, cacheReadTokens, freshInputTokens, cacheReadSharePct, avgLatencyMs, costUsd }
 *
 * Usage (via tsx, from the repo root):
 *   npx tsx scripts/beat-openclaw/measure-cache-share.ts \
 *     [--db data/gateway.db] [--route xai/grok-4.3] [--caller agent-loop] [--limit 50]
 *
 * Read-only. Does not touch the daemon or spend anything.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { computeCacheShare, readLedgerRows } from '../../src/llm/cache-share.js';

interface Args {
  db: string;
  route?: string;
  caller?: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const dataDir = process.env['DATA_DIR'] ? path.resolve(process.env['DATA_DIR']) : path.resolve('data');
  const out: Args = { db: path.join(dataDir, 'gateway.db'), limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--db' && next) { out.db = next; i++; }
    else if (a === '--route' && next) { out.route = next; i++; }
    else if (a === '--caller' && next) { out.caller = next; i++; }
    else if (a === '--limit' && next) { out.limit = Number(next) || 50; i++; }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    console.error(JSON.stringify({ error: `ledger not found: ${args.db}` }));
    process.exit(1);
  }
  const db = new Database(args.db, { readonly: true });
  try {
    const rows = readLedgerRows(db, { route: args.route, caller: args.caller, limit: args.limit });
    const result = computeCacheShare(rows);
    console.log(JSON.stringify({ db: args.db, route: args.route ?? null, caller: args.caller ?? null, ...result }, null, 2));
  } finally {
    db.close();
  }
}

main();
