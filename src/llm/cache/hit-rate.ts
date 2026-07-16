/**
 * @file src/llm/cache/hit-rate.ts
 * @description Standing observability for the L1 prompt-cache: the per-provider
 * cache-READ rate (cached input tokens / input tokens) over a recent window.
 *
 * Phase 0 concluded L1-only; L1's whole value is prefix cache-reads, but we only
 * logged `tokens_cached` per call and never surfaced the RATE. This turns the
 * ad-hoc gateway.db query into a standing signal so provider-level regressions
 * (e.g. a failover provider that caches far less) are visible at a glance instead
 * of discovered by hand. Diagnostic finding that motivated it (2026-07-16): agent
 * traffic runs mostly on xai/grok at ~31% cache-read vs claude ~59%, gemini ~0%.
 *
 * Cheap + honest, mirrors dup-watch.ts:
 *  - Throttled: recomputes at most every SUDO_CACHE_HIT_CHECK_INTERVAL_MS
 *    (default 15m); the 60s watchdog tick returns the cached verdict otherwise.
 *  - Fail-open: any error → 'healthy' (telemetry, never a liveness gate).
 *  - Informational by default; degrades only if a floor is set
 *    (SUDO_CACHE_HIT_WARN_PCT, default 0 = off) and blended read-rate falls below it.
 *  - Exposes a sync `lastBlendedCacheReadPct()` for the Prometheus scrape path so
 *    getMetrics() never touches the DB.
 *
 * Kill switch: SUDO_CACHE_HIT_WATCH_DISABLE=1.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from '../../core/shared/paths.js';
import type { HealthCheck } from '../../core/health/watchdog.js';

const NAME = 'cache_hit_rate';

function envInt(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw === undefined) return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export interface ProviderCacheStat {
  provider: string;   // alias prefix, e.g. 'xai-oauth', 'claude-oauth', 'google'
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  readPct: number;    // 100 * cachedTokens / inputTokens
}

export interface CacheHitSnapshot {
  blendedPct: number;
  inputTokens: number;
  byProvider: ProviderCacheStat[]; // sorted by inputTokens desc
  windowHours: number;
  computedAt: string;
}

let lastComputeMs = 0;
let cachedCheck: HealthCheck | null = null;
let cachedSnapshot: CacheHitSnapshot | null = null;

function healthy(message: string): HealthCheck {
  return { name: NAME, status: 'healthy', message, lastCheck: new Date().toISOString() };
}

/** Normalise an alias ('xai-oauth/grok-4.5') to its provider prefix ('xai-oauth'). */
function providerOf(alias: string | null): string {
  if (!alias) return 'unknown';
  const i = alias.indexOf('/');
  return i > 0 ? alias.slice(0, i) : alias;
}

/** Recompute the per-provider cache-read rate over the window. Never logs values. */
function compute(): { check: HealthCheck; snapshot: CacheHitSnapshot } {
  const windowHours = envInt('SUDO_CACHE_HIT_WINDOW_HOURS', 24);
  const minSample = envInt('SUDO_CACHE_HIT_MIN_SAMPLE', 20);
  const warnPct = envInt('SUDO_CACHE_HIT_WARN_PCT', 0); // 0 = informational only
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const db = new Database(path.join(DATA_DIR, 'gateway.db'), { readonly: true });
  let rows: Array<{ alias: string | null; tokens_in: number | null; tokens_cached: number | null }>;
  try {
    rows = db
      .prepare('SELECT alias, tokens_in, tokens_cached FROM llm_calls WHERE ts >= ? AND tokens_in > 0')
      .all(cutoff) as Array<{ alias: string | null; tokens_in: number | null; tokens_cached: number | null }>;
  } finally {
    db.close();
  }

  const agg = new Map<string, { calls: number; in: number; cached: number }>();
  let totalIn = 0;
  let totalCached = 0;
  for (const r of rows) {
    const tin = r.tokens_in ?? 0;
    if (tin <= 0) continue;
    const tc = r.tokens_cached ?? 0;
    const p = providerOf(r.alias);
    const a = agg.get(p) ?? { calls: 0, in: 0, cached: 0 };
    a.calls += 1; a.in += tin; a.cached += tc;
    agg.set(p, a);
    totalIn += tin; totalCached += tc;
  }

  const byProvider: ProviderCacheStat[] = [...agg.entries()]
    .map(([provider, a]) => ({ provider, calls: a.calls, inputTokens: a.in, cachedTokens: a.cached, readPct: a.in > 0 ? +(100 * a.cached / a.in).toFixed(1) : 0 }))
    .sort((x, y) => y.inputTokens - x.inputTokens);
  const blendedPct = totalIn > 0 ? +(100 * totalCached / totalIn).toFixed(1) : 0;
  const snapshot: CacheHitSnapshot = { blendedPct, inputTokens: totalIn, byProvider, windowHours, computedAt: new Date().toISOString() };

  const calls = rows.length;
  if (calls < minSample) {
    return { check: healthy(`cache-hit probe: only ${calls} calls with input in ${windowHours}h (<${minSample} min sample) — no signal`), snapshot };
  }
  const perProv = byProvider.map((p) => `${p.provider} ${p.readPct}%`).join(', ');
  const msg = `L1 cache-read: blended ${blendedPct}% over ${(totalIn / 1e6).toFixed(2)}M input tokens (${windowHours}h) — ${perProv}`;
  if (warnPct > 0 && blendedPct < warnPct) {
    return { check: { name: NAME, status: 'degraded', message: `${msg} — below ${warnPct}% floor`, lastCheck: new Date().toISOString() }, snapshot };
  }
  return { check: healthy(msg), snapshot };
}

/**
 * Watchdog runner. Throttled + fail-open. Kill switch: SUDO_CACHE_HIT_WATCH_DISABLE=1.
 */
export async function checkCacheHitRate(): Promise<HealthCheck> {
  if (process.env['SUDO_CACHE_HIT_WATCH_DISABLE'] === '1') {
    return healthy('cache-hit probe disabled (SUDO_CACHE_HIT_WATCH_DISABLE=1)');
  }
  const intervalMs = envInt('SUDO_CACHE_HIT_CHECK_INTERVAL_MS', 900_000); // 15m
  const now = Date.now();
  if (cachedCheck && now - lastComputeMs < intervalMs) {
    return { ...cachedCheck, lastCheck: new Date().toISOString() };
  }
  try {
    const { check, snapshot } = compute();
    cachedCheck = check;
    cachedSnapshot = snapshot;
  } catch (err) {
    cachedCheck = healthy(`cache-hit probe unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  lastComputeMs = now;
  return cachedCheck;
}

/** Sync accessor for the Prometheus scrape path — last computed blended read %, or 0. */
export function lastBlendedCacheReadPct(): number {
  return cachedSnapshot?.blendedPct ?? 0;
}

/** Full last-computed snapshot (per-provider), or null before the first compute. */
export function lastCacheHitSnapshot(): CacheHitSnapshot | null {
  return cachedSnapshot;
}

/** Test hook: clear the throttle cache. */
export function __resetCacheHitWatch(): void {
  lastComputeMs = 0;
  cachedCheck = null;
  cachedSnapshot = null;
}
