/**
 * @file verify-gate.ts
 * @description In-loop verification gate — slice 1: ConfidenceGate dispatcher.
 *
 * Reads per-tool Brier-derived confidence live in the AgentLoop. For tools
 * classified `safety: 'destructive'` whose live confidence falls below a
 * configured threshold, emits a structured "escalate" decision that slices 2
 * (grounding check) and 3 (auto-critic) will consume.
 *
 * Slice 1 is observable-only: escalate decisions are logged + emitted as a
 * hook event; execution still proceeds. Without slices 2+3 wired, blocking
 * here would brick the loop. Gate is opt-in via `SUDO_VERIFY_GATE=1`,
 * default OFF, fail-open on every error path.
 *
 * Live-confidence signal:
 *   Composite default — try Brier-by-tool against `<DATA_DIR>/calibration.db`
 *   first; if it returns no rows (or below `minSamples`), fall back to a
 *   rolling per-tool success rate against `<DATA_DIR>/audit.db`. Either
 *   path returns the same `{ confidence, samples }` shape, so the gate's
 *   public contract is unchanged regardless of which one wins.
 *
 *   The Brier path became viable once `confidence_calibration` grew a
 *   `tool_name` column (calibration-pivot slice; slice-1 pre-pivot, the
 *   column held only epistemic labels and per-tool lookups returned zero
 *   rows, which is why slice 1 went straight to audit.db). Audit.db
 *   remains the fallback so cold calibration DBs do not regress.
 *
 *   Brier-derived confidence = `1 - mean((predicted - outcome)^2)`, which
 *   captures predictor calibration on a tool (overconfident predictors
 *   drop below threshold even when the success rate alone would pass).
 *   Audit fallback is still `successes / usable` — same semantic the gate
 *   shipped with under slice 1.
 */

import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('agent:verify-gate');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Decision returned by the gate for a single tool call. */
export type GateDecision = 'allow' | 'escalate' | 'unknown';

/** Per-tool gate result, observable by the AgentLoop. */
export interface GateResult {
  decision: GateDecision;
  /** 0–1 live confidence (1 - brier) when computed; null when no signal. */
  confidence: number | null;
  /** Configured threshold the decision was compared against. */
  threshold: number;
  /** Sample count contributing to the confidence (rows in calibration window). */
  samples: number;
  /** Short reason: 'gate-off' | 'readonly' | 'no-history' | 'low-samples' | 'below-threshold' | 'above-threshold' | 'no-tool-def' | 'error'. */
  reason: string;
}

/** Minimal shape of a tool definition the gate needs. */
export interface ToolDefForGate {
  name: string;
  safety?: 'readonly' | 'destructive';
}

/** Read-only registry surface the gate consumes. */
export interface ToolRegistryForGate {
  get(name: string): ToolDefForGate | undefined;
}

/** DB row shape returned by the audit-rate query. */
interface OutcomeRow {
  outcome: string | null;
}

/** DB row shape returned by the calibration-Brier query. */
interface CalibrationRow {
  predicted: number;
  outcome: number;
}

/** Duck-typed better-sqlite3 surface — same pattern as skill/usage-stats.ts. */
interface DbLike {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  close(): void;
}
type DbConstructorFn = new (path: string, opts?: Record<string, unknown>) => DbLike;

// ---------------------------------------------------------------------------
// Constants + env
// ---------------------------------------------------------------------------

/** Default threshold: live confidence must be >= 0.55 to allow. */
const DEFAULT_THRESHOLD = 0.55;
/** Minimum calibration rows required before the score is considered meaningful. */
const DEFAULT_MIN_SAMPLES = 5;
/** Cap on audit rows we sample per tool (matches usage-stats.ts read budget). */
const AUDIT_ROW_LIMIT = 100;
/** Cap on calibration rows sampled per tool for the Brier window. */
const CALIBRATION_ROW_LIMIT = 100;

/** Returns true when `SUDO_VERIFY_GATE=1`. Default OFF. */
export function isGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_VERIFY_GATE'] === '1';
}

/** Parses `SUDO_VERIFY_GATE_THRESHOLD` as a 0–1 float; falls back to default. */
export function readThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['SUDO_VERIFY_GATE_THRESHOLD'];
  if (!raw) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_THRESHOLD;
  return n;
}

/** Parses `SUDO_VERIFY_GATE_MIN_SAMPLES`; floors to >=1. */
export function readMinSamples(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['SUDO_VERIFY_GATE_MIN_SAMPLES']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MIN_SAMPLES;
}

/** Default TTL (ms) for the per-tool confidence cache when enabled. */
const DEFAULT_CACHE_TTL_MS = 5000;
/** Default max distinct tools held in the confidence cache. */
const DEFAULT_CACHE_MAX = 256;

/**
 * Returns true when `SUDO_VERIFY_GATE_CACHE=1`. Default OFF. The cache memoises
 * the per-tool confidence lookup so a burst of evaluations of the same
 * destructive tool doesn't re-open `audit.db` (+ `calibration.db`) every call.
 */
export function isCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_VERIFY_GATE_CACHE'] === '1';
}

/** Parses `SUDO_VERIFY_GATE_CACHE_TTL_MS`; floors to >=0 (`0` disables caching). */
export function readCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['SUDO_VERIFY_GATE_CACHE_TTL_MS']);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_CACHE_TTL_MS;
}

/** Parses `SUDO_VERIFY_GATE_CACHE_MAX`; floors to >=1. */
export function readCacheMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['SUDO_VERIFY_GATE_CACHE_MAX']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_CACHE_MAX;
}

// ---------------------------------------------------------------------------
// Calibration lookup
// ---------------------------------------------------------------------------

function openReadonly(dbPath: string): DbLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Ctor = require('better-sqlite3') as DbConstructorFn;
    return new Ctor(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/**
 * Compute live confidence from `audit.db` for one tool: rolling per-tool
 * success rate over the last `AUDIT_ROW_LIMIT` rows. Returns
 * `{ confidence, samples }` or `null` when the DB / table / matching rows
 * are unavailable. Tool name is bound as an exact-match parameter, NOT
 * interpolated — both for safety and because audit_log records
 * `resource = <full tool name>` per call (no substring needed).
 *
 * NaN-safe: rows with non-string outcomes are skipped rather than poisoning
 * the rate; if every row is unusable we return `null` (same as no-history).
 */
export function computeLiveConfidence(
  toolName: string,
  dbPath: string = path.join(DATA_DIR, 'audit.db'),
): { confidence: number; samples: number } | null {
  const db = openReadonly(dbPath);
  if (!db) return null;
  try {
    const rows = db.prepare(
      `SELECT outcome FROM audit_log
       WHERE action = 'tool_call' AND resource = ?
       ORDER BY timestamp DESC LIMIT ?`,
    ).all(toolName, AUDIT_ROW_LIMIT) as OutcomeRow[];
    let usable = 0;
    let successes = 0;
    for (const r of rows) {
      if (typeof r.outcome !== 'string') continue;
      usable++;
      if (r.outcome.toLowerCase() === 'success') successes++;
    }
    if (usable === 0) return null;
    const rate = successes / usable;
    // Clamp defensively even though successes/usable is mathematically in [0,1].
    const confidence = Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
    return { confidence, samples: usable };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Compute Brier-derived confidence from `calibration.db` for one tool, using
 * the last `CALIBRATION_ROW_LIMIT` rows that carry `tool_name = ?`. Returns
 * `{ confidence, samples }` or `null` when the DB / table / matching rows
 * are unavailable.
 *
 * `confidence = 1 - mean((predicted - outcome)^2)` — overconfident predictors
 * (high predicted, low realized) push the Brier score up and confidence down,
 * so the gate fires on miscalibration rather than just raw failure rate.
 *
 * Rows with non-finite `predicted` or non-binary `outcome` are skipped rather
 * than poisoning the mean; if every row is unusable we return `null` (same as
 * no-history).
 */
export function computeBrierConfidence(
  toolName: string,
  dbPath: string = path.join(DATA_DIR, 'calibration.db'),
): { confidence: number; samples: number } | null {
  const db = openReadonly(dbPath);
  if (!db) return null;
  try {
    const rows = db.prepare(
      `SELECT predicted, outcome FROM confidence_calibration
       WHERE tool_name = ?
       ORDER BY ts DESC LIMIT ?`,
    ).all(toolName, CALIBRATION_ROW_LIMIT) as CalibrationRow[];
    let usable = 0;
    let sumSquaredError = 0;
    for (const r of rows) {
      if (typeof r.predicted !== 'number' || !Number.isFinite(r.predicted)) continue;
      if (r.outcome !== 0 && r.outcome !== 1) continue;
      const p = Math.max(0, Math.min(1, r.predicted));
      sumSquaredError += (p - r.outcome) ** 2;
      usable++;
    }
    if (usable === 0) return null;
    const brier = sumSquaredError / usable;
    const raw = 1 - brier;
    const confidence = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    return { confidence, samples: usable };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Composite lookup used by the default `ConfidenceGate`:
 *
 *   1. Try Brier-by-tool against calibration.db. If it returns at least
 *      `minSamples` rows, that's the answer.
 *   2. Otherwise fall back to the audit.db rolling-rate path (slice 1
 *      behavior). Cold calibration DB → no regression.
 *
 * Returning Brier only when sample count meets `minSamples` keeps a
 * one-row calibration entry from displacing a 100-row audit signal. The
 * gate's own low-samples check is still authoritative on the final result.
 */
export function computeCompositeConfidence(
  toolName: string,
  opts: { minSamples?: number; brierDbPath?: string; auditDbPath?: string } = {},
): { confidence: number; samples: number } | null {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const brier = computeBrierConfidence(
    toolName,
    opts.brierDbPath ?? path.join(DATA_DIR, 'calibration.db'),
  );
  if (brier !== null && brier.samples >= minSamples) {
    return brier;
  }
  return computeLiveConfidence(
    toolName,
    opts.auditDbPath ?? path.join(DATA_DIR, 'audit.db'),
  );
}

// ---------------------------------------------------------------------------
// ConfidenceGate
// ---------------------------------------------------------------------------

export interface ConfidenceGateOptions {
  /** Override env-derived enablement (tests). */
  enabled?: boolean;
  /** Override env-derived threshold (tests). */
  threshold?: number;
  /** Override env-derived min sample count (tests). */
  minSamples?: number;
  /** Inject a custom confidence lookup (tests). */
  confidenceLookup?: (toolName: string) => { confidence: number; samples: number } | null;
  /** Override env-derived cache enablement (tests). */
  cacheEnabled?: boolean;
  /** Override cache TTL in ms (tests). `0` disables the cache. */
  cacheTtlMs?: number;
  /** Override cache max entries (tests). */
  cacheMax?: number;
  /** Injectable clock for deterministic TTL tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Cached lookup result + its expiry. `value` may be `null` (no-history). */
type LookupResult = { confidence: number; samples: number } | null;
interface CacheEntry {
  value: LookupResult;
  expiresAt: number;
}

/**
 * ConfidenceGate — slice-1 dispatcher.
 *
 * The gate is stateless aside from its config. Each `evaluate(toolName)` call
 * does at most one calibration-DB read; on any error path (missing DB, missing
 * table, malformed rows, missing tool def) the gate fails open with a `'allow'`
 * decision and a structured reason.
 */
export class ConfidenceGate {
  private readonly enabled: boolean;
  private readonly threshold: number;
  private readonly minSamples: number;
  private readonly lookup: (toolName: string) => LookupResult;
  /** TTL-LRU over the lookup result; null when caching is disabled. */
  private readonly cache: Map<string, CacheEntry> | null;
  private readonly cacheTtlMs: number;
  private readonly cacheMax: number;
  private readonly now: () => number;

  constructor(
    private readonly registry: ToolRegistryForGate,
    opts: ConfidenceGateOptions = {},
  ) {
    this.enabled = opts.enabled ?? isGateEnabled();
    this.threshold = opts.threshold ?? readThreshold();
    this.minSamples = opts.minSamples ?? readMinSamples();
    // Composite default — Brier-by-tool first, audit rolling-rate fallback.
    // The composite uses the gate's own minSamples so a sparse calibration
    // row never displaces a richer audit signal.
    this.lookup =
      opts.confidenceLookup ?? ((name) => computeCompositeConfidence(name, { minSamples: this.minSamples }));
    this.cacheTtlMs = opts.cacheTtlMs ?? readCacheTtlMs();
    // Floor to >=1 — readCacheMax already floors the env path, but a direct
    // opts.cacheMax: 0 injection would make every set evict immediately.
    this.cacheMax = Math.max(1, opts.cacheMax ?? readCacheMax());
    this.now = opts.now ?? Date.now;
    // Only allocate the map when caching is both enabled and has a live TTL.
    const cacheEnabled = opts.cacheEnabled ?? isCacheEnabled();
    this.cache = cacheEnabled && this.cacheTtlMs > 0 ? new Map() : null;
  }

  /**
   * Memoised wrapper over `this.lookup`. Within the TTL window a repeated
   * evaluation of the same destructive tool returns the cached result instead
   * of re-opening audit.db (+ calibration.db). Insertion-order map acts as an
   * LRU — a hit is promoted (delete + re-insert), and the oldest entries are
   * evicted past capacity. `null` (no-history) is cached too, since that path
   * also opens a DB. A throwing lookup is never cached (it propagates).
   *
   * Semantics: an entry is live for exactly `cacheTtlMs` (`expiresAt > now`,
   * strict — expired at the boundary instant). Expired entries are pruned lazily
   * on the next access to that key; the map holds at most `cacheMax` entries
   * regardless of staleness, so a tool never re-evaluated keeps a stale entry
   * until capacity eviction reclaims it (bounded, intentional).
   */
  private cachedLookup(toolName: string): LookupResult {
    if (!this.cache) return this.lookup(toolName);
    const nowMs = this.now();
    const hit = this.cache.get(toolName);
    if (hit && hit.expiresAt > nowMs) {
      this.cache.delete(toolName);
      this.cache.set(toolName, hit); // promote to most-recent
      return hit.value;
    }
    if (hit) this.cache.delete(toolName); // expired — drop before refresh
    const value = this.lookup(toolName);
    this.cache.set(toolName, { value, expiresAt: nowMs + this.cacheTtlMs });
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  /**
   * Evaluate one tool call. Pure dispatch; does not mutate session state and
   * does not execute the tool. Always returns a `GateResult`, never throws.
   */
  evaluate(toolName: string): GateResult {
    if (!this.enabled) {
      return { decision: 'allow', confidence: null, threshold: this.threshold, samples: 0, reason: 'gate-off' };
    }

    let def: ToolDefForGate | undefined;
    try {
      def = this.registry.get(toolName);
    } catch (err) {
      log.warn({ tool: toolName, err: String(err) }, 'verify-gate: registry.get threw — failing open');
      return { decision: 'allow', confidence: null, threshold: this.threshold, samples: 0, reason: 'error' };
    }

    if (!def) {
      return { decision: 'allow', confidence: null, threshold: this.threshold, samples: 0, reason: 'no-tool-def' };
    }

    // Slice 1 scope: only gate explicitly 'destructive' tools.
    // Absent safety field + 'readonly' both bypass — narrow + honest.
    if (def.safety !== 'destructive') {
      return { decision: 'allow', confidence: null, threshold: this.threshold, samples: 0, reason: 'readonly' };
    }

    let live: LookupResult;
    try {
      live = this.cachedLookup(toolName);
    } catch (err) {
      log.warn({ tool: toolName, err: String(err) }, 'verify-gate: confidence lookup threw — failing open');
      return { decision: 'allow', confidence: null, threshold: this.threshold, samples: 0, reason: 'error' };
    }

    if (live === null) {
      // No audit history at all → unknown → allow (fail-open).
      return { decision: 'unknown', confidence: null, threshold: this.threshold, samples: 0, reason: 'no-history' };
    }

    // Defensive: a custom-injected lookup could hand us a NaN/Infinity. Treat
    // any non-finite confidence as "no signal" (fail-open) rather than letting
    // the `<` below silently false-out and route to 'escalate'.
    if (!Number.isFinite(live.confidence)) {
      return { decision: 'unknown', confidence: null, threshold: this.threshold, samples: live.samples, reason: 'no-history' };
    }

    if (live.samples < this.minSamples) {
      // Sparse history → not enough signal to act on → unknown → allow.
      return { decision: 'unknown', confidence: live.confidence, threshold: this.threshold, samples: live.samples, reason: 'low-samples' };
    }

    if (live.confidence >= this.threshold) {
      return { decision: 'allow', confidence: live.confidence, threshold: this.threshold, samples: live.samples, reason: 'above-threshold' };
    }

    return { decision: 'escalate', confidence: live.confidence, threshold: this.threshold, samples: live.samples, reason: 'below-threshold' };
  }
}
