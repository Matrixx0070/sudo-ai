/**
 * @file tests/health/watchdog-alert-sink.test.ts
 * @description Tests for the watchdog alert dispatch seam (dispatchAlerts) and
 *   the liveness-file heartbeat contract.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  dispatchAlerts,
  LIVENESS_FILE,
  type HealthCheck,
  type AlertSink,
} from '../../src/core/health/watchdog.js';
import { HealthAlertPolicy } from '../../src/core/health/alert-policy.js';

function check(name: string, status: HealthCheck['status']): HealthCheck {
  return { name, status, message: `${name} is ${status}`, lastCheck: new Date().toISOString() };
}

describe('dispatchAlerts', () => {
  it('routes critical failures to the sink with severity critical', () => {
    const policy = new HealthAlertPolicy({ cooldownMs: 1000, degradedConsecutiveThreshold: 3 });
    const sink = vi.fn<Parameters<AlertSink>, void>();

    dispatchAlerts([check('disk_space', 'critical'), check('brain', 'healthy')], policy, sink, 1000);

    expect(sink).toHaveBeenCalledTimes(1);
    const [severity, alerted, kind] = sink.mock.calls[0];
    expect(severity).toBe('critical');
    expect(alerted.name).toBe('disk_space');
    expect(kind).toBe('failure');
  });

  it('emits a recovery event when an alerted check heals', () => {
    const policy = new HealthAlertPolicy({ cooldownMs: 1000, degradedConsecutiveThreshold: 3 });
    const sink = vi.fn<Parameters<AlertSink>, void>();

    dispatchAlerts([check('brain', 'critical')], policy, sink, 1000);
    dispatchAlerts([check('brain', 'healthy')], policy, sink, 2000);

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][2]).toBe('recovery');
  });

  it('is silent across repeated ticks inside the cooldown window', () => {
    const policy = new HealthAlertPolicy({ cooldownMs: 60_000, degradedConsecutiveThreshold: 3 });
    const sink = vi.fn<Parameters<AlertSink>, void>();

    dispatchAlerts([check('brain', 'critical')], policy, sink, 1000);
    dispatchAlerts([check('brain', 'critical')], policy, sink, 2000);
    dispatchAlerts([check('brain', 'critical')], policy, sink, 3000);

    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe('liveness file contract', () => {
  it('LIVENESS_FILE lives under the data dir with the expected name', () => {
    expect(LIVENESS_FILE.endsWith('watchdog-liveness.json')).toBe(true);
  });
});
