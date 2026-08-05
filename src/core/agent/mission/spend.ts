/**
 * @file agent/mission/spend.ts
 * @description REAL metered spend for a mission — dollars that actually leave
 * the account.
 *
 * A mission budget must be denominated in real money, and the gateway ledger
 * (`data/gateway.db llm_calls.cost_usd`) is the only place that holds it. That
 * column is deliberately 0/NULL for flat-subscription lanes — `limits.ts`
 * SEAT_PROVIDERS prices `claude-oauth/` and `ollama/` at zero because those
 * calls are covered by a seat, not billed per token.
 *
 * That zero is NOT a gap to fill. Filling it has taken this system down twice
 * (documented at limits.ts:288): 418 claude-oauth calls booked as "$51" blew a
 * $50 daily cap and degraded free calls all afternoon; ollama `:cloud` models
 * falling through to default pricing booked ~$473 of phantom spend in five days
 * and turned a spend cap into a total product outage.
 *
 * The first version of this file was deleted and replaced with the agent loop's
 * `usage.estimatedCost`, which is the NOTIONAL list-price equivalent
 * (brain/costs.ts maps `claude-oauth/*` onto Anthropic rates on purpose, for
 * reporting). That re-created the phantom-dollar bug at mission scope: a
 * research mission was parked at "$8.80 of $5.00" having spent $0 of real
 * money. Hence the restore, with this comment so it does not happen a third
 * time.
 *
 * Volume on seat lanes is bounded elsewhere and correctly: the policy layer's
 * daily seat CALL ceiling (policy.ts seatCallLimit), plus a mission's own plan
 * length and per-step attempt caps.
 *
 * Fail-open: an unreadable ledger returns 0 rather than stalling a mission.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../../shared/paths.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('agent:mission:spend');

const GATEWAY_DB = path.join(DATA_DIR, 'gateway.db');

/**
 * Real metered USD across LLM calls logged at or after `sinceIso`.
 * Subscription-seat lanes contribute 0 by design (see the file header).
 */
export function meteredSpendSince(sinceIso: string): number {
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
    log.warn({ err: String(err) }, 'mission metered-spend read failed — counting 0 (non-fatal)');
    return 0;
  }
}
