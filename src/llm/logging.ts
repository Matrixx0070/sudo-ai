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
import { redactDeep } from '../core/shared/redact.js';
import { redactSecrets } from '../core/federation/federation-error-sanitizer.js';

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
}

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
    error_class         TEXT,
    latency_ms          INTEGER,
    ttft_ms             INTEGER,
    tokens_in           INTEGER,
    tokens_out          INTEGER,
    tokens_cached       INTEGER,
    cost_usd            REAL,
    outcome             TEXT
  )
`;

const DDL_IDX_TS          = `CREATE INDEX IF NOT EXISTS idx_llm_calls_ts          ON llm_calls(ts)`;
const DDL_IDX_CALLER      = `CREATE INDEX IF NOT EXISTS idx_llm_calls_caller      ON llm_calls(caller)`;
const DDL_IDX_ERROR_CLASS = `CREATE INDEX IF NOT EXISTS idx_llm_calls_error_class ON llm_calls(error_class)`;

/**
 * Additive migrations for DBs created before a column existed. Guarded by a
 * PRAGMA table_info check (trace-store idiom) so re-runs are no-ops. Empty
 * today; append `{ column, ddl }` entries as the schema evolves.
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{ column: string; ddl: string }> = [];

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Two-layer redaction for IR payloads before persist:
 *   1. redactDeep — replaces values under sensitive-looking KEYS
 *      (token/secret/key/password/auth/…) with '<redacted>'.
 *   2. redactSecrets — pattern-scrubs every remaining string LEAF
 *      (Bearer tokens, API keys, connection strings, private IPs, …).
 * Cycle-safe and depth-capped via redactDeep's own guards; the leaf pass
 * mirrors its depth cap.
 */
function redactForPersist(input: unknown): unknown {
  return redactStringLeaves(redactDeep(input));
}

function redactStringLeaves(input: unknown, depth = 0): unknown {
  if (depth > 8) return input;
  if (typeof input === 'string') return redactSecrets(input);
  if (input === null || input === undefined || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => redactStringLeaves(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = redactStringLeaves(v, depth + 1);
  }
  return out;
}

/** JSON-serialize a redacted IR payload; undefined → NULL column. */
function toJsonColumn(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(redactForPersist(value)) ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'IR serialization failed');
    return null;
  }
}

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
    for (const stmt of [DDL_TABLE, DDL_IDX_TS, DDL_IDX_CALLER, DDL_IDX_ERROR_CLASS]) {
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
      this.db.prepare(`
        INSERT OR REPLACE INTO llm_calls
          (trace_id, ts, caller, purpose, alias, route, priority,
           ir_request, ir_response, wire_payload_sha256, error_class,
           latency_ms, ttft_ms, tokens_in, tokens_out, tokens_cached,
           cost_usd, outcome)
        VALUES
          (:trace_id, :ts, :caller, :purpose, :alias, :route, :priority,
           :ir_request, :ir_response, :wire_payload_sha256, :error_class,
           :latency_ms, :ttft_ms, :tokens_in, :tokens_out, :tokens_cached,
           :cost_usd, :outcome)
      `).run({
        trace_id:            entry.traceId,
        ts:                  entry.ts ?? new Date().toISOString(),
        caller:              entry.caller,
        purpose:             entry.purpose ?? null,
        alias:               entry.alias ?? null,
        route:               entry.route ?? null,
        priority:            entry.priority ?? null,
        ir_request:          toJsonColumn(entry.irRequest),
        ir_response:         toJsonColumn(entry.irResponse),
        wire_payload_sha256: entry.wirePayloadSha256 ?? null,
        error_class:         entry.errorClass ?? null,
        latency_ms:          entry.latencyMs ?? null,
        ttft_ms:             entry.ttftMs ?? null,
        tokens_in:           entry.tokensIn ?? null,
        tokens_out:          entry.tokensOut ?? null,
        tokens_cached:       entry.tokensCached ?? null,
        cost_usd:            entry.costUsd ?? null,
        outcome:             entry.outcome ?? null,
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
      const deleted = info.changes ?? 0;
      if (deleted > 0) {
        logger.info({ deleted, retentionDays, cutoff }, 'Pruned old llm_calls rows');
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

/** Test hook: drop the singleton so the next getGatewayCallLog() re-creates it. */
export function __resetGatewayCallLog(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}
