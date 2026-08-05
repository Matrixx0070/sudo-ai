/**
 * @file agent/mission/spend.ts
 * @description What one mission step actually cost.
 *
 * A mission spans many runs over days, so its budget can only be tracked by
 * accumulating real per-run cost. The gateway already logs `cost_usd` for every
 * LLM call it brokers (data/gateway.db llm_calls), so this reads that ledger
 * rather than introducing a parallel counter that could drift from it.
 *
 * Fail-open by design: an unreadable ledger returns 0 and the mission keeps
 * running. Under-counting spend is a reporting problem; refusing to advance a
 * mission because a stats DB is locked would be a correctness problem.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../../shared/paths.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('agent:mission:spend');

const GATEWAY_DB = path.join(DATA_DIR, 'gateway.db');

/**
 * Total USD across LLM calls logged at or after `sinceIso`.
 * Returns 0 when the ledger is missing, locked, or empty.
 */
export function spendSince(sinceIso: string): number {
  try {
    if (!existsSync(GATEWAY_DB)) return 0;
    const db = new Database(GATEWAY_DB, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE ts >= ?')
        .get(sinceIso) as { total: number } | undefined;
      const total = typeof row?.total === 'number' && Number.isFinite(row.total) ? row.total : 0;
      return Math.max(0, total);
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'mission spend read failed — counting 0 (non-fatal)');
    return 0;
  }
}
