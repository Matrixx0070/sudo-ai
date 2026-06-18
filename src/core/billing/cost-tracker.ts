/**
 * CostTracker — logs every LLM API call with provider, tokens, cost, and latency.
 *
 * Creates an `api_call_log` table in mind.db on first use (idempotent).
 * Uses better-sqlite3 synchronous API. All SQL uses named parameters only —
 * string interpolation in SQL is strictly forbidden.
 *
 * Table: api_call_log
 *   Separate from the existing `api_costs` table so legacy rows are preserved
 *   and this richer schema (latency, success, source) can evolve independently.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { MIND_DB } from '../shared/paths.js';
import { estimateCost as estimateBrainCost } from '../brain/costs.js';

const logger = createLogger('cost-tracker');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApiCallRecord {
  id: string;
  provider: string;           // 'xai' | 'anthropic' | 'google' | 'openai'
  model: string;              // full model ID
  promptTokens: number;       // TOTAL input incl. cached (as the SDK reports)
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  calledAt: string;           // ISO-8601
  source: string;             // 'chat' | 'consciousness' | 'cron' | 'tool'
  // Anthropic prompt-cache split (optional). Persisted so the dashboard's cost
  // reflects the cache discount: cache reads bill ~0.1x, writes ~1.25x. When
  // present, record() computes a cache-discounted cost if one isn't supplied.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface CostSummary {
  total: number;
  byProvider: Record<string, number>;
}

export interface WeeklySummary extends CostSummary {
  byDay: Record<string, number>;   // date string → cost
}

export interface BudgetStatus {
  exceeded: boolean;
  current: number;
  limit: number;
}

export interface ModelStat {
  model: string;
  calls: number;
  totalCost: number;
}

export interface SourceStat {
  source: string;
  calls: number;
  totalCost: number;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Default rolling window of api_call_log history to keep (days). */
const DEFAULT_RETENTION_DAYS = 30;
/** Prune at most this often (ms) — record() is hot (~120 rows/hr from ticks). */
const PRUNE_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Resolve the retention window. `SUDO_COST_RETENTION_DAYS` overrides the
 * default; `0` disables pruning entirely (keep everything). Negative/invalid
 * values fall back to the default.
 */
function resolveRetentionDays(): number {
  const raw = process.env['SUDO_COST_RETENTION_DAYS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

/**
 * Estimate cost in USD for a completed API call.
 *
 * Delegates to the canonical, cache-aware rate model in `brain/costs.ts` (single
 * source of truth — full Anthropic/xAI/OpenAI/Google rate table, claude-oauth/
 * prefix normalisation, and the prompt-cache discount: reads ~0.1x, writes
 * ~1.25x). `promptTokens` is the TOTAL input incl. cached, so passing the cache
 * split here is what makes the dashboard reflect the discount.
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const cost = estimateBrainCost(model, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens);
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 dp
}

// ---------------------------------------------------------------------------
// DDL — created once in mind.db
// ---------------------------------------------------------------------------

const DDL_TABLE = `
  CREATE TABLE IF NOT EXISTS api_call_log (
    id                  TEXT    PRIMARY KEY,
    provider            TEXT    NOT NULL,
    model               TEXT    NOT NULL,
    prompt_tokens       INTEGER NOT NULL DEFAULT 0,
    completion_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens        INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd  REAL    NOT NULL DEFAULT 0,
    latency_ms          INTEGER NOT NULL DEFAULT 0,
    success             INTEGER NOT NULL DEFAULT 1,
    error               TEXT,
    source              TEXT    NOT NULL DEFAULT 'chat',
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    called_at           TEXT    NOT NULL
                          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

// Additive migrations for DBs created before the prompt-cache split columns
// existed. ALTER TABLE ADD COLUMN is idempotent here via the "duplicate column"
// guard in _applyDdl (CREATE TABLE IF NOT EXISTS never adds columns to an
// existing table).
const DDL_MIGRATIONS = [
  `ALTER TABLE api_call_log ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE api_call_log ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0`,
];

const DDL_IDX_CALLED_AT  = `CREATE INDEX IF NOT EXISTS idx_acl_called_at ON api_call_log(called_at)`;
const DDL_IDX_PROVIDER   = `CREATE INDEX IF NOT EXISTS idx_acl_provider   ON api_call_log(provider)`;
const DDL_IDX_MODEL      = `CREATE INDEX IF NOT EXISTS idx_acl_model      ON api_call_log(model)`;
const DDL_IDX_SUCCESS    = `CREATE INDEX IF NOT EXISTS idx_acl_success     ON api_call_log(success)`;

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

/**
 * Tracks every LLM API call with full cost and latency breakdown.
 *
 * Usage — singleton via {@link getCostTracker}:
 * ```ts
 * const tracker = getCostTracker('<project-root>/data/mind.db');
 * tracker.record({ provider: 'xai', model: 'xai/grok-4-1-fast-non-reasoning', ... });
 * ```
 */
export class CostTracker {
  private readonly db: Database.Database;
  /** Epoch ms of the last prune; throttles pruning off the hot record() path. */
  private _lastPrunedAt = 0;

  constructor(dbPath: string) {
    if (!dbPath?.trim()) throw new TypeError('CostTracker: dbPath must be a non-empty string');

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this._applyDdl();
    // Trim any backlog left from before retention existed, once at startup.
    this.prune();
    logger.info({ dbPath, retentionDays: resolveRetentionDays() }, 'CostTracker initialised');
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _applyDdl(): void {
    for (const stmt of [DDL_TABLE, ...DDL_MIGRATIONS, DDL_IDX_CALLED_AT, DDL_IDX_PROVIDER, DDL_IDX_MODEL, DDL_IDX_SUCCESS]) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "duplicate column name" → migration already applied; "already exists"
        // → table/index already present. Both are expected idempotency no-ops.
        if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
          logger.warn({ stmt: stmt.slice(0, 80), err: msg }, 'DDL warning');
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Record a call
  // -------------------------------------------------------------------------

  /**
   * Persist a single API call record.  Fire-and-forget; errors are logged but
   * never propagated to the caller so tracking never blocks the main flow.
   */
  record(call: Omit<ApiCallRecord, 'id' | 'calledAt' | 'estimatedCostUsd'> & { estimatedCostUsd?: number }): void {
    try {
      const id       = randomUUID();
      const calledAt = new Date().toISOString();

      const cacheRead     = call.cacheReadTokens     ?? 0;
      const cacheCreation = call.cacheCreationTokens ?? 0;
      // Trust a supplied cost (the brain already computes a cache-aware one), but
      // when it's omitted, derive a cache-discounted estimate so the dashboard
      // never falls back to billing cached tokens at the full input rate.
      const estimatedCostUsd = call.estimatedCostUsd
        ?? estimateCost(call.model, call.promptTokens ?? 0, call.completionTokens ?? 0, cacheRead, cacheCreation);

      this.db.prepare(`
        INSERT INTO api_call_log
          (id, provider, model, prompt_tokens, completion_tokens, total_tokens,
           estimated_cost_usd, latency_ms, success, error, source,
           cache_read_tokens, cache_creation_tokens, called_at)
        VALUES
          (:id, :provider, :model, :prompt_tokens, :completion_tokens, :total_tokens,
           :estimated_cost_usd, :latency_ms, :success, :error, :source,
           :cache_read_tokens, :cache_creation_tokens, :called_at)
      `).run({
        id,
        provider:           call.provider,
        model:              call.model,
        prompt_tokens:      call.promptTokens      ?? 0,
        completion_tokens:  call.completionTokens  ?? 0,
        total_tokens:       call.totalTokens       ?? 0,
        estimated_cost_usd: estimatedCostUsd,
        latency_ms:         call.latencyMs         ?? 0,
        success:            call.success ? 1 : 0,
        error:              call.error ?? null,
        source:             call.source ?? 'chat',
        cache_read_tokens:     cacheRead,
        cache_creation_tokens: cacheCreation,
        called_at:          calledAt,
      });

      logger.debug({ id, provider: call.provider, model: call.model, cost: estimatedCostUsd }, 'API call recorded');
      this._maybePrune();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'CostTracker.record failed');
    }
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Delete api_call_log rows older than the retention window. Returns the number
   * of rows removed. `retentionDays = 0` is a no-op (retention disabled). Safe to
   * call any time; errors are swallowed so retention never breaks recording.
   *
   * @param retentionDays - Override the resolved window (mainly for tests).
   */
  prune(retentionDays = resolveRetentionDays()): number {
    this._lastPrunedAt = Date.now(); // throttle even when disabled / on error
    if (retentionDays <= 0) return 0; // retention disabled — keep everything
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const info = this.db.prepare(`DELETE FROM api_call_log WHERE called_at < :cutoff`).run({ cutoff });
      const deleted = info.changes ?? 0;
      if (deleted > 0) {
        logger.info({ deleted, retentionDays, cutoff }, 'Pruned old api_call_log rows');
      }
      return deleted;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'CostTracker.prune failed');
      return 0;
    }
  }

  /** Prune at most once per {@link PRUNE_THROTTLE_MS}; called after each insert. */
  private _maybePrune(): void {
    if (Date.now() - this._lastPrunedAt < PRUNE_THROTTLE_MS) return;
    this.prune();
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /** Total cost and breakdown by provider for the current UTC day. */
  getTodayCost(): CostSummary {
    const datePrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return this._buildSummary(`:date_prefix <= called_at AND called_at < :date_end`, {
      date_prefix: datePrefix,
      date_end:    datePrefix.slice(0, 8) + String(Number(datePrefix.slice(8, 10)) + 1).padStart(2, '0'),
    });
  }

  /** Total cost, breakdown by provider, and daily breakdown for the last 7 days. */
  getWeeklyCost(): WeeklySummary {
    interface Row { provider: string; estimated_cost_usd: number; day: string }

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare<{ since: string }, Row>(`
      SELECT provider,
             estimated_cost_usd,
             substr(called_at, 1, 10) AS day
      FROM api_call_log
      WHERE called_at >= :since
    `).all({ since });

    const byProvider: Record<string, number> = {};
    const byDay:      Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      total                       += row.estimated_cost_usd;
      byProvider[row.provider]     = (byProvider[row.provider] ?? 0) + row.estimated_cost_usd;
      byDay[row.day]               = (byDay[row.day]           ?? 0) + row.estimated_cost_usd;
    }

    return { total, byProvider, byDay };
  }

  /** Total cost and breakdown by provider for the current calendar month. */
  getMonthlyCost(): CostSummary {
    const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
    return this._buildSummary(`called_at LIKE :month_pattern`, {
      month_pattern: `${monthPrefix}%`,
    });
  }

  /** Check whether today's spend exceeds a daily USD budget limit. */
  checkBudget(dailyLimit: number): BudgetStatus {
    if (typeof dailyLimit !== 'number' || dailyLimit < 0) {
      throw new RangeError('checkBudget: dailyLimit must be a non-negative number');
    }
    const { total } = this.getTodayCost();
    return { exceeded: total > dailyLimit, current: total, limit: dailyLimit };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /** Return the most recent API call records, newest first. */
  getRecentCalls(limit = 50): ApiCallRecord[] {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    interface Row {
      id: string; provider: string; model: string;
      prompt_tokens: number; completion_tokens: number; total_tokens: number;
      estimated_cost_usd: number; latency_ms: number;
      success: number; error: string | null; source: string; called_at: string;
      cache_read_tokens: number; cache_creation_tokens: number;
    }
    const rows = this.db.prepare<{ limit: number }, Row>(`
      SELECT * FROM api_call_log
      ORDER BY called_at DESC
      LIMIT :limit
    `).all({ limit: safeLimit });

    return rows.map(r => ({
      id:                r.id,
      provider:          r.provider,
      model:             r.model,
      promptTokens:      r.prompt_tokens,
      completionTokens:  r.completion_tokens,
      totalTokens:       r.total_tokens,
      estimatedCostUsd:  r.estimated_cost_usd,
      latencyMs:         r.latency_ms,
      success:           r.success === 1,
      error:             r.error ?? undefined,
      cacheReadTokens:      r.cache_read_tokens ?? 0,
      cacheCreationTokens:  r.cache_creation_tokens ?? 0,
      calledAt:          r.called_at,
      source:            r.source,
    }));
  }

  /** Aggregate calls and total cost per model, sorted by total cost descending. */
  getCostByModel(): ModelStat[] {
    interface Row { model: string; calls: number; totalCost: number }
    return this.db.prepare<[], Row>(`
      SELECT model,
             COUNT(*)                     AS calls,
             SUM(estimated_cost_usd)      AS totalCost
      FROM api_call_log
      GROUP BY model
      ORDER BY totalCost DESC
    `).all() as ModelStat[];
  }

  /** Aggregate calls and total cost per caller source, sorted by cost descending. */
  getCostBySource(): SourceStat[] {
    interface Row { source: string; calls: number; totalCost: number }
    return this.db.prepare<[], Row>(`
      SELECT source,
             COUNT(*)                     AS calls,
             SUM(estimated_cost_usd)      AS totalCost
      FROM api_call_log
      GROUP BY source
      ORDER BY totalCost DESC
    `).all() as SourceStat[];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _buildSummary(whereClause: string, params: Record<string, string>): CostSummary {
    interface Row { provider: string; estimated_cost_usd: number }

    const rows = this.db.prepare<typeof params, Row>(`
      SELECT provider, estimated_cost_usd
      FROM api_call_log
      WHERE ${whereClause}
    `).all(params);

    const byProvider: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      total                   += row.estimated_cost_usd;
      byProvider[row.provider] = (byProvider[row.provider] ?? 0) + row.estimated_cost_usd;
    }

    return { total, byProvider };
  }
}

// ---------------------------------------------------------------------------
// Module-level lazy singleton
// ---------------------------------------------------------------------------

let _instance: CostTracker | null = null;

/**
 * Return the process-wide singleton CostTracker.
 * Creates it on first call using the provided (or default) dbPath.
 */
export function getCostTracker(dbPath = MIND_DB): CostTracker {
  if (!_instance) {
    _instance = new CostTracker(dbPath);
  }
  return _instance;
}
