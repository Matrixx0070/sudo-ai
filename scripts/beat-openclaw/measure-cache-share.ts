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
 *     [--db data/gateway.db] [--route xai/grok-4.3] [--caller agent] [--purpose brain.call] [--exclude-caller consciousness --exclude-caller health] [--by-turn] [--limit 50]
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
  purpose?: string;
  excludeCallers: string[];
  byTurn: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const dataDir = process.env['DATA_DIR'] ? path.resolve(process.env['DATA_DIR']) : path.resolve('data');
  const out: Args = { db: path.join(dataDir, 'gateway.db'), excludeCallers: [], byTurn: false, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--db' && next) { out.db = next; i++; }
    else if (a === '--route' && next) { out.route = next; i++; }
    else if (a === '--caller' && next) { out.caller = next; i++; }
    else if (a === '--purpose' && next) { out.purpose = next; i++; }
    else if (a === '--exclude-caller' && next) { out.excludeCallers.push(next); i++; }
    else if (a === '--by-turn') { out.byTurn = true; }
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
    const rows = readLedgerRows(db, {
      ...(args.route ? { route: args.route } : {}),
      ...(args.caller ? { caller: args.caller } : {}),
      ...(args.purpose ? { purpose: args.purpose } : {}),
      ...(args.excludeCallers.length > 0 ? { excludeCallers: args.excludeCallers } : {}),
      limit: args.limit,
    });
    const result = computeCacheShare(rows);
    const out: Record<string, unknown> = {
      db: args.db,
      route: args.route ?? null,
      caller: args.caller ?? null,
      purpose: args.purpose ?? null,
      excludeCallers: args.excludeCallers.length > 0 ? args.excludeCallers : null,
      ...result,
    };
    if (args.byTurn) {
      // Oldest-first per-turn progression (rows come newest-first from the ledger).
      out['byTurn'] = [...rows].reverse().map((r, i) => {
        const inTok = typeof r.tokensIn === 'number' ? r.tokensIn : 0;
        const cached = typeof r.tokensCached === 'number' ? r.tokensCached : 0;
        return {
          turn: i,
          tokensIn: inTok,
          tokensCached: cached,
          sharePct: inTok > 0 ? Math.round((cached / inTok) * 1000) / 10 : 0,
        };
      });
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    db.close();
  }
}

main();
