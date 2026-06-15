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
 * Live-confidence signal — slice 1 design note:
 *   The natural source would be `<DATA_DIR>/calibration.db`'s
 *   `confidence_calibration` table, but its `tag` column carries an epistemic
 *   label (`'PROBABLE'`, `'tool-outcome'`, `'OVERRIDE'`, ...), never a tool
 *   name — so a per-tool Brier lookup keyed on tool name returns zero rows.
 *   (`skill/tools/usage-stats.ts:brierForTool` has the same defect and is
 *   why its `brierForTool` field is almost always `null` in practice.)
 *
 *   Slice 1 therefore pivots to `<DATA_DIR>/audit.db`'s `audit_log` table,
 *   which records `resource = <tool name>` for every `action = 'tool_call'`
 *   row. Live confidence = rolling per-tool success rate over the last N
 *   rows. This is not Brier, but it IS a real, ground-truth per-tool signal
 *   computed from outcomes the loop already writes. A future slice can add
 *   a tool-name dimension to `confidence_calibration` and pivot back without
 *   changing the gate's public contract.
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
  private readonly lookup: (toolName: string) => { confidence: number; samples: number } | null;

  constructor(
    private readonly registry: ToolRegistryForGate,
    opts: ConfidenceGateOptions = {},
  ) {
    this.enabled = opts.enabled ?? isGateEnabled();
    this.threshold = opts.threshold ?? readThreshold();
    this.minSamples = opts.minSamples ?? readMinSamples();
    this.lookup = opts.confidenceLookup ?? ((name) => computeLiveConfidence(name));
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

    let live: { confidence: number; samples: number } | null;
    try {
      live = this.lookup(toolName);
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
