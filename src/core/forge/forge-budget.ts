/**
 * @file forge/forge-budget.ts
 * @description F108 (docs/CORE_ROADMAP.md Wave D) — kill-switch + spend budget
 * for the multi-model SUDO FORGE pipeline.
 *
 * Before F108 the forge orchestrator fanned out across many Grok models
 * (architect, builders, reviewer, security, evolution) with NO kill-switch and
 * NO spend ceiling — an ungoverned multi-model spend surface. This module adds:
 *
 *   1. A kill-switch: SUDO_FORGE=0 disables forge entirely (default ON, so prod
 *      behaviour is preserved; the switch just makes it governable).
 *   2. Per-run + per-day token/USD budgets (combined-invariant 10). Exhaustion
 *      halts the run gracefully (fail-closed) rather than spending unbounded.
 *
 * Per-day accounting is process-local (a date-keyed module singleton, reset on
 * day rollover). This mirrors the lightweight in-process daily counters used by
 * other on-demand spend surfaces; it is intentionally not a cross-process ledger.
 */

/** Kill-switch: forge runs unless SUDO_FORGE is explicitly set to '0'. */
export function forgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_FORGE'] !== '0';
}

/** Parse a USD/token cap. Unset → default; 'off'/'none'/'' → Infinity (disabled). */
function parseCap(raw: string | undefined, dflt: number): number {
  if (raw === undefined) return dflt;
  const t = raw.trim().toLowerCase();
  if (t === 'off' || t === 'none' || t === '') return Infinity;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Resolved budget caps for a forge run. */
export interface ForgeBudgetCaps {
  usdPerRun: number;
  usdPerDay: number;
  tokensPerRun: number;
  tokensPerDay: number;
  /** USD charged per 1000 tokens (prompt+completion) for estimation. */
  usdPer1kTokens: number;
}

/** Defaults are finite so forge is actually governed, but generous enough to
 *  preserve normal single-forge behaviour. Override via SUDO_FORGE_BUDGET_*. */
export function resolveForgeCaps(env: NodeJS.ProcessEnv = process.env): ForgeBudgetCaps {
  return {
    usdPerRun: parseCap(env['SUDO_FORGE_BUDGET_USD_PER_RUN'], 2.0),
    usdPerDay: parseCap(env['SUDO_FORGE_BUDGET_USD_PER_DAY'], 10.0),
    tokensPerRun: parseCap(env['SUDO_FORGE_BUDGET_TOKENS_PER_RUN'], 500_000),
    tokensPerDay: parseCap(env['SUDO_FORGE_BUDGET_TOKENS_PER_DAY'], 2_000_000),
    usdPer1kTokens: parseCap(env['SUDO_FORGE_USD_PER_1K_TOKENS'], 0.002),
  };
}

// ---------------------------------------------------------------------------
// Process-local per-day accumulator (date-keyed singleton)
// ---------------------------------------------------------------------------

interface DailyUsage {
  day: string;
  tokens: number;
  usd: number;
}

const dailyUsage: DailyUsage = { day: '', tokens: 0, usd: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function rolloverIfNeeded(): void {
  const d = today();
  if (dailyUsage.day !== d) {
    dailyUsage.day = d;
    dailyUsage.tokens = 0;
    dailyUsage.usd = 0;
  }
}

/** Snapshot of today's forge spend — surfaced by metabolism/telemetry reporting. */
export function getForgeSpendSnapshot(): { day: string; tokens: number; usd: number } {
  rolloverIfNeeded();
  return { day: dailyUsage.day, tokens: dailyUsage.tokens, usd: Number(dailyUsage.usd.toFixed(4)) };
}

/** Test-only: reset the process-local daily accumulator. */
export function __resetForgeDailyUsage(): void {
  dailyUsage.day = '';
  dailyUsage.tokens = 0;
  dailyUsage.usd = 0;
}

// ---------------------------------------------------------------------------
// ForgeBudget — per-run tracker that also feeds the per-day accumulator
// ---------------------------------------------------------------------------

export interface ExhaustionCheck {
  exhausted: boolean;
  reason?: string;
}

/**
 * Tracks token/USD spend for a single forge run and enforces per-run + per-day
 * caps. Construct one per run; the per-day totals are shared process-wide.
 */
export class ForgeBudget {
  readonly caps: ForgeBudgetCaps;
  private runTokens = 0;
  private runUsd = 0;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.caps = resolveForgeCaps(env);
  }

  /** Estimated USD for a token count under the configured rate. */
  usdFromTokens(tokens: number): number {
    return (tokens / 1000) * this.caps.usdPer1kTokens;
  }

  /** Record usage from one model call into both run + day totals. */
  recordUsage(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const usd = this.usdFromTokens(tokens);
    this.runTokens += tokens;
    this.runUsd += usd;
    rolloverIfNeeded();
    dailyUsage.tokens += tokens;
    dailyUsage.usd += usd;
  }

  /** Current run totals. */
  runSnapshot(): { tokens: number; usd: number } {
    return { tokens: this.runTokens, usd: Number(this.runUsd.toFixed(4)) };
  }

  /**
   * Check whether any cap is exhausted. Called before each model call so a run
   * halts gracefully at the boundary rather than overspending.
   */
  checkExhausted(): ExhaustionCheck {
    rolloverIfNeeded();
    if (this.runTokens >= this.caps.tokensPerRun) {
      return { exhausted: true, reason: `per-run token cap reached (${this.runTokens} >= ${this.caps.tokensPerRun})` };
    }
    if (this.runUsd >= this.caps.usdPerRun) {
      return { exhausted: true, reason: `per-run USD cap reached ($${this.runUsd.toFixed(4)} >= $${this.caps.usdPerRun})` };
    }
    if (dailyUsage.tokens >= this.caps.tokensPerDay) {
      return { exhausted: true, reason: `per-day token cap reached (${dailyUsage.tokens} >= ${this.caps.tokensPerDay})` };
    }
    if (dailyUsage.usd >= this.caps.usdPerDay) {
      return { exhausted: true, reason: `per-day USD cap reached ($${dailyUsage.usd.toFixed(4)} >= $${this.caps.usdPerDay})` };
    }
    return { exhausted: false };
  }
}
