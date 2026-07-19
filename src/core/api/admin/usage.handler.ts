/**
 * @file admin/usage.handler.ts
 * @description BO8 / scorecard-S7 — admin API for the per-day / per-type usage
 * drill-down rendered by the inline admin dashboard.
 *
 * Route:
 *   GET /api/admin/system/usage?window=30d|90d|all&by=caller|purpose|route
 *
 * Reads the LLM ledger (`gateway.db` `llm_calls`) READ-ONLY, hands the rows to
 * the pure roll-up (`src/core/telemetry/usage-rollup.ts`), and returns per-day
 * bars, per-type breakdowns, window totals, and a self-checked drift figure.
 *
 * Read-only over the ledger (S15/S16 untouched): the DB is opened with
 * `readonly: true` and only SELECTs run. Fail-open: any error returns
 * `{ ok:false }` rather than throwing on the request path.
 */

import path from 'node:path';
import { adminRouter, sendJson } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import { DATA_DIR } from '../../shared/paths.js';
import {
  rollupUsage,
  windowStartIso,
  type UsageLedgerRow,
  type UsageWindow,
  type UsageDimension,
} from '../../telemetry/usage-rollup.js';

const log = createLogger('api:admin:usage');

const GATEWAY_DB = path.join(DATA_DIR, 'gateway.db');

function parseWindow(v: string | undefined): UsageWindow {
  return v === '90d' || v === 'all' ? v : '30d';
}

function parseDimension(v: string | undefined): UsageDimension {
  return v === 'purpose' || v === 'route' ? v : 'caller';
}

function parseQuery(url: string | undefined): Record<string, string> {
  if (!url) return {};
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1)).entries()) out[k] = v;
  return out;
}

/**
 * Load the windowed ledger rows read-only. `better-sqlite3` is imported
 * dynamically so this handler module never pulls a native binding into the
 * hot path just by being on the admin route table.
 */
async function loadRows(sinceIso: string | null): Promise<UsageLedgerRow[]> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(GATEWAY_DB, { readonly: true, fileMustExist: true });
  try {
    const sql =
      sinceIso === null
        ? `SELECT ts, caller, purpose, route, tokens_in, tokens_out, tokens_cached, cost_usd
             FROM llm_calls`
        : `SELECT ts, caller, purpose, route, tokens_in, tokens_out, tokens_cached, cost_usd
             FROM llm_calls WHERE ts >= :since`;
    const stmt = db.prepare(sql);
    return (sinceIso === null ? stmt.all() : stmt.all({ since: sinceIso })) as UsageLedgerRow[];
  } finally {
    db.close();
  }
}

adminRouter.get('/api/admin/system/usage', async (req, res) => {
  const q = parseQuery(req.url);
  const window = parseWindow(q['window']);
  const by = parseDimension(q['by']);
  log.debug({ window, by }, 'system/usage requested');
  try {
    const now = new Date();
    const rows = await loadRows(windowStartIso(window, now));
    const rollup = rollupUsage(rows, { window, by, now });
    if (!rollup.drift.ok) {
      log.warn(
        { window, by, costDriftPct: rollup.drift.costDriftPct, tokenDriftPct: rollup.drift.tokenDriftPct },
        'usage roll-up exceeded drift tolerance',
      );
    }
    sendJson(res, 200, { ok: true, data: rollup });
  } catch (err) {
    log.warn({ err: String(err), window, by }, 'system/usage build failed');
    sendJson(res, 200, { ok: false, error: 'usage unavailable' });
  }
});
