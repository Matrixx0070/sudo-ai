/**
 * @file grok-budget.ts
 * @description Shared usage budget for ALL free grok.com web-seat services
 * (brain/chat, image, video, voice). The free lane draws the SuperGrok WEEKLY
 * pool — which is SHARED with the operator's own interactive Grok use — so an
 * unattended agent/optimizer loop could silently drain the human's quota. Per
 * the engineering doctrine, every recurring background consumer must declare
 * per-run + per-day budgets and halt gracefully on exhaustion.
 *
 * The web lane returns no token counts, so the budget is measured in CALLS
 * (turns), the unit we can observe. Two ceilings:
 *   - per-run: turns since process start (guards a runaway single loop)
 *   - per-day: turns per calendar day (guards sustained background drain)
 * Real pool/burst exhaustion is still caught reactively as a 429 →
 * GrokWebRateLimitedError → failover; this budget is the PROACTIVE guard.
 *
 * Exhaustion throws GrokBudgetExhaustedError, which the connector surfaces so
 * the caller fails over (never a metered fallback, never a silent drain).
 */

import { createLogger } from '../core/shared/logger.js';

const log = createLogger('llm:grok-budget');

/** Thrown when a grok call would exceed the run/day ceiling. Fail over. */
export class GrokBudgetExhaustedError extends Error {
  readonly code = 'GROK_BUDGET_EXHAUSTED';
  readonly shouldFailover = true;
  constructor(scope: 'run' | 'day', used: number, limit: number) {
    super(
      `Grok web budget exhausted (${scope}: ${used}/${limit} calls). Halting to protect ` +
        `the shared SuperGrok pool; fail over to another model. Raise SUDO_GROK_BUDGET_PER_${scope.toUpperCase()} to allow more.`,
    );
    this.name = 'GrokBudgetExhaustedError';
  }
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface GrokBudgetStatus {
  runUsed: number;
  runLimit: number;
  dayUsed: number;
  dayLimit: number;
  day: string;
}

export interface GrokBudgetOptions {
  perRun?: number;
  perDay?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

/**
 * Call-count budget with a per-run and a per-calendar-day ceiling. `guard()`
 * throws before a call that would exceed either; `record()` counts a call that
 * happened. Not persisted across process restarts by design — per-run resets on
 * restart, per-day resets at UTC midnight.
 */
export class GrokBudget {
  private readonly perRun: number;
  private readonly perDay: number;
  private readonly now: () => number;
  private runUsed = 0;
  private dayUsed = 0;
  private day: string;

  public constructor(opts: GrokBudgetOptions = {}) {
    this.perRun = opts.perRun ?? envNum('SUDO_GROK_BUDGET_PER_RUN', 500);
    this.perDay = opts.perDay ?? envNum('SUDO_GROK_BUDGET_PER_DAY', 2000);
    this.now = opts.now ?? (() => Date.now());
    this.day = this.today();
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10); // YYYY-MM-DD UTC
  }

  private rollDay(): void {
    const d = this.today();
    if (d !== this.day) {
      this.day = d;
      this.dayUsed = 0;
      log.info({ day: d }, 'grok budget: new day, per-day counter reset');
    }
  }

  /** Throw if the NEXT call would exceed a ceiling. Call before dispatching. */
  public guard(): void {
    this.rollDay();
    if (this.runUsed >= this.perRun) throw new GrokBudgetExhaustedError('run', this.runUsed, this.perRun);
    if (this.dayUsed >= this.perDay) throw new GrokBudgetExhaustedError('day', this.dayUsed, this.perDay);
  }

  /** Count a call that was dispatched. */
  public record(): void {
    this.rollDay();
    this.runUsed++;
    this.dayUsed++;
  }

  public status(): GrokBudgetStatus {
    this.rollDay();
    return {
      runUsed: this.runUsed,
      runLimit: this.perRun,
      dayUsed: this.dayUsed,
      dayLimit: this.perDay,
      day: this.day,
    };
  }
}
