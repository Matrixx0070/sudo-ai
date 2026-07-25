/**
 * gw-refactor Phase 5: GatewayCallLog — durable per-call ledger for the LLM
 * gateway, persisted to its own SQLite file (`gateway.db`).
 *
 * Every gateway call gets exactly one row keyed by trace_id, carrying the
 * redacted IR request/response, routing metadata, latency/token/cost figures,
 * and a sha256 of the exact final provider wire payload. `markOutcome()` later
 * stamps the row with a downstream outcome signal.
 *
 * Modeled on src/core/billing/cost-tracker.ts (WAL + NORMAL sync + idempotent
 * DDL with 'already exists'/'duplicate column' swallow) and the busy_timeout +
 * PRAGMA table_info ALTER-guard idiom in src/core/learning/trace-store.ts.
 *
 * Invariants:
 *   - REDACTION BEFORE PERSIST: ir_request/ir_response pass through redactDeep
 *     (key-based) and every string leaf through redactSecrets (pattern-based)
 *     before any byte hits disk.
 *   - A write failure NEVER blocks a call: record()/markOutcome() log a
 *     warning and return; they never throw.
 *   - All SQL uses named parameters only — no string interpolation.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../core/shared/logger.js';
import { DATA_DIR } from '../core/shared/paths.js';
import { isZDRBlocked } from '../core/privacy/zdr-mode.js';
import { contentFingerprint } from './cache/canonical.js';
import type { IRRequest } from '../../shared-types/ir/v1.js';

const logger = createLogger('gateway-call-log');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One gateway call, as handed to {@link GatewayCallLog.record}. */
export interface LLMCallRecord {
  /** Unique id for this call; PRIMARY KEY. Re-recording the same trace_id replaces the row. */
  traceId: string;
  /** ISO-8601 timestamp; defaults to now when omitted. */
  ts?: string;
  /** Which subsystem made the call (e.g. 'agent-loop', 'consciousness'). */
  caller: string;
  /** Free-form purpose tag (e.g. 'chat', 'summarize'). */
  purpose?: string;
  /** Model alias as requested (pre-resolution). */
  alias?: string;
  /** Resolved route (provider/model actually used). */
  route?: string;
  /** Scheduling priority class. */
  priority?: string;
  /** Provider-agnostic IR request. Redacted before persist, stored as JSON. */
  irRequest?: unknown;
  /** Provider-agnostic IR response. Redacted before persist, stored as JSON. */
  irResponse?: unknown;
  /** sha256 hex of the exact final provider wire payload (see {@link sha256Hex}). */
  wirePayloadSha256?: string;
  /** Taxonomy class when the call failed (from src/llm/errors.ts). */
  errorClass?: string;
  latencyMs?: number;
  /** Time to first token, streaming calls only. */
  ttftMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  costUsd?: number;
  /** Downstream outcome; usually stamped later via {@link GatewayCallLog.markOutcome}. */
  outcome?: string;
  /** Session the call belongs to (AL1.2). Filled from the ambient loop-step context when omitted. */
  sessionId?: string;
  /** Agent-loop turn id (one AgentLoop.run invocation). Ambient-filled when omitted. */
  turnId?: string;
  /** Loop iteration number within the turn. Ambient-filled when omitted. */
  stepN?: number;
  /** Tool whose execution this call served, when applicable. Ambient-filled when omitted. */
  tool?: string;
}

// AL1.2 loop-step context lives in ./loop-step-context.ts (agent code sets it
// without importing this DB module). Re-exported here so telemetry consumers
// keep a single import surface.
import { currentLoopStep, type ToolCallRecord } from './loop-step-context.js';
export { runWithLoopStep, currentLoopStep } from './loop-step-context.js';
export type { LoopStepContext, ToolCallRecord } from './loop-step-context.js';

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Default rolling window of llm_calls history to keep (days). */
const DEFAULT_RETENTION_DAYS = 30;
/** Prune at most this often (ms) — record() is on the hot call path. */
const PRUNE_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Resolve the retention window. `SUDO_GATEWAY_LOG_RETENTION_DAYS` overrides
 * the default; `0` disables pruning entirely (keep everything). Negative or
 * invalid values fall back to the default.
 */
function resolveRetentionDays(): number {
  const raw = process.env['SUDO_GATEWAY_LOG_RETENTION_DAYS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const DDL_TABLE = `
  CREATE TABLE IF NOT EXISTS llm_calls (
    trace_id            TEXT    PRIMARY KEY,
    ts                  TEXT    NOT NULL,
    caller              TEXT    NOT NULL,
    purpose             TEXT,
    alias               TEXT,
    route               TEXT,
    priority            TEXT,
    ir_request          TEXT,
    ir_response         TEXT,
    wire_payload_sha256 TEXT,
    content_sha256      TEXT,
    error_class         TEXT,
    latency_ms          INTEGER,
    ttft_ms             INTEGER,
    tokens_in           INTEGER,
    tokens_out          INTEGER,
    tokens_cached       INTEGER,
    cost_usd            REAL,
    outcome             TEXT,
    session_id          TEXT,
    turn_id             TEXT,
    step_n              INTEGER,
    tool                TEXT
  )
`;

/** Tool executions — one row per tool call, keyed to the same turn/step ids. */
const DDL_TOOL_CALLS = `
  CREATE TABLE IF NOT EXISTS tool_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT    NOT NULL,
    session_id  TEXT    NOT NULL,
    turn_id     TEXT,
    step_n      INTEGER,
    tool        TEXT    NOT NULL,
    latency_ms  INTEGER,
    outcome     TEXT
  )
`;
const DDL_IDX_TOOL_TS      = `CREATE INDEX IF NOT EXISTS idx_tool_calls_ts      ON tool_calls(ts)`;
const DDL_IDX_TOOL_SESSION = `CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id)`;
const DDL_IDX_TOOL_TURN    = `CREATE INDEX IF NOT EXISTS idx_tool_calls_turn    ON tool_calls(turn_id)`;
// Turn-join index for llm_calls — created AFTER the column migration (legacy
// DBs lack turn_id until then), same staging as DDL_IDX_CONTENT.
const DDL_IDX_TURN         = `CREATE INDEX IF NOT EXISTS idx_llm_calls_turn     ON llm_calls(turn_id)`;

const DDL_IDX_TS          = `CREATE INDEX IF NOT EXISTS idx_llm_calls_ts          ON llm_calls(ts)`;
const DDL_IDX_CALLER      = `CREATE INDEX IF NOT EXISTS idx_llm_calls_caller      ON llm_calls(caller)`;
const DDL_IDX_ERROR_CLASS = `CREATE INDEX IF NOT EXISTS idx_llm_calls_error_class ON llm_calls(error_class)`;
// Content-fingerprint index powers the Phase-0 dedup GROUP BY. Created AFTER the
// column migration below (an existing DB lacks the column until then).
const DDL_IDX_CONTENT     = `CREATE INDEX IF NOT EXISTS idx_llm_calls_content     ON llm_calls(content_sha256)`;

/**
 * Additive migrations for DBs created before a column existed. Guarded by a
 * PRAGMA table_info check (trace-store idiom) so re-runs are no-ops. Empty
 * today; append `{ column, ddl }` entries as the schema evolves.
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'content_sha256', ddl: 'ALTER TABLE llm_calls ADD COLUMN content_sha256 TEXT' },
  { column: 'session_id',     ddl: 'ALTER TABLE llm_calls ADD COLUMN session_id TEXT' },
  { column: 'turn_id',        ddl: 'ALTER TABLE llm_calls ADD COLUMN turn_id TEXT' },
  { column: 'step_n',         ddl: 'ALTER TABLE llm_calls ADD COLUMN step_n INTEGER' },
  { column: 'tool',           ddl: 'ALTER TABLE llm_calls ADD COLUMN tool TEXT' },
];

// Redaction-before-persist helpers live in ./persist-redact.ts (pure, no DB).
import { toJsonColumn } from './persist-redact.js';
export { redactForPersist } from './persist-redact.js';

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * sha256 hex digest of the exact final provider wire payload. Hash the bytes
 * that actually go on the wire — after all transforms — so the stored digest
 * can be matched against provider-side logs.
 */
export function sha256Hex(payload: string | Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Session → trace correlation (Phase 5 wiring)
// ---------------------------------------------------------------------------

/** Kill-switch for all gateway-log wiring. Default ON; disable with SUDO_GATEWAY_LOG=0. */
function gatewayLogEnabled(): boolean {
  return process.env['SUDO_GATEWAY_LOG'] !== '0';
}

/** Bounded session→last-trace map. LRU-ish: re-noting a session refreshes recency. */
const SESSION_TRACE_CAP = 500;
const _sessionTraces = new Map<string, string>();

/**
 * Remember the most recent gateway trace_id for a session so downstream
 * outcome signals (escalation fired, verifier rejected, user rephrased) can be
 * stamped onto the right llm_calls row later via {@link markOutcomeForSession}.
 * Fail-open: never throws; capped at {@link SESSION_TRACE_CAP} sessions
 * (oldest-noted evicted first).
 */
export function noteTraceForSession(sessionId: string, traceId: string): void {
  try {
    if (!gatewayLogEnabled()) return;
    if (!sessionId || !traceId) return;
    // Refresh recency: Map preserves insertion order, so delete+set moves the
    // session to the back and eviction takes the least-recently-noted first.
    if (_sessionTraces.has(sessionId)) _sessionTraces.delete(sessionId);
    _sessionTraces.set(sessionId, traceId);
    if (_sessionTraces.size > SESSION_TRACE_CAP) {
      const oldest = _sessionTraces.keys().next().value;
      if (oldest !== undefined) _sessionTraces.delete(oldest);
    }
  } catch {
    /* fail-open — correlation is telemetry, never breaks a call */
  }
}

/**
 * Stamp an outcome onto the LAST gateway trace noted for this session.
 * Silent no-op when the session has no noted trace (e.g. wiring not yet live
 * on this path, or the session was evicted from the bounded map). Fail-open.
 */
export function markOutcomeForSession(sessionId: string, outcome: string): void {
  try {
    if (!gatewayLogEnabled()) return;
    const traceId = _sessionTraces.get(sessionId);
    if (!traceId) return;
    getGatewayCallLog().markOutcome(traceId, outcome);
  } catch (err) {
    logger.warn(
      { sessionId, outcome, err: err instanceof Error ? err.message : String(err) },
      'markOutcomeForSession failed',
    );
  }
}

/** Test hook: clear the session→trace correlation map. */
export function __resetSessionTraces(): void {
  _sessionTraces.clear();
}

// Rephrase heuristic (Phase 5 outcome signal) lives in ./rephrase-heuristic.ts.
export { jaccardWordSimilarity, isLikelyRephrase } from './rephrase-heuristic.js';

// ---------------------------------------------------------------------------
// GatewayCallLog
// ---------------------------------------------------------------------------

/**
 * Durable gateway call log.
 *
 * Usage — singleton via {@link getGatewayCallLog}:
 * ```ts
 * const log = getGatewayCallLog();
 * log.record({ traceId, caller: 'agent-loop', irRequest, ... });
 * log.markOutcome(traceId, 'accepted');
 * ```
 */
export class GatewayCallLog {
  private readonly db: Database.Database;
  /** Epoch ms of the last prune; throttles pruning off the hot record() path. */
  private _lastPrunedAt = 0;

  constructor(dbPath: string = path.join(DATA_DIR, 'gateway.db')) {
    if (!dbPath?.trim()) throw new TypeError('GatewayCallLog: dbPath must be a non-empty string');

    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this._applyDdl();
    // Trim any backlog once at startup.
    this.prune();
    logger.info({ dbPath, retentionDays: resolveRetentionDays() }, 'GatewayCallLog initialised');
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _applyDdl(): void {
    for (const stmt of [
      DDL_TABLE, DDL_IDX_TS, DDL_IDX_CALLER, DDL_IDX_ERROR_CLASS,
      DDL_TOOL_CALLS, DDL_IDX_TOOL_TS, DDL_IDX_TOOL_SESSION, DDL_IDX_TOOL_TURN,
    ]) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "already exists" → table/index already present; "duplicate column"
        // → migration already applied. Both are expected idempotency no-ops.
        if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
          logger.warn({ stmt: stmt.slice(0, 80), err: msg }, 'DDL warning');
        }
      }
    }

    // Additive column migrations, guarded by PRAGMA table_info (trace-store idiom).
    if (COLUMN_MIGRATIONS.length > 0) {
      const existing = new Set(
        (this.db.prepare('PRAGMA table_info(llm_calls)').all() as Array<{ name: string }>).map((c) => c.name),
      );
      for (const { column, ddl } of COLUMN_MIGRATIONS) {
        if (!existing.has(column)) {
          try {
            this.db.exec(ddl);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('duplicate column')) {
              logger.warn({ column, err: msg }, 'column migration warning');
            }
          }
        }
      }
    }

    // content_sha256 + turn_id indexes — created here, after the column
    // migration guarantees the columns exist on legacy DBs (a fresh
    // DDL_TABLE already has them).
    for (const stmt of [DDL_IDX_CONTENT, DDL_IDX_TURN]) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          logger.warn({ err: msg }, 'post-migration index DDL warning');
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Record a call
  // -------------------------------------------------------------------------

  /**
   * Persist one gateway call. Synchronous, fire-and-forget: any failure is
   * logged and swallowed — a write failure never blocks a call.
   *
   * Duplicate trace_id → INSERT OR REPLACE: the last record() for a trace
   * wins wholesale (deliberate — a retry that re-records supersedes the
   * partial earlier row, including any previously-set outcome).
   */
  record(entry: LLMCallRecord): void {
    try {
      // Canonical content fingerprint — computed centrally so every caller (IR
      // AND legacy path) gets it, since ir_request is populated on all rows.
      // Fail-open: a malformed IR yields NULL, never a thrown/blocked call.
      let contentSha: string | null = null;
      if (entry.irRequest !== undefined && entry.irRequest !== null) {
        try {
          contentSha = contentFingerprint(entry.irRequest as IRRequest);
        } catch {
          contentSha = null;
        }
      }

      // F105 ZDR: under zero-data-retention, never persist the IR request/response
      // payloads (the raw prompt + model reply = user content). Everything else —
      // caller, route, tokens, cost, latency, content_sha256 fingerprint, outcome —
      // is operational metadata and still recorded so budgets/dedup keep working.
      const zdrBlocked = isZDRBlocked('session_persistence');

      // AL1.2: correlate this call to the loop iteration it serves. Explicit
      // entry fields win; the ambient loop-step context fills the rest.
      const loopStep = currentLoopStep();

      this.db.prepare(`
        INSERT OR REPLACE INTO llm_calls
          (trace_id, ts, caller, purpose, alias, route, priority,
           ir_request, ir_response, wire_payload_sha256, content_sha256, error_class,
           latency_ms, ttft_ms, tokens_in, tokens_out, tokens_cached,
           cost_usd, outcome, session_id, turn_id, step_n, tool)
        VALUES
          (:trace_id, :ts, :caller, :purpose, :alias, :route, :priority,
           :ir_request, :ir_response, :wire_payload_sha256, :content_sha256, :error_class,
           :latency_ms, :ttft_ms, :tokens_in, :tokens_out, :tokens_cached,
           :cost_usd, :outcome, :session_id, :turn_id, :step_n, :tool)
      `).run({
        trace_id:            entry.traceId,
        ts:                  entry.ts ?? new Date().toISOString(),
        caller:              entry.caller,
        purpose:             entry.purpose ?? null,
        alias:               entry.alias ?? null,
        route:               entry.route ?? null,
        priority:            entry.priority ?? null,
        ir_request:          zdrBlocked ? null : toJsonColumn(entry.irRequest),
        ir_response:         zdrBlocked ? null : toJsonColumn(entry.irResponse),
        wire_payload_sha256: entry.wirePayloadSha256 ?? null,
        content_sha256:      contentSha,
        error_class:         entry.errorClass ?? null,
        latency_ms:          entry.latencyMs ?? null,
        ttft_ms:             entry.ttftMs ?? null,
        tokens_in:           entry.tokensIn ?? null,
        tokens_out:          entry.tokensOut ?? null,
        tokens_cached:       entry.tokensCached ?? null,
        cost_usd:            entry.costUsd ?? null,
        outcome:             entry.outcome ?? null,
        session_id:          entry.sessionId ?? loopStep?.sessionId ?? null,
        turn_id:             entry.turnId ?? loopStep?.turnId ?? null,
        step_n:              entry.stepN ?? loopStep?.stepN ?? null,
        tool:                entry.tool ?? loopStep?.tool ?? null,
      });

      this._maybePrune();
    } catch (err) {
      logger.warn(
        { traceId: entry.traceId, err: err instanceof Error ? err.message : String(err) },
        'GatewayCallLog.record failed',
      );
    }
  }

  /**
   * Stamp an outcome onto an existing call row. Missing trace_id → silent
   * no-op. Never throws (same write-failure contract as record()).
   */
  markOutcome(traceId: string, outcome: string): void {
    try {
      this.db.prepare(`UPDATE llm_calls SET outcome = :outcome WHERE trace_id = :trace_id`)
        .run({ outcome, trace_id: traceId });
    } catch (err) {
      logger.warn(
        { traceId, err: err instanceof Error ? err.message : String(err) },
        'GatewayCallLog.markOutcome failed',
      );
    }
  }

  /**
   * Persist one tool execution (AL1.2). Same write-failure contract as
   * record(): never throws, never blocks the tool path. Turn/step fall back
   * to the ambient loop-step context.
   */
  recordToolCall(entry: ToolCallRecord): void {
    try {
      const loopStep = currentLoopStep();
      this.db.prepare(`
        INSERT INTO tool_calls (ts, session_id, turn_id, step_n, tool, latency_ms, outcome)
        VALUES (:ts, :session_id, :turn_id, :step_n, :tool, :latency_ms, :outcome)
      `).run({
        ts:         entry.ts ?? new Date().toISOString(),
        session_id: entry.sessionId,
        turn_id:    entry.turnId ?? loopStep?.turnId ?? null,
        step_n:     entry.stepN ?? loopStep?.stepN ?? null,
        tool:       entry.tool,
        latency_ms: entry.latencyMs,
        outcome:    entry.outcome,
      });
      this._maybePrune();
    } catch (err) {
      logger.warn(
        { tool: entry.tool, err: err instanceof Error ? err.message : String(err) },
        'GatewayCallLog.recordToolCall failed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Day-spend derivation (GW-1: persistent budget across restarts)
  // -------------------------------------------------------------------------

  /**
   * GW-1: derive today's (or any day's) recorded USD spend from the durable
   * `llm_calls` ledger, so the in-memory budget counter in `src/llm/policy.ts`
   * survives process restarts instead of resetting to zero on every boot.
   *
   * `dayKey` is an ISO date (`YYYY-MM-DD`); rows are matched by `ts LIKE
   * '<dayKey>%'` (ts is always ISO-8601, so a prefix match is the UTC day).
   * Rows with NULL `cost_usd` contribute 0 (SUM ignores NULLs) — a floor, never
   * a throw. Fail-open: any query error returns an empty result and is logged.
   *
   * @returns `{ total, byCaller }` — total USD and per-caller-key USD for the day.
   */
  daySpend(dayKey: string = new Date().toISOString().slice(0, 10)): {
    total: number;
    byCaller: Map<string, number>;
  } {
    const byCaller = new Map<string, number>();
    let total = 0;
    try {
      const rows = this.db
        .prepare(
          `SELECT caller, COALESCE(SUM(cost_usd), 0) AS spend
             FROM llm_calls
            WHERE ts LIKE :prefix AND cost_usd IS NOT NULL
            GROUP BY caller`,
        )
        .all({ prefix: `${dayKey}%` }) as Array<{ caller: string; spend: number }>;
      for (const r of rows) {
        const usd = typeof r.spend === 'number' && Number.isFinite(r.spend) ? r.spend : 0;
        if (usd <= 0) continue;
        const idx = r.caller.indexOf(':');
        const key = idx === -1 ? r.caller : r.caller.slice(0, idx);
        byCaller.set(key, (byCaller.get(key) ?? 0) + usd);
        total += usd;
      }
    } catch (err) {
      logger.warn(
        { dayKey, err: err instanceof Error ? err.message : String(err) },
        'GatewayCallLog.daySpend failed — treating recorded spend as 0',
      );
    }
    return { total, byCaller };
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Delete llm_calls rows older than the retention window. Returns rows
   * removed. `retentionDays = 0` → no-op (retention disabled). Errors are
   * swallowed so retention never breaks recording.
   *
   * @param retentionDays - Override the resolved window (mainly for tests).
   */
  prune(retentionDays = resolveRetentionDays()): number {
    this._lastPrunedAt = Date.now(); // throttle even when disabled / on error
    if (retentionDays <= 0) return 0;
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const info = this.db.prepare(`DELETE FROM llm_calls WHERE ts < :cutoff`).run({ cutoff });
      const toolInfo = this.db.prepare(`DELETE FROM tool_calls WHERE ts < :cutoff`).run({ cutoff });
      const deleted = (info.changes ?? 0) + (toolInfo.changes ?? 0);
      if (deleted > 0) {
        logger.info({ deleted, retentionDays, cutoff }, 'Pruned old llm_calls/tool_calls rows');
      }
      return deleted;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'GatewayCallLog.prune failed');
      return 0;
    }
  }

  /** Prune at most once per {@link PRUNE_THROTTLE_MS}; called after each insert. */
  private _maybePrune(): void {
    if (Date.now() - this._lastPrunedAt < PRUNE_THROTTLE_MS) return;
    this.prune();
  }

  /** Close the underlying database handle (tests / shutdown). */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level lazy singleton
// ---------------------------------------------------------------------------

let _instance: GatewayCallLog | null = null;

/**
 * Return the process-wide singleton GatewayCallLog.
 * Creates it on first call using the provided (or default) dbPath.
 */
export function getGatewayCallLog(dbPath?: string): GatewayCallLog {
  if (!_instance) {
    _instance = new GatewayCallLog(dbPath);
  }
  return _instance;
}

/**
 * Fire-and-forget tool-execution row (AL1.2). Same gating idiom as
 * client.ts recordGatewayCall: SUDO_GATEWAY_LOG=0 disables; skipped under
 * vitest unless SUDO_GATEWAY_LOG_TEST=1; fully try/caught — a logging bug
 * can never break a tool call.
 */
let _toolLogWarned = false;
export function recordToolCallSafe(entry: ToolCallRecord): void {
  try {
    if (!gatewayLogEnabled()) return;
    if (process.env['VITEST'] && process.env['SUDO_GATEWAY_LOG_TEST'] !== '1') return;
    getGatewayCallLog().recordToolCall(entry);
  } catch (err) {
    if (!_toolLogWarned) {
      _toolLogWarned = true;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'recordToolCallSafe failed (fail-open, warn once)',
      );
    }
  }
}

/** Test hook: drop the singleton so the next getGatewayCallLog() re-creates it. */
export function __resetGatewayCallLog(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
