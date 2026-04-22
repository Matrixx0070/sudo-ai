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

const logger = createLogger('cost-tracker');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApiCallRecord {
  id: string;
  provider: string;           // 'xai' | 'anthropic' | 'google' | 'openai'
  model: string;              // full model ID
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  calledAt: string;           // ISO-8601
  source: string;             // 'chat' | 'consciousness' | 'cron' | 'tool'
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

// ---------------------------------------------------------------------------
// Pricing table  (USD per million tokens, input / output)
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'xai/grok-4-1-fast-non-reasoning': { input: 0.20,  output: 0.50  },
  'xai/grok-4-fast-reasoning':        { input: 2.00,  output: 10.00 },
  'openai/gpt-4o':                    { input: 2.50,  output: 10.00 },
  'google/gemini-2.5-flash':          { input: 0.15,  output: 0.60  },
  // Free via Max subscription — cost = 0
  'anthropic/claude-sonnet-4-20250514': { input: 0,   output: 0     },
};

/**
 * Estimate cost in USD for a completed API call.
 * Falls back to zero if the model is not in the pricing table.
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  const inputCost  = (promptTokens     / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 dp
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
    called_at           TEXT    NOT NULL
                          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

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
 * const tracker = getCostTracker('/root/sudo-ai-v4/data/mind.db');
 * tracker.record({ provider: 'xai', model: 'xai/grok-4-1-fast-non-reasoning', ... });
 * ```
 */
export class CostTracker {
  private readonly db: Database.Database;

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
    logger.info({ dbPath }, 'CostTracker initialised');
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _applyDdl(): void {
    for (const stmt of [DDL_TABLE, DDL_IDX_CALLED_AT, DDL_IDX_PROVIDER, DDL_IDX_MODEL, DDL_IDX_SUCCESS]) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
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
  record(call: Omit<ApiCallRecord, 'id' | 'calledAt'>): void {
    try {
      const id       = randomUUID();
      const calledAt = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO api_call_log
          (id, provider, model, prompt_tokens, completion_tokens, total_tokens,
           estimated_cost_usd, latency_ms, success, error, source, called_at)
        VALUES
          (:id, :provider, :model, :prompt_tokens, :completion_tokens, :total_tokens,
           :estimated_cost_usd, :latency_ms, :success, :error, :source, :called_at)
      `).run({
        id,
        provider:           call.provider,
        model:              call.model,
        prompt_tokens:      call.promptTokens      ?? 0,
        completion_tokens:  call.completionTokens  ?? 0,
        total_tokens:       call.totalTokens       ?? 0,
        estimated_cost_usd: call.estimatedCostUsd  ?? 0,
        latency_ms:         call.latencyMs         ?? 0,
        success:            call.success ? 1 : 0,
        error:              call.error ?? null,
        source:             call.source ?? 'chat',
        called_at:          calledAt,
      });

      logger.debug({ id, provider: call.provider, model: call.model, cost: call.estimatedCostUsd }, 'API call recorded');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'CostTracker.record failed');
    }
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
export function getCostTracker(dbPath = '/root/sudo-ai-v4/data/mind.db'): CostTracker {
  if (!_instance) {
    _instance = new CostTracker(dbPath);
  }
  return _instance;
}
