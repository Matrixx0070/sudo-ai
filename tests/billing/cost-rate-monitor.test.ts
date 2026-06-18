/**
 * @file tests/billing/cost-rate-monitor.test.ts
 * @description CostTracker.getSpendRate + CostRateMonitor watchdog.
 *
 * Covers the live $/hour cost watchdog that fills the gap the cost-transparency
 * chain (#259-#265) left: spend was observable but unwatched. getSpendRate is
 * tested against a hermetic mind.db with custom-timestamped rows; the monitor's
 * breach classification, cooldown, emit, and fail-open behavior are unit-tested.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostTracker } from '../../src/core/billing/cost-tracker.js';
import {
  CostRateMonitor,
  resolveCostRateMonitorConfig,
  type CostRateMonitorConfig,
  type SpendRateSource,
} from '../../src/core/billing/cost-rate-monitor.js';
import type { SpendRate } from '../../src/core/billing/cost-tracker.js';

// ---------------------------------------------------------------------------
// getSpendRate against a hermetic mind.db
// ---------------------------------------------------------------------------

describe('CostTracker.getSpendRate', () => {
  let dir: string;
  let dbPath: string;
  let tracker: CostTracker;

  // A single frozen "now" so row ages don't drift across inserts on slow CI.
  const NOW = Date.now();

  /** Insert a row with an explicit cost + age (ms before the frozen NOW). */
  function insert(raw: Database.Database, costUsd: number, agoMs: number): void {
    const calledAt = new Date(NOW - agoMs).toISOString();
    raw.prepare(
      `INSERT INTO api_call_log (id, provider, model, estimated_cost_usd, source, called_at)
       VALUES (:id, 'anthropic', 'claude-opus-4-8', :cost, 'consciousness', :calledAt)`,
    ).run({ id: `${calledAt}-${Math.round(costUsd * 1e6)}-${agoMs}`, cost: costUsd, calledAt });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cost-rate-'));
    dbPath = join(dir, 'mind.db');
    tracker = new CostTracker(dbPath); // creates the api_call_log table
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes $/hour over the trailing window and a baseline from prior windows', () => {
    const raw = new Database(dbPath);
    // Trailing hour: $2 total.
    insert(raw, 1.0, 5 * 60 * 1000);
    insert(raw, 1.0, 30 * 60 * 1000);
    // Prior 24 baseline hours: $24 total ($1/hr baseline).
    for (let h = 1; h <= 24; h++) insert(raw, 1.0, h * 60 * 60 * 1000 + 60 * 1000);
    raw.close();

    const rate = tracker.getSpendRate({ windowMs: 60 * 60 * 1000, baselineWindows: 24 });
    expect(rate.windowUsd).toBeCloseTo(2.0, 6);
    expect(rate.usdPerHour).toBeCloseTo(2.0, 6); // 1h window
    expect(rate.baselineUsdPerHour).not.toBeNull();
    expect(rate.baselineUsdPerHour!).toBeCloseTo(1.0, 1); // ~$24 over 24h
    expect(rate.deviationPct).not.toBeNull();
    expect(rate.deviationPct!).toBeGreaterThan(50); // 2/hr vs ~1/hr ≈ +100%
    expect(rate.samples).toBe(2);
  });

  it('returns a null baseline (not infinite deviation) when there is no prior history', () => {
    const raw = new Database(dbPath);
    insert(raw, 5.0, 10 * 60 * 1000); // only a trailing-window row, no baseline rows
    raw.close();

    const rate = tracker.getSpendRate({ windowMs: 60 * 60 * 1000 });
    expect(rate.usdPerHour).toBeCloseTo(5.0, 6);
    expect(rate.baselineUsdPerHour).toBeNull();
    expect(rate.deviationPct).toBeNull();
  });

  it('excludes rows older than the trailing window from windowUsd (ISO-cutoff correctness)', () => {
    const raw = new Database(dbPath);
    insert(raw, 3.0, 10 * 60 * 1000); // inside 1h window
    insert(raw, 9.0, 90 * 60 * 1000); // outside 1h window (must NOT count)
    raw.close();

    const rate = tracker.getSpendRate({ windowMs: 60 * 60 * 1000 });
    expect(rate.windowUsd).toBeCloseTo(3.0, 6);
    expect(rate.samples).toBe(1);
  });

  it('reports a zero rate on an empty table without throwing', () => {
    const rate = tracker.getSpendRate();
    expect(rate.windowUsd).toBe(0);
    expect(rate.usdPerHour).toBe(0);
    expect(rate.baselineUsdPerHour).toBeNull();
    expect(rate.samples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CostRateMonitor
// ---------------------------------------------------------------------------

const CFG: CostRateMonitorConfig = {
  intervalMs: 600_000,
  windowMs: 3_600_000,
  ceilingUsdPerHour: 10,
  deviationPct: 150,
  minUsdPerHourForDeviation: 0.5,
  cooldownMs: 3_600_000,
};

function fixedRate(over: Partial<SpendRate>): SpendRateSource {
  const base: SpendRate = {
    windowUsd: 0, windowHours: 1, usdPerHour: 0,
    baselineUsdPerHour: null, deviationPct: null, samples: 0,
  };
  return { getSpendRate: () => ({ ...base, ...over }) };
}

/** A hook emitter that records every emitted event. */
function recordingHooks() {
  const events: Array<{ event: string; context: Record<string, unknown> }> = [];
  return { events, emit: async (event: string, context: Record<string, unknown>) => { events.push({ event, context }); } };
}

describe('CostRateMonitor.evaluate', () => {
  it('flags a ceiling breach as critical', () => {
    const m = new CostRateMonitor(fixedRate({ usdPerHour: 12 }), recordingHooks(), CFG);
    const alert = m.evaluate(fixedRate({ usdPerHour: 12 }).getSpendRate());
    expect(alert?.severity).toBe('critical');
    expect(alert?.reason).toBe('ceiling');
  });

  it('flags a deviation breach as warning when above the min floor', () => {
    const m = new CostRateMonitor(fixedRate({}), recordingHooks(), CFG);
    const alert = m.evaluate({ ...fixedRate({}).getSpendRate(), usdPerHour: 5, baselineUsdPerHour: 1, deviationPct: 400 });
    expect(alert?.severity).toBe('warning');
    expect(alert?.reason).toBe('deviation');
  });

  it('ceiling wins over deviation when both trip', () => {
    const m = new CostRateMonitor(fixedRate({}), recordingHooks(), CFG);
    const alert = m.evaluate({ ...fixedRate({}).getSpendRate(), usdPerHour: 50, baselineUsdPerHour: 1, deviationPct: 4900 });
    expect(alert?.reason).toBe('ceiling');
    expect(alert?.severity).toBe('critical');
  });

  it('flags a known $0 baseline with positive spend as a deviation breach (ratio undefined)', () => {
    const m = new CostRateMonitor(fixedRate({}), recordingHooks(), CFG);
    // baseline existed (n>0) but averaged $0; now spending $2/hr — deviationPct null.
    const alert = m.evaluate({ ...fixedRate({}).getSpendRate(), usdPerHour: 2, baselineUsdPerHour: 0, deviationPct: null });
    expect(alert?.severity).toBe('warning');
    expect(alert?.reason).toBe('deviation');
  });

  it('does not flag a $0 baseline when spend is below the floor', () => {
    const m = new CostRateMonitor(fixedRate({}), recordingHooks(), CFG);
    const alert = m.evaluate({ ...fixedRate({}).getSpendRate(), usdPerHour: 0.1, baselineUsdPerHour: 0, deviationPct: null });
    expect(alert).toBeNull();
  });

  it('suppresses a deviation alert below the min absolute floor', () => {
    const m = new CostRateMonitor(fixedRate({}), recordingHooks(), CFG);
    // 0.05/hr vs 0.01 baseline = +400% deviation but trivial absolute spend.
    const alert = m.evaluate({ ...fixedRate({}).getSpendRate(), usdPerHour: 0.05, baselineUsdPerHour: 0.01, deviationPct: 400 });
    expect(alert).toBeNull();
  });

  it('does not alert when within ceiling and below deviation threshold', () => {
    const m = new CostRateMonitor(fixedRate({}), recordingHooks(), CFG);
    const alert = m.evaluate({ ...fixedRate({}).getSpendRate(), usdPerHour: 3, baselineUsdPerHour: 2.5, deviationPct: 20 });
    expect(alert).toBeNull();
  });

  it('honors the disable sentinels (ceiling=0, deviation=0)', () => {
    const disabled: CostRateMonitorConfig = { ...CFG, ceilingUsdPerHour: 0, deviationPct: 0 };
    const m = new CostRateMonitor(fixedRate({}), recordingHooks(), disabled);
    const alert = m.evaluate({ ...fixedRate({}).getSpendRate(), usdPerHour: 9999, baselineUsdPerHour: 1, deviationPct: 99999 });
    expect(alert).toBeNull();
  });
});

describe('CostRateMonitor.check', () => {
  it('emits cost_rate_alert on a breach', async () => {
    const hooks = recordingHooks();
    const m = new CostRateMonitor(fixedRate({ usdPerHour: 20, windowUsd: 20 }), hooks, CFG);
    const alert = await m.check(0);
    expect(alert?.severity).toBe('critical');
    expect(hooks.events).toHaveLength(1);
    expect(hooks.events[0]!.event).toBe('cost_rate_alert');
    expect(hooks.events[0]!.context['usdPerHour']).toBe(20);
  });

  it('respects the cooldown — a persistent breach does not re-emit every tick', async () => {
    const hooks = recordingHooks();
    const m = new CostRateMonitor(fixedRate({ usdPerHour: 20 }), hooks, CFG);
    await m.check(0);
    await m.check(CFG.cooldownMs - 1); // inside cooldown
    expect(hooks.events).toHaveLength(1);
    await m.check(CFG.cooldownMs + 1); // past cooldown
    expect(hooks.events).toHaveLength(2);
  });

  it('is fail-open: a sampling throw never propagates', async () => {
    const throwing: SpendRateSource = { getSpendRate: () => { throw new Error('db gone'); } };
    const hooks = recordingHooks();
    const m = new CostRateMonitor(throwing, hooks, CFG);
    await expect(m.check(0)).resolves.toBeNull();
    expect(hooks.events).toHaveLength(0);
  });

  it('is fail-open: an emit throw never propagates', async () => {
    const badHooks = { emit: async () => { throw new Error('hook bus down'); } };
    const m = new CostRateMonitor(fixedRate({ usdPerHour: 20 }), badHooks, CFG);
    await expect(m.check(0)).resolves.not.toBeNull(); // alert still returned
  });
});

describe('resolveCostRateMonitorConfig', () => {
  it('uses defaults when env is empty', () => {
    const cfg = resolveCostRateMonitorConfig({});
    expect(cfg.ceilingUsdPerHour).toBe(10);
    expect(cfg.deviationPct).toBe(150);
    expect(cfg.windowMs).toBe(3_600_000);
  });

  it('reads overrides and honors 0-as-disable for ceiling/deviation', () => {
    const cfg = resolveCostRateMonitorConfig({
      SUDO_COST_RATE_ALERT_CEILING_USD_PER_HR: '0',
      SUDO_COST_RATE_ALERT_DEVIATION_PCT: '0',
      SUDO_COST_RATE_ALERT_INTERVAL_MS: '300000',
    } as NodeJS.ProcessEnv);
    expect(cfg.ceilingUsdPerHour).toBe(0); // disable sentinel preserved
    expect(cfg.deviationPct).toBe(0);
    expect(cfg.intervalMs).toBe(300_000);
  });

  it('falls back to default on a 0 interval (0 is not a valid period)', () => {
    const cfg = resolveCostRateMonitorConfig({ SUDO_COST_RATE_ALERT_INTERVAL_MS: '0' } as NodeJS.ProcessEnv);
    expect(cfg.intervalMs).toBe(600_000);
  });
});
