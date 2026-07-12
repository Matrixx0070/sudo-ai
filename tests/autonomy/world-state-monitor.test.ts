/**
 * WorldStateMonitor (gap #3) — proves surprise detection over measurable signals
 * synthesises a goal (gated), warms up before firing, respects cooldown, and
 * detect-only mode never creates goals.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorldStateMonitor, type SignalReading } from '../../src/core/autonomy/world-state-monitor.js';

function monitorWith(reader: () => SignalReading[], liveGoals: boolean, createGoal = vi.fn()) {
  return { m: new WorldStateMonitor({ readSignals: reader, createGoal, liveGoals, warmupTicks: 2, cooldownMs: 1_000, surpriseThreshold: 1.75 }), createGoal };
}

describe('WorldStateMonitor — prediction-error goal synthesis', () => {
  it('does not fire during warmup even on a spike', () => {
    let v = 5;
    const { m, createGoal } = monitorWith(() => [{ key: 'cost', label: 'cost', value: v, higherIsWorse: true, floor: 1 }], true);
    m.tick(1000); v = 100;      // tick 1 (warmup)
    m.tick(2000);               // tick 2 (warmup, still)
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('synthesises a goal when a signal spikes past expectation (live)', () => {
    let v = 5;
    const { m, createGoal } = monitorWith(() => [{ key: 'cost', label: 'hourly cost', value: v, higherIsWorse: true, floor: 1, priority: 'high' }], true);
    m.tick(1000); m.tick(2000); m.tick(3000); // warm the EMA around ~5
    v = 50;                                    // 10x spike
    const anomalies = m.tick(4000);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0]!.key).toBe('cost');
    expect(createGoal).toHaveBeenCalledTimes(1);
    expect(createGoal.mock.calls[0]![0]).toContain('hourly cost');
    expect(createGoal.mock.calls[0]![2]).toBe('high');
  });

  it('detect-only mode reports the anomaly but never creates a goal', () => {
    let v = 5;
    const { m, createGoal } = monitorWith(() => [{ key: 'cost', label: 'cost', value: v, higherIsWorse: true, floor: 1 }], false);
    m.tick(1000); m.tick(2000); m.tick(3000);
    v = 80;
    const anomalies = m.tick(4000);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(createGoal).not.toHaveBeenCalled();
  });

  it('respects per-signal cooldown', () => {
    let v = 5;
    const { m, createGoal } = monitorWith(() => [{ key: 'cost', label: 'cost', value: v, higherIsWorse: true, floor: 1 }], true);
    m.tick(1000); m.tick(2000); m.tick(3000);
    v = 60;
    m.tick(4000);                 // fires
    m.tick(4500);                 // within 1s cooldown → no second goal
    expect(createGoal).toHaveBeenCalledTimes(1);
    m.tick(6000);                 // cooldown elapsed → may fire again
    expect(createGoal).toHaveBeenCalledTimes(2);
  });

  it('does not fire below the noise floor', () => {
    let v = 0.1;
    const { m, createGoal } = monitorWith(() => [{ key: 'cost', label: 'cost', value: v, higherIsWorse: true, floor: 10 }], true);
    m.tick(1000); m.tick(2000); m.tick(3000);
    v = 3; // 30x expectation but still under the floor of 10
    const anomalies = m.tick(4000);
    expect(anomalies.length).toBe(0);
    expect(createGoal).not.toHaveBeenCalled();
  });
});
