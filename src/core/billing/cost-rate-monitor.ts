/**
 * @file cost-rate-monitor.ts
 * @description Periodic watchdog over the daemon's $/hour LLM spend rate.
 *
 * The cost-transparency chain (#259-#265) made spend observable in dashboards
 * but nothing watches the rate live. The day-grain predictor anomaly detector
 * only runs on-demand (the predictor meta-tool), so a runaway — or a repeat of
 * the phantom-meter over-billing bug — accrues unnoticed until a human opens a
 * dashboard. This samples `CostTracker.getSpendRate` on a timer and emits a
 * `cost_rate_alert` hook event when $/hour crosses an absolute ceiling
 * (critical) or deviates sharply above the rolling baseline (warning).
 *
 * Opt-in: `SUDO_COST_RATE_ALERT=1`. Fail-open — a sampling or emit error is
 * logged, never thrown. The timer is `unref`'d so it never holds the process
 * open. Observable-only: this NEVER blocks or throttles spend; it reports.
 */

import { createLogger } from '../shared/logger.js';
import type { SpendRate } from './cost-tracker.js';

const log = createLogger('cost-rate-monitor');

/** The single hook event this monitor emits. */
export type CostRateAlertEvent = 'cost_rate_alert';

/** Minimal hook-bus surface — the monitor only ever emits `cost_rate_alert`. */
export interface HookEmitterLike {
  emit(event: CostRateAlertEvent, context: Record<string, unknown>): Promise<void>;
}

/** The CostTracker surface this monitor depends on (eases testing). */
export interface SpendRateSource {
  getSpendRate(opts?: { windowMs?: number; baselineWindows?: number }): SpendRate;
}

export interface CostRateMonitorConfig {
  /** How often to sample (ms). */
  intervalMs: number;
  /** Trailing window the rate is computed over (ms). */
  windowMs: number;
  /** Absolute $/hour ceiling; a breach is `critical`. 0 disables the ceiling check. */
  ceilingUsdPerHour: number;
  /** Percent-above-baseline that counts as a `warning` deviation. 0 disables the deviation check. */
  deviationPct: number;
  /** Suppress deviation alerts while the absolute rate is below this — avoids alerting on trivial spikes. */
  minUsdPerHourForDeviation: number;
  /** Minimum gap between emitted alerts (ms) so a persistent breach doesn't spam every interval. */
  cooldownMs: number;
}

export interface CostRateAlert {
  severity: 'warning' | 'critical';
  reason: 'ceiling' | 'deviation';
  usdPerHour: number;
  windowUsd: number;
  windowHours: number;
  baselineUsdPerHour: number | null;
  deviationPct: number | null;
  ceilingUsdPerHour: number;
  samples: number;
}

const DEFAULTS: CostRateMonitorConfig = {
  intervalMs: 10 * 60 * 1000, // 10 min
  windowMs: 60 * 60 * 1000, // 1 h
  ceilingUsdPerHour: 10,
  deviationPct: 150,
  minUsdPerHourForDeviation: 0.5,
  cooldownMs: 60 * 60 * 1000, // 1 h
};

/** Parse a positive number env override, falling back to `def` on absent/invalid. `allowZero` keeps 0 (a disable sentinel). */
function numEnv(env: NodeJS.ProcessEnv, key: string, def: number, allowZero = false): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  if (n === 0 && !allowZero) return def;
  return n;
}

/** Resolve the monitor config from env (all overrides optional). */
export function resolveCostRateMonitorConfig(env: NodeJS.ProcessEnv = process.env): CostRateMonitorConfig {
  return {
    intervalMs: numEnv(env, 'SUDO_COST_RATE_ALERT_INTERVAL_MS', DEFAULTS.intervalMs),
    windowMs: numEnv(env, 'SUDO_COST_RATE_ALERT_WINDOW_MS', DEFAULTS.windowMs),
    // ceiling + deviation accept 0 as an explicit "disable this check" sentinel.
    ceilingUsdPerHour: numEnv(env, 'SUDO_COST_RATE_ALERT_CEILING_USD_PER_HR', DEFAULTS.ceilingUsdPerHour, true),
    deviationPct: numEnv(env, 'SUDO_COST_RATE_ALERT_DEVIATION_PCT', DEFAULTS.deviationPct, true),
    minUsdPerHourForDeviation: numEnv(env, 'SUDO_COST_RATE_ALERT_MIN_USD_PER_HR', DEFAULTS.minUsdPerHourForDeviation, true),
    cooldownMs: numEnv(env, 'SUDO_COST_RATE_ALERT_COOLDOWN_MS', DEFAULTS.cooldownMs),
  };
}

export class CostRateMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  // -Infinity so the first breach always clears the cooldown gate regardless of
  // the absolute clock value (a 0 init would suppress an alert at nowMs ~ 0).
  private lastAlertAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly tracker: SpendRateSource,
    private readonly hooks: HookEmitterLike,
    private readonly cfg: CostRateMonitorConfig = DEFAULTS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.check(); }, this.cfg.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info(
      {
        intervalMs: this.cfg.intervalMs,
        windowMs: this.cfg.windowMs,
        ceilingUsdPerHour: this.cfg.ceilingUsdPerHour,
        deviationPct: this.cfg.deviationPct,
      },
      'CostRateMonitor started',
    );
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * One sampling pass. Emits at most one `cost_rate_alert` (subject to cooldown)
   * and returns it, or null when nothing fired. Never throws (fail-open).
   */
  async check(nowMs: number = Date.now()): Promise<CostRateAlert | null> {
    let alert: CostRateAlert | null;
    try {
      const rate = this.tracker.getSpendRate({ windowMs: this.cfg.windowMs });
      alert = this.evaluate(rate);
    } catch (err) {
      log.warn({ err: String(err) }, 'CostRateMonitor.check: sampling failed (fail-open)');
      return null;
    }
    if (!alert) return null;
    // Cooldown: a persistent breach must not re-emit every interval.
    if (nowMs - this.lastAlertAt < this.cfg.cooldownMs) return null;
    this.lastAlertAt = nowMs;
    try {
      await this.hooks.emit('cost_rate_alert', { event: 'cost_rate_alert', ...alert });
    } catch (err) {
      log.warn({ err: String(err) }, 'CostRateMonitor: cost_rate_alert emit failed (fail-open)');
    }
    log.warn(
      { ...alert },
      `Cost-rate alert: $${alert.usdPerHour.toFixed(2)}/hr (${alert.severity}, ${alert.reason})`,
    );
    return alert;
  }

  /**
   * Pure breach classification — no side effects. Ceiling breach wins (critical)
   * over a deviation breach (warning) when both trip.
   */
  evaluate(rate: SpendRate): CostRateAlert | null {
    const ceilingBreach = this.cfg.ceilingUsdPerHour > 0 && rate.usdPerHour > this.cfg.ceilingUsdPerHour;
    const aboveFloor = rate.usdPerHour >= this.cfg.minUsdPerHourForDeviation;
    const deviationBreach =
      this.cfg.deviationPct > 0 &&
      aboveFloor &&
      (
        (rate.deviationPct !== null && rate.deviationPct > this.cfg.deviationPct) ||
        // Baseline exists (n>0) but averages to $0 — e.g. an all-cached/free-tier
        // history. A ratio is undefined, but positive spend over a $0 baseline is
        // itself anomalous, so treat it as a deviation breach above the floor.
        rate.baselineUsdPerHour === 0
      );
    if (!ceilingBreach && !deviationBreach) return null;
    return {
      severity: ceilingBreach ? 'critical' : 'warning',
      reason: ceilingBreach ? 'ceiling' : 'deviation',
      usdPerHour: rate.usdPerHour,
      windowUsd: rate.windowUsd,
      windowHours: rate.windowHours,
      baselineUsdPerHour: rate.baselineUsdPerHour,
      deviationPct: rate.deviationPct,
      ceilingUsdPerHour: this.cfg.ceilingUsdPerHour,
      samples: rate.samples,
    };
  }
}
