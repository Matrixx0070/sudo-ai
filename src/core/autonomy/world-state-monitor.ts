/**
 * @file world-state-monitor.ts
 * @description Prediction-error goal synthesis (gap #3).
 *
 * SUDO's "goals" were only Frank's commands + a static checklist. This adds the
 * missing loop: snapshot a handful of MEASURABLE system signals each tick, hold a
 * running expectation (EMA) per signal = a lightweight prediction, and when a
 * reading diverges sharply from the prediction in a bad direction (a surprise /
 * prediction error), synthesise a goal so the autonomy loop investigates.
 *
 * Honest scope: this is anomaly-detection-driven goal creation over real signals,
 * NOT a learned world model. It cannot predict novel futures — only notice when
 * the present departs from the recent past. That is the buildable slice of
 * "goal synthesis from prediction error" on a frozen model.
 *
 * Safety: creating goals spawns autonomous work. Default is DETECT + LOG only;
 * live goal creation requires SUDO_WORLD_STATE_GOALS=1. Per-signal cooldown and
 * a per-tick cap prevent a stuck-bad signal from flooding the goal queue.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('autonomy:world-state-monitor');

export type GoalPriority = 'critical' | 'high' | 'normal' | 'low';

/** One measurable system signal read this tick. */
export interface SignalReading {
  key: string;
  label: string;
  value: number;
  /** True when a HIGHER value is the bad direction (cost, failures, memory…). */
  higherIsWorse: boolean;
  /** Absolute floor below which the signal is never alarming (noise gate). */
  floor: number;
  /** Goal priority when this signal fires. Default 'normal'. */
  priority?: GoalPriority;
}

export interface Anomaly {
  key: string;
  label: string;
  value: number;
  expected: number;
  ratio: number;
  priority: GoalPriority;
}

export interface WorldStateMonitorOptions {
  readSignals: () => SignalReading[];
  createGoal: (title: string, description: string, priority: GoalPriority) => void;
  /** SUDO_WORLD_STATE_GOALS — false = detect+log only (no live goal). */
  liveGoals: boolean;
  /** Reading must exceed expectation by this ratio to be a surprise. Default 1.75. */
  surpriseThreshold?: number;
  /** EMA weight for the newest reading. Default 0.3. */
  emaAlpha?: number;
  /** Per-signal cooldown between synthesised goals. Default 30 min. */
  cooldownMs?: number;
  /** Ticks to warm the EMA before any signal can fire. Default 3. */
  warmupTicks?: number;
}

export class WorldStateMonitor {
  private readonly ema = new Map<string, number>();
  private readonly seen = new Map<string, number>();       // key -> observation count
  private readonly lastGoalAt = new Map<string, number>(); // key -> last synth ts
  private readonly surpriseThreshold: number;
  private readonly emaAlpha: number;
  private readonly cooldownMs: number;
  private readonly warmupTicks: number;

  constructor(private readonly opts: WorldStateMonitorOptions) {
    this.surpriseThreshold = opts.surpriseThreshold ?? 1.75;
    this.emaAlpha = opts.emaAlpha ?? 0.3;
    this.cooldownMs = opts.cooldownMs ?? 30 * 60_000;
    this.warmupTicks = opts.warmupTicks ?? 3;
  }

  /**
   * One monitoring cycle: read signals, update predictions, synthesise goals for
   * surprises. Returns the anomalies detected this tick (for tests/telemetry).
   */
  tick(nowMs: number = Date.now()): Anomaly[] {
    let readings: SignalReading[];
    try {
      readings = this.opts.readSignals();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'readSignals threw — skipping tick');
      return [];
    }

    const anomalies: Anomaly[] = [];
    for (const r of readings) {
      if (!Number.isFinite(r.value)) continue;
      const expected = this.ema.get(r.key);
      const count = (this.seen.get(r.key) ?? 0) + 1;
      this.seen.set(r.key, count);

      // Update the running prediction AFTER reading the prior expectation.
      this.ema.set(r.key, expected === undefined ? r.value : this.emaAlpha * r.value + (1 - this.emaAlpha) * expected);

      if (expected === undefined || count <= this.warmupTicks) continue; // warming up
      const anomaly = this.detect(r, expected);
      if (anomaly) anomalies.push(anomaly);
    }

    // Fire at most one goal per tick — the most extreme surprise — so a bad
    // moment can't burst-create a queue of goals.
    anomalies.sort((a, b) => b.ratio - a.ratio);
    for (const a of anomalies) {
      const last = this.lastGoalAt.get(a.key) ?? 0;
      if (nowMs - last < this.cooldownMs) continue;
      this.lastGoalAt.set(a.key, nowMs);
      this.synthesise(a);
      break;
    }
    return anomalies;
  }

  private detect(r: SignalReading, expected: number): Anomaly | null {
    if (r.higherIsWorse) {
      if (r.value < r.floor) return null;
      const ratio = r.value / Math.max(expected, 1e-6);
      if (ratio < this.surpriseThreshold) return null;
      return { key: r.key, label: r.label, value: r.value, expected, ratio, priority: r.priority ?? 'normal' };
    }
    // lower-is-worse
    if (r.value > r.floor) return null;
    const ratio = Math.max(expected, 1e-6) / Math.max(r.value, 1e-6);
    if (ratio < this.surpriseThreshold) return null;
    return { key: r.key, label: r.label, value: r.value, expected, ratio, priority: r.priority ?? 'normal' };
  }

  private synthesise(a: Anomaly): void {
    const title = `Investigate ${a.label} anomaly`;
    const description =
      `The system signal "${a.label}" is at ${round(a.value)}, ~${a.ratio.toFixed(1)}x its recent expected ` +
      `~${round(a.expected)}. This is a prediction-error surprise — diagnose the cause and, if it is a real ` +
      `regression, fix it or alert the operator. If it is benign/expected, note why so future ticks don't re-flag it.`;
    if (!this.opts.liveGoals) {
      log.info({ ...a, title }, 'world-state surprise (detect-only; set SUDO_WORLD_STATE_GOALS=1 to synthesise a live goal)');
      return;
    }
    try {
      this.opts.createGoal(title, description, a.priority);
      log.info({ ...a, title }, 'world-state surprise → goal synthesised');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), key: a.key }, 'goal synthesis failed');
    }
  }

  /** Diagnostic: current predictions. */
  predictions(): Record<string, number> {
    return Object.fromEntries(this.ema);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
