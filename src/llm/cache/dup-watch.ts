/**
 * @file src/llm/cache/dup-watch.ts
 * @description Watchdog check: alert if the exact-duplicate rate of REAL gateway
 * requests climbs. Phase 0 concluded L1-only because genuine byte-exact dup is
 * ~1% on current traffic; this is the tripwire that tells us if that changes
 * (e.g. stateless/temp==0 tenant traffic appears) and an L2 cache becomes worth
 * building. See bench/ceiling-report.json.
 *
 * Cheap + honest:
 *  - Throttled: recomputes at most every SUDO_CACHE_DUP_CHECK_INTERVAL_MS
 *    (default 6h); returns the cached verdict between recomputes so the 60s
 *    watchdog tick stays free.
 *  - Measures the SAME honest signal as the ceiling probe: exact-dup % over
 *    FULL-IR, successful rows only (stub-logged rows are excluded — their
 *    fingerprints collapse and fake duplicates).
 *  - Fail-open: any error → 'healthy' (this is telemetry, never a liveness gate).
 *
 * status: 'degraded' when dup% ≥ SUDO_CACHE_DUP_WARN_PCT (default 15 — an early
 * warning well under the 30% build-decision threshold). The watchdog's alert
 * policy requires 3 consecutive degraded ticks + cooldown before it pages.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from '../../core/shared/paths.js';
import { contentFingerprint } from './canonical.js';
import type { IRRequest } from '../../../shared-types/ir/v1.js';
import type { HealthCheck } from '../../core/health/watchdog.js';

const NAME = 'cache_dup_rate';

function envInt(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw === undefined) return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

let lastComputeMs = 0;
let cached: HealthCheck | null = null;

function healthy(message: string): HealthCheck {
  return { name: NAME, status: 'healthy', message, lastCheck: new Date().toISOString() };
}

/** Recompute the honest exact-dup rate over full-IR successful rows in a window. */
function compute(): HealthCheck {
  const warnPct = envInt('SUDO_CACHE_DUP_WARN_PCT', 15);
  const minSample = envInt('SUDO_CACHE_DUP_MIN_SAMPLE', 50);
  const windowDays = envInt('SUDO_CACHE_DUP_WINDOW_DAYS', 7);
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const db = new Database(path.join(DATA_DIR, 'gateway.db'), { readonly: true });
  let rows: Array<{ ir_request: string | null; error_class: string | null }>;
  try {
    rows = db
      .prepare('SELECT ir_request, error_class FROM llm_calls WHERE ts >= ? AND ir_request IS NOT NULL')
      .all(cutoff) as Array<{ ir_request: string | null; error_class: string | null }>;
  } finally {
    db.close();
  }

  const fp = new Map<string, number>();
  for (const r of rows) {
    if (r.error_class) continue; // successful only — never cache non-2xx
    if (!r.ir_request) continue;
    let ir: IRRequest;
    try { ir = JSON.parse(r.ir_request) as IRRequest; } catch { continue; }
    if (!Array.isArray((ir as { messages?: unknown }).messages)) continue; // full IR only (skip stubs)
    const k = contentFingerprint(ir);
    fp.set(k, (fp.get(k) ?? 0) + 1);
  }

  const total = [...fp.values()].reduce((a, b) => a + b, 0);
  const distinct = fp.size;
  const dupPct = total > 0 ? +(100 * (total - distinct) / total).toFixed(1) : 0;

  if (total < minSample) {
    return healthy(`dup-rate probe: only ${total} full-IR successful rows in ${windowDays}d (<${minSample} min sample) — no signal`);
  }
  const msg = `exact-dup ${dupPct}% over ${total} full-IR successful rows (${distinct} distinct, ${windowDays}d window)`;
  if (dupPct >= warnPct) {
    return { name: NAME, status: 'degraded', message: `${msg} — ≥${warnPct}% warn threshold; L2 cache may now be worth building (see bench/ceiling-report.json)`, lastCheck: new Date().toISOString() };
  }
  return healthy(`${msg} — below ${warnPct}% threshold, L1-only stands`);
}

/**
 * Watchdog runner. Throttled + fail-open. Kill switch:
 * SUDO_CACHE_DUP_WATCH_DISABLE=1.
 */
export async function checkCacheDupRate(): Promise<HealthCheck> {
  if (process.env['SUDO_CACHE_DUP_WATCH_DISABLE'] === '1') {
    return healthy('dup-rate probe disabled (SUDO_CACHE_DUP_WATCH_DISABLE=1)');
  }
  const intervalMs = envInt('SUDO_CACHE_DUP_CHECK_INTERVAL_MS', 21_600_000); // 6h
  const now = Date.now();
  if (cached && now - lastComputeMs < intervalMs) {
    return { ...cached, lastCheck: new Date().toISOString() };
  }
  try {
    cached = compute();
  } catch (err) {
    // fail-open — telemetry must never make the daemon look unhealthy
    cached = healthy(`dup-rate probe unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  lastComputeMs = now;
  return cached;
}

/** Test hook: clear the throttle cache. */
export function __resetCacheDupWatch(): void {
  lastComputeMs = 0;
  cached = null;
}
