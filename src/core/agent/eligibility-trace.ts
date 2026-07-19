/**
 * @file eligibility-trace.ts
 * @description CW8 — eligibility traces for multi-step credit (SUDO_CAS_AGENCY,
 * same flag as CW7). Extends the CURRENT tool-bias mechanism: instead of an
 * outcome crediting only the LAST tool decision, a per-session decaying trace
 * (lambda ~= 0.7/step, window <= 10) distributes the SAME EMA update across the
 * decisions still eligible, proportional to their trace weight. This lets an
 * early decision that caused a later failure actually move — temporal credit
 * assignment (P10a) — with no new learning system: it calls the store's own
 * weighted EMA step.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:eligibility');

/** Decay per step. Handoff CW8: lambda ~= 0.7. Env-tunable, clamped (0,1). */
export function resolveLambda(): number {
  const raw = Number(process.env['SUDO_CAS_ELIGIBILITY_LAMBDA']);
  if (Number.isFinite(raw) && raw > 0 && raw < 1) return raw;
  return 0.7;
}

/** Max eligible decisions retained (handoff CW8: window <= 10). */
export const ELIGIBILITY_WINDOW = 10;

/** Weight below which an entry is dropped from the trace (negligible credit). */
const MIN_WEIGHT = 1e-3;

/** Duck-typed store surface (tool-success-store.ts). */
export interface WeightedBiasStore {
  recordWeighted(tool: string, success: boolean, weight: number): void;
}

interface TraceEntry { tool: string; weight: number }

/**
 * Per-session decaying eligibility trace over tool decisions. push() on each
 * decision (decays all prior by lambda); distribute() on an outcome (applies
 * the weighted EMA step to every eligible decision).
 */
export class EligibilityTrace {
  private readonly lambda: number;
  private entries: TraceEntry[] = [];

  constructor(lambda: number = resolveLambda()) {
    this.lambda = lambda;
  }

  /**
   * Record a tool decision. Decays every existing entry by lambda first, then
   * appends the new decision at full weight 1.0. Enforces the window and drops
   * negligible-weight tails. If the same tool recurs, its eligibility is
   * refreshed to 1.0 (most-recent occurrence dominates).
   */
  push(tool: string): void {
    if (!tool) return;
    for (const e of this.entries) e.weight *= this.lambda;
    const existing = this.entries.find((e) => e.tool === tool);
    if (existing) existing.weight = 1;
    else this.entries.push({ tool, weight: 1 });
    // Drop negligible tails, then cap to the window (keep the freshest).
    this.entries = this.entries.filter((e) => e.weight >= MIN_WEIGHT);
    if (this.entries.length > ELIGIBILITY_WINDOW) {
      this.entries = this.entries.slice(this.entries.length - ELIGIBILITY_WINDOW);
    }
  }

  /**
   * Distribute an outcome across all eligible decisions: each gets the store's
   * weighted EMA step scaled by its current trace weight. The most-recent
   * decision (weight 1) receives the full step — identical to the pre-CW8
   * single-tool update — while earlier eligible decisions receive lambda^k of
   * it. Deterministic; no store mutation beyond the weighted records.
   */
  distribute(store: WeightedBiasStore, success: boolean): void {
    for (const e of this.entries) {
      try { store.recordWeighted(e.tool, success, e.weight); }
      catch (err) { log.warn({ err: String(err), tool: e.tool }, 'CW8: recordWeighted failed (fail-open)'); }
    }
  }

  /** Current eligible decisions (diagnostic / test). */
  snapshot(): ReadonlyArray<TraceEntry> {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Clear the trace (call at session/task end). */
  reset(): void {
    this.entries = [];
  }
}
