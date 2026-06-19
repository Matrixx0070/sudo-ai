/**
 * @file trace-store.ts
 * @description SQLite-backed execution trace store for SUDO-AI v4.
 *
 * Replaces the in-memory FailureLearner with persistent trace storage that
 * survives process restarts. Every tool execution, brain call, and routing
 * decision is recorded as a trace record, enabling retrospective analysis,
 * error clustering, and aggregate statistics.
 *
 * Uses SQLite WAL mode for safe concurrent reads/writes. Dynamic import of
 * better-sqlite3 avoids requiring the native addon at module-load time.
 */

import path from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../shared/logger.js';
import { contentHash, genId } from '../shared/utils.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('learning:trace-store');

// ---------------------------------------------------------------------------
// Replay capture (opt-in) — store raw payloads + model params so a run can be
// deterministically replayed. Default OFF (traces otherwise keep only hashes,
// bounding size + avoiding storing sensitive payloads). Per-field size cap
// keeps a captured trace from ballooning traces.db.
// ---------------------------------------------------------------------------

/** Whether raw replay capture is enabled (read per-call so the daemon can toggle). */
export function isTraceCaptureEnabled(): boolean {
  return process.env['SUDO_TRACE_CAPTURE'] === '1';
}

function captureMaxBytes(): number {
  const raw = Number(process.env['SUDO_TRACE_CAPTURE_MAX_BYTES']);
  return Number.isFinite(raw) && raw > 0 ? raw : 16384; // 16 KB default
}

/** Truncate a captured field to the byte cap, annotating how many chars were dropped. */
export function capCaptured(s: string | undefined | null): string | undefined {
  if (s == null) return undefined;
  const max = captureMaxBytes();
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars truncated]` : s;
}

/** Best-effort JSON for an arbitrary value (strings pass through). */
function safeStringify(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceType = 'tool_call' | 'brain_call' | 'routing';
export type IntentCategory = 'coding' | 'analysis' | 'research' | 'fast' | 'blocked';
export type ErrorType = 'timeout' | 'rate_limit' | 'auth' | 'billing' | 'tool_error' | 'refusal';
export type RoutingTier = 'dfa' | 'keyword' | 'llm';

export interface TokenUsage {
  prompt?: number;
  completion?: number;
  total?: number;
}

/** Single trace record. Optional fields map to nullable SQLite columns. */
export interface TraceRecord {
  id?: number;
  traceType: TraceType;
  sessionId?: string;
  model?: string;
  toolName?: string;
  intent?: string;
  category?: IntentCategory;
  success: boolean;
  errorType?: ErrorType;
  errorMessage?: string;
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  routingTier?: RoutingTier;
  routingConfidence?: number;
  argsHash?: string;
  resultHash?: string;
  /**
   * Raw (size-capped) payloads + model params for deterministic replay. Captured
   * only when SUDO_TRACE_CAPTURE=1; otherwise null. Hashes above are always kept.
   */
  argsRaw?: string;
  resultRaw?: string;
  promptRaw?: string;
  responseRaw?: string;
  /** JSON of model sampling params (model/temperature/top_p/seed/max_tokens). */
  modelParams?: string;
  createdAt?: string;
}

/** Query parameters — all optional, ANDed together. */
export interface TraceQuery {
  type?: TraceType;
  model?: string;
  toolName?: string;
  sessionId?: string;
  success?: boolean;
  errorType?: ErrorType;
  since?: string;
  until?: string;
  limit?: number;
}

/** Pre-computed aggregate row. */
export interface TraceAggregate {
  aggregateType: string;
  key: string;
  totalCalls: number;
  successCount: number;
  avgLatencyMs: number;
  lastUpdated: string;
}

/** Error cluster returned by getErrorClusters(). */
export interface ErrorCluster {
  errorType: string;
  toolName: string;
  count: number;
  recentErrors: string[];
}

// ---------------------------------------------------------------------------
// Dynamic import of better-sqlite3
// ---------------------------------------------------------------------------

import type BetterSqlite3T from 'better-sqlite3';

let DatabaseCtor: (new (path: string) => import('better-sqlite3').Database) | null = null;

async function loadDriver(): Promise<typeof BetterSqlite3T> {
  if (DatabaseCtor) return DatabaseCtor as unknown as typeof BetterSqlite3T;
  const mod = await import('better-sqlite3');
  // ESM dynamic import wraps CJS default export in { default: ... }
  DatabaseCtor = (mod.default ?? mod) as typeof BetterSqlite3T;
  return DatabaseCtor as unknown as typeof BetterSqlite3T;
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_TRACES = `
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_type TEXT NOT NULL,
  session_id TEXT,
  model TEXT,
  tool_name TEXT,
  intent TEXT,
  category TEXT,
  success INTEGER NOT NULL,
  error_type TEXT,
  error_message TEXT,
  latency_ms INTEGER,
  token_usage TEXT,
  routing_tier TEXT,
  routing_confidence REAL,
  args_hash TEXT,
  result_hash TEXT,
  args_raw TEXT,
  result_raw TEXT,
  prompt_raw TEXT,
  response_raw TEXT,
  model_params TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_traces_type ON traces(trace_type);
CREATE INDEX IF NOT EXISTS idx_traces_model ON traces(model);
CREATE INDEX IF NOT EXISTS idx_traces_tool ON traces(tool_name);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_success ON traces(success);
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at);
CREATE INDEX IF NOT EXISTS idx_traces_error ON traces(error_type);
`;

const SCHEMA_AGGREGATES = `
CREATE TABLE IF NOT EXISTS trace_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_type TEXT NOT NULL,
  key TEXT NOT NULL,
  total_calls INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  avg_latency_ms REAL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(aggregate_type, key)
);
`;

/**
 * Normalize a timestamp string to SQLite's datetime('now') format
 * ("YYYY-MM-DD HH:MM:SS") so it compares correctly against `traces.created_at`,
 * which is stored in that format (the column DEFAULT is datetime('now')).
 *
 * Accepts ISO 8601 (e.g. "2026-06-08T12:00:00.000Z") and converts it by dropping
 * the 'T' separator, fractional seconds, and trailing 'Z'. An already-normalized
 * (space-separated) value is returned unchanged, so the function is idempotent.
 *
 * Why this matters: ISO strings sort INCORRECTLY against the space format —
 * char 11 is 'T' (0x54) vs ' ' (0x20), so e.g. "2026-06-08 12:00:00" (stored)
 * compares LESS than "2026-06-08T00:00:00.000Z" (an ISO cutoff for the same day),
 * which silently dropped same-date rows from `created_at >=` time-window queries.
 */
export function toSqliteTimestamp(ts: string): string {
  return ts.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, '');
}

/**
 * Resolve the optional aggregation recency window from the raw
 * SUDO_POLICY_AGG_WINDOW_DAYS value, as a SQLite datetime() modifier.
 *
 * Returns a modifier like `-7 days` for a positive integer N (so callers can
 * scope refreshAggregates() to `created_at >= datetime('now', <modifier>)`), or
 * `undefined` (= no window, full-table aggregation, the pre-existing behavior)
 * when the value is unset, blank, zero, negative, fractional, or non-numeric.
 * Fail-open: a malformed value never narrows the window. `0` is rejected on
 * purpose — a zero-day window would exclude essentially every trace.
 */
export function resolveAggWindowModifier(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const days = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(days) || days < 1) return undefined;
  return `-${days} days`;
}

// ---------------------------------------------------------------------------
// TraceStore
// ---------------------------------------------------------------------------

/**
 * Persistent, SQLite-backed execution trace store.
 * Stores every tool call, brain call, and routing decision as a structured
 * trace record. Supports querying by model, tool, session, time range,
 * and success/failure. Maintains pre-computed aggregate tables.
 */
export class TraceStore {
  private db: import('better-sqlite3').Database | null = null;
  private dbPath: string;
  private ready = false;
  private stmtInsertTrace!: import('better-sqlite3').Statement;
  private stmtUpsertAggregate!: import('better-sqlite3').Statement;

  /** @param dbPath - Defaults to `traces.db` inside DATA_DIR. */
  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(DATA_DIR, 'traces.db');
  }

  // -- Lifecycle -------------------------------------------------------------

  /** Open the DB, enable WAL, create schema and prepared statements. */
  async init(): Promise<void> {
    if (this.ready) return;
    const driver = await loadDriver();
    mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new driver(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_TRACES);
    this.db.exec(SCHEMA_AGGREGATES);
    // Additive migration: add the replay-capture columns to a pre-existing
    // traces table (CREATE TABLE IF NOT EXISTS won't alter one that already
    // exists). ALTER TABLE ADD COLUMN is O(1) in SQLite. Idempotent.
    {
      const existing = new Set(
        (this.db.prepare('PRAGMA table_info(traces)').all() as Array<{ name: string }>).map((c) => c.name),
      );
      for (const col of ['args_raw', 'result_raw', 'prompt_raw', 'response_raw', 'model_params']) {
        if (!existing.has(col)) this.db.exec(`ALTER TABLE traces ADD COLUMN ${col} TEXT`);
      }
    }

    this.stmtInsertTrace = this.db.prepare(`
      INSERT INTO traces (
        trace_type, session_id, model, tool_name, intent, category,
        success, error_type, error_message, latency_ms, token_usage,
        routing_tier, routing_confidence, args_hash, result_hash,
        args_raw, result_raw, prompt_raw, response_raw, model_params
      ) VALUES (
        @traceType, @sessionId, @model, @toolName, @intent, @category,
        @success, @errorType, @errorMessage, @latencyMs, @tokenUsage,
        @routingTier, @routingConfidence, @argsHash, @resultHash,
        @argsRaw, @resultRaw, @promptRaw, @responseRaw, @modelParams
      )
    `);

    this.stmtUpsertAggregate = this.db.prepare(`
      INSERT INTO trace_aggregates (aggregate_type, key, total_calls, success_count, avg_latency_ms, last_updated)
      VALUES (@aggregateType, @key, @totalCalls, @successCount, @avgLatencyMs, datetime('now'))
      ON CONFLICT(aggregate_type, key) DO UPDATE SET
        total_calls = excluded.total_calls, success_count = excluded.success_count,
        avg_latency_ms = excluded.avg_latency_ms, last_updated = excluded.last_updated
    `);

    this.ready = true;
    log.info({ path: this.dbPath }, 'TraceStore initialized');
  }

  private ensure(): import('better-sqlite3').Database {
    if (!this.db || !this.ready) {
      throw new Error('TraceStore not initialized — call init() first');
    }
    return this.db;
  }

  // -- Recording -------------------------------------------------------------

  /** Insert a raw trace record. Returns the auto-generated row ID. */
  record(trace: Omit<TraceRecord, 'id' | 'createdAt'>): number {
    this.ensure();
    const info = this.stmtInsertTrace.run({
      traceType: trace.traceType,
      sessionId: trace.sessionId ?? null,
      model: trace.model ?? null,
      toolName: trace.toolName ?? null,
      intent: trace.intent ?? null,
      category: trace.category ?? null,
      success: trace.success ? 1 : 0,
      errorType: trace.errorType ?? null,
      errorMessage: trace.errorMessage ?? null,
      latencyMs: trace.latencyMs ?? null,
      tokenUsage: trace.tokenUsage ? JSON.stringify(trace.tokenUsage) : null,
      routingTier: trace.routingTier ?? null,
      routingConfidence: trace.routingConfidence ?? null,
      argsHash: trace.argsHash ?? null,
      resultHash: trace.resultHash ?? null,
      argsRaw: trace.argsRaw ?? null,
      resultRaw: trace.resultRaw ?? null,
      promptRaw: trace.promptRaw ?? null,
      responseRaw: trace.responseRaw ?? null,
      modelParams: trace.modelParams ?? null,
    });
    return info.lastInsertRowid as number;
  }

  /** Convenience: record a tool call trace. Returns the inserted row ID. */
  recordToolCall(
    sessionId: string, toolName: string, success: boolean, latencyMs: number,
    error?: { type?: ErrorType; message?: string }, args?: unknown, result?: unknown,
  ): number {
    const capture = isTraceCaptureEnabled();
    return this.record({
      traceType: 'tool_call', sessionId, toolName, success, latencyMs,
      errorType: error?.type, errorMessage: error?.message,
      argsHash: args != null ? contentHash(JSON.stringify(args)) : undefined,
      resultHash: result != null ? contentHash(JSON.stringify(result)) : undefined,
      // Raw args/result captured only under SUDO_TRACE_CAPTURE=1 (size-capped) —
      // turns the trace from "fact-of-call" into something replay-capable.
      argsRaw: capture ? capCaptured(safeStringify(args)) : undefined,
      resultRaw: capture ? capCaptured(safeStringify(result)) : undefined,
    });
  }

  /** Convenience: record a brain (LLM) call trace. Returns the inserted row ID. */
  recordBrainCall(
    sessionId: string, model: string, success: boolean, latencyMs: number,
    tokenUsage?: TokenUsage, error?: { type?: ErrorType; message?: string },
  ): number {
    return this.record({
      traceType: 'brain_call', sessionId, model, success, latencyMs,
      tokenUsage, errorType: error?.type, errorMessage: error?.message,
    });
  }

  /** Convenience: record a routing decision trace. Returns the inserted row ID. */
  recordRouting(
    sessionId: string, model: string, category: IntentCategory,
    tier: RoutingTier, confidence: number,
  ): number {
    return this.record({
      traceType: 'routing', sessionId, model, category,
      routingTier: tier, routingConfidence: confidence, success: true,
    });
  }

  // -- Querying --------------------------------------------------------------

  /** Query traces with flexible ANDed filters. Results ordered newest-first. */
  query(q: TraceQuery): TraceRecord[] {
    const db = this.ensure();
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (q.type)      { clauses.push('trace_type = @type');      params.type = q.type; }
    if (q.model)     { clauses.push('model = @model');         params.model = q.model; }
    if (q.toolName)  { clauses.push('tool_name = @toolName');  params.toolName = q.toolName; }
    if (q.sessionId) { clauses.push('session_id = @sessionId'); params.sessionId = q.sessionId; }
    if (q.success !== undefined) { clauses.push('success = @success'); params.success = q.success ? 1 : 0; }
    if (q.errorType) { clauses.push('error_type = @errorType'); params.errorType = q.errorType; }
    // Normalize cutoffs to created_at's SQLite datetime format so ISO callers
    // (e.g. TraceAnalyzer) don't silently mis-compare against the stored value.
    if (q.since)     { clauses.push('created_at >= @since');    params.since = toSqliteTimestamp(q.since); }
    if (q.until)     { clauses.push('created_at <= @until');    params.until = toSqliteTimestamp(q.until); }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM traces ${where} ORDER BY created_at DESC LIMIT ${q.limit ?? 500}`
    ).all(params) as Record<string, unknown>[];

    return rows.map(rowToTraceRecord);
  }

  // -- Aggregates ------------------------------------------------------------

  /** Retrieve pre-computed aggregates, optionally filtered by type/key pattern. */
  getAggregates(type?: string, keyPattern?: string): TraceAggregate[] {
    const db = this.ensure();
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (type)       { clauses.push('aggregate_type = @type');  params.type = type; }
    if (keyPattern) { clauses.push('key LIKE @keyPattern');    params.keyPattern = keyPattern; }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM trace_aggregates ${where} ORDER BY last_updated DESC`
    ).all(params) as Record<string, unknown>[];

    return rows.map(r => ({
      aggregateType: r.aggregate_type as string,
      key: r.key as string,
      totalCalls: r.total_calls as number,
      successCount: r.success_count as number,
      avgLatencyMs: r.avg_latency_ms as number,
      lastUpdated: r.last_updated as string,
    }));
  }

  /**
   * Recompute aggregate tables from raw traces.
   * Types: model_tool, model_category, tool_error. Runs in a transaction.
   */
  refreshAggregates(): void {
    const db = this.ensure();

    // Optional recency window (SUDO_POLICY_AGG_WINDOW_DAYS, default OFF): when set,
    // the GROUP BYs scan only traces newer than the window instead of the entire
    // table, so a refresh over a very large trace store doesn't block for long.
    // The cutoff is computed in SQL via datetime('now', @window) so it matches the
    // datetime('now') format of created_at and uses the idx_traces_created index.
    // Unset/invalid => no clause => full-table aggregation (prior behavior).
    const windowMod = resolveAggWindowModifier(process.env['SUDO_POLICY_AGG_WINDOW_DAYS']);
    const windowSql = windowMod ? " AND created_at >= datetime('now', @window)" : '';
    const queryRows = (sql: string): Record<string, unknown>[] =>
      (windowMod ? db.prepare(sql).all({ window: windowMod }) : db.prepare(sql).all()) as Record<string, unknown>[];

    const tx = db.transaction(() => {
      // model_tool: per (model, tool) pair
      for (const r of queryRows(`
        SELECT model, tool_name,
               COUNT(*) AS total_calls, SUM(success) AS success_count,
               AVG(CAST(latency_ms AS REAL)) AS avg_latency_ms
        FROM traces WHERE model IS NOT NULL AND tool_name IS NOT NULL${windowSql}
        GROUP BY model, tool_name
      `)) {
        this.stmtUpsertAggregate.run({
          aggregateType: 'model_tool',
          key: `${r.model}:${r.tool_name}`,
          totalCalls: r.total_calls, successCount: r.success_count,
          avgLatencyMs: r.avg_latency_ms ?? 0,
        });
      }

      // model_category: per (model, category) pair
      for (const r of queryRows(`
        SELECT model, category,
               COUNT(*) AS total_calls, SUM(success) AS success_count,
               AVG(CAST(latency_ms AS REAL)) AS avg_latency_ms
        FROM traces WHERE model IS NOT NULL AND category IS NOT NULL${windowSql}
        GROUP BY model, category
      `)) {
        this.stmtUpsertAggregate.run({
          aggregateType: 'model_category',
          key: `${r.model}:${r.category}`,
          totalCalls: r.total_calls, successCount: r.success_count,
          avgLatencyMs: r.avg_latency_ms ?? 0,
        });
      }

      // tool_error: per (tool, error_type) pair
      for (const r of queryRows(`
        SELECT tool_name, error_type, COUNT(*) AS total_calls
        FROM traces WHERE tool_name IS NOT NULL AND error_type IS NOT NULL${windowSql}
        GROUP BY tool_name, error_type
      `)) {
        this.stmtUpsertAggregate.run({
          aggregateType: 'tool_error',
          key: `${r.tool_name}:${r.error_type}`,
          totalCalls: r.total_calls, successCount: 0, avgLatencyMs: 0,
        });
      }
    });

    tx();
    log.info({ window: windowMod ?? 'all' }, 'Aggregates refreshed');
  }

  // -- Error analysis --------------------------------------------------------

  /**
   * Group recent errors by (errorType, toolName) with occurrence counts
   * and sample error messages. Defaults to last 24 hours.
   */
  getErrorClusters(since?: string): ErrorCluster[] {
    const db = this.ensure();
    // Normalize to created_at's SQLite datetime format (an ISO default/arg would
    // mis-compare against the space-separated stored value — see toSqliteTimestamp).
    const cutoff = toSqliteTimestamp(since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const groups = db.prepare(`
      SELECT error_type, tool_name, COUNT(*) AS cnt
      FROM traces
      WHERE success = 0 AND error_type IS NOT NULL AND created_at >= @cutoff
      GROUP BY error_type, tool_name ORDER BY cnt DESC LIMIT 50
    `).all({ cutoff }) as Record<string, unknown>[];

    const clusters: ErrorCluster[] = [];
    for (const g of groups) {
      const recentRows = db.prepare(`
        SELECT error_message FROM traces
        WHERE success = 0 AND error_type = @errorType AND tool_name = @toolName
          AND created_at >= @cutoff AND error_message IS NOT NULL
        ORDER BY created_at DESC LIMIT 5
      `).all({
        errorType: g.error_type, toolName: g.tool_name, cutoff,
      }) as Record<string, unknown>[];

      clusters.push({
        errorType: g.error_type as string,
        toolName: g.tool_name as string,
        count: g.cnt as number,
        recentErrors: recentRows.map(r => String(r.error_message)).filter(Boolean),
      });
    }
    return clusters;
  }

  // -- Counting --------------------------------------------------------------

  /** Count traces, optionally filtered by type and/or time lower bound. */
  count(type?: TraceType, since?: string): number {
    const db = this.ensure();
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (type)  { clauses.push('trace_type = @type');  params.type = type; }
    // Normalize like query()/getErrorClusters() so an ISO since compares correctly
    // against the space-format created_at (see toSqliteTimestamp).
    if (since) { clauses.push('created_at >= @since'); params.since = toSqliteTimestamp(since); }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM traces ${where}`
    ).get(params) as Record<string, unknown>;

    return (row.cnt as number) ?? 0;
  }

  // -- Cleanup ---------------------------------------------------------------

  /** Close the database connection. Safe to call multiple times. */
  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* may already be closed */ }
      this.db = null;
      this.ready = false;
      log.info('TraceStore closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Row mapper: snake_case DB row -> camelCase TraceRecord
// ---------------------------------------------------------------------------

function rowToTraceRecord(row: Record<string, unknown>): TraceRecord {
  return {
    id: row.id as number | undefined,
    traceType: row.trace_type as TraceType,
    sessionId: row.session_id as string | undefined,
    model: row.model as string | undefined,
    toolName: row.tool_name as string | undefined,
    intent: row.intent as string | undefined,
    category: row.category as IntentCategory | undefined,
    success: (row.success as number) === 1,
    errorType: row.error_type as ErrorType | undefined,
    errorMessage: row.error_message as string | undefined,
    latencyMs: row.latency_ms as number | undefined,
    tokenUsage: row.token_usage ? JSON.parse(row.token_usage as string) as TokenUsage : undefined,
    routingTier: row.routing_tier as RoutingTier | undefined,
    routingConfidence: row.routing_confidence as number | undefined,
    argsHash: row.args_hash as string | undefined,
    resultHash: row.result_hash as string | undefined,
    argsRaw: (row.args_raw as string | null) ?? undefined,
    resultRaw: (row.result_raw as string | null) ?? undefined,
    promptRaw: (row.prompt_raw as string | null) ?? undefined,
    responseRaw: (row.response_raw as string | null) ?? undefined,
    modelParams: (row.model_params as string | null) ?? undefined,
    createdAt: row.created_at as string | undefined,
  };
}