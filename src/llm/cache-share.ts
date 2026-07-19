/**
 * @file cache-share.ts
 * @description BO1 / scorecard-S1 — cache-read token share computation over the
 * durable LLM ledger (`gateway.db` `llm_calls`, see `src/llm/logging.ts`).
 *
 * OpenClaw's headline number was "91.6% of prompt tokens were cache reads by
 * turn 50" — a ~4x input-cost cut driven by a byte-stable cacheable prefix.
 * This module computes the equivalent figure from our own ledger so S1 can be
 * proven with cited evidence.
 *
 * The pure {@link computeCacheShare} takes rows so it is trivially testable with
 * a seeded in-memory ledger; {@link readLedgerRows} pulls the last N rows for a
 * route/session from a better-sqlite3 handle.
 */

import type Database from 'better-sqlite3';

/** One ledger row's cache-relevant fields (subset of `llm_calls`). */
export interface LedgerRow {
  /** Total input/prompt tokens billed for the call (includes any cache reads). */
  tokensIn: number | null;
  /** Cache-read (cached) input tokens for the call. */
  tokensCached: number | null;
  /** Call latency in ms. */
  latencyMs: number | null;
  /** Recorded USD cost of the call. */
  costUsd: number | null;
}

/** Aggregate cache-share result. */
export interface CacheShareResult {
  /** Number of ledger rows (turns) considered. */
  turns: number;
  /** Total cache-read input tokens across the window. */
  cacheReadTokens: number;
  /** Total fresh (non-cached) input tokens = sum(max(tokensIn - tokensCached, 0)). */
  freshInputTokens: number;
  /** cacheReadTokens / totalInputTokens * 100, rounded to 2dp; 0 when no input tokens. */
  cacheReadSharePct: number;
  /** Mean latency in ms over rows that recorded a latency; 0 when none. */
  avgLatencyMs: number;
  /** Total recorded USD cost across the window. */
  costUsd: number;
}

const n = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Compute the cache-read token share and companion metrics from ledger rows.
 * Pure — no I/O. Total input tokens is `sum(tokensIn)`; when a row has cache
 * reads but no recorded tokensIn (shouldn't happen, but be defensive), the
 * cache reads still count toward the denominator so the share cannot exceed 100%.
 */
export function computeCacheShare(rows: readonly LedgerRow[]): CacheShareResult {
  let cacheReadTokens = 0;
  let totalInputTokens = 0;
  let freshInputTokens = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let costUsd = 0;

  for (const r of rows) {
    const inTok = n(r.tokensIn);
    const cached = Math.min(n(r.tokensCached), Math.max(inTok, n(r.tokensCached)));
    cacheReadTokens += cached;
    // Denominator: at least as large as the cache reads so share stays <= 100%.
    const denomContribution = Math.max(inTok, cached);
    totalInputTokens += denomContribution;
    freshInputTokens += Math.max(denomContribution - cached, 0);

    const lat = n(r.latencyMs);
    if (r.latencyMs != null && Number.isFinite(r.latencyMs)) {
      latencySum += lat;
      latencyCount += 1;
    }
    costUsd += n(r.costUsd);
  }

  return {
    turns: rows.length,
    cacheReadTokens,
    freshInputTokens,
    cacheReadSharePct: totalInputTokens > 0 ? round2((cacheReadTokens / totalInputTokens) * 100) : 0,
    avgLatencyMs: latencyCount > 0 ? round2(latencySum / latencyCount) : 0,
    costUsd: round2(costUsd),
  };
}

/** Options for {@link readLedgerRows}. */
export interface ReadLedgerOptions {
  /** Filter by resolved route (exact match on the `route` column). */
  route?: string;
  /** Filter by caller (exact match on the `caller` column). */
  caller?: string;
  /** Filter by purpose (exact match on the `purpose` column), e.g. 'brain.call'. */
  purpose?: string;
  /**
   * Callers to EXCLUDE (e.g. 'consciousness', 'health') so the primary
   * conversational call can be measured apples-to-apples with OpenClaw, free of
   * background/probe traffic that shares the same ledger. Applied as NOT IN.
   */
  excludeCallers?: readonly string[];
  /** Max rows (most recent first by ts). Default 50. */
  limit?: number;
}

/**
 * Read the last N cache-relevant rows from an open `llm_calls` ledger.
 * Newest-first by `ts`; caller reverses if chronological order is wanted.
 */
export function readLedgerRows(db: Database.Database, opts: ReadLedgerOptions = {}): LedgerRow[] {
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.route) {
    where.push('route = :route');
    params['route'] = opts.route;
  }
  if (opts.caller) {
    where.push('caller = :caller');
    params['caller'] = opts.caller;
  }
  if (opts.purpose) {
    where.push('purpose = :purpose');
    params['purpose'] = opts.purpose;
  }
  if (opts.excludeCallers && opts.excludeCallers.length > 0) {
    // Named placeholders per excluded caller — no string interpolation.
    const names = opts.excludeCallers.map((c, i) => {
      const key = `xc${i}`;
      params[key] = c;
      return `:${key}`;
    });
    where.push(`caller NOT IN (${names.join(', ')})`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT tokens_in, tokens_cached, latency_ms, cost_usd
         FROM llm_calls
         ${whereSql}
        ORDER BY ts DESC
        LIMIT :limit`,
    )
    .all(params) as Array<{
    tokens_in: number | null;
    tokens_cached: number | null;
    latency_ms: number | null;
    cost_usd: number | null;
  }>;
  return rows.map((r) => ({
    tokensIn: r.tokens_in,
    tokensCached: r.tokens_cached,
    latencyMs: r.latency_ms,
    costUsd: r.cost_usd,
  }));
}
