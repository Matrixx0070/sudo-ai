/**
 * @file tests/health/alert-policy.test.ts
 * @description Tests for HealthAlertPolicy — cooldown, degraded threshold,
 *   recovery-once semantics.
 */

import { describe, it, expect } from 'vitest';
import { HealthAlertPolicy } from '../../src/core/health/alert-policy.js';

const COOLDOWN = 45 * 60 * 1000;
const REMINDER = 24 * 60 * 60 * 1000;

function makePolicy(): HealthAlertPolicy {
  return new HealthAlertPolicy({ cooldownMs: COOLDOWN, degradedConsecutiveThreshold: 3, reminderMs: REMINDER });
}

describe('HealthAlertPolicy', () => {
  it('critical alerts on the first tick', () => {
    const p = makePolicy();
    expect(p.onCheckResult('disk_space', 'critical', 1000)).toEqual({
      action: 'alert',
      severity: 'critical',
    });
  });

  it('an unchanged broken state does NOT re-alert on cooldown (2026-07-18 anti-spam fix)', () => {
    const p = makePolicy();
    expect(p.onCheckResult('disk_space', 'critical', 1000).action).toBe('alert');
    expect(p.onCheckResult('disk_space', 'critical', 1000 + 60_000).action).toBe('none');
    // Cooldown elapsing is NOT enough — the state is unchanged (this exact
    // pattern produced 200+ identical Telegram messages/day).
    expect(p.onCheckResult('disk_space', 'critical', 1000 + COOLDOWN).action).toBe('none');
    expect(p.onCheckResult('disk_space', 'critical', 1000 + 6 * COOLDOWN).action).toBe('none');
    // The daily reminder does fire.
    expect(p.onCheckResult('disk_space', 'critical', 1000 + REMINDER).action).toBe('alert');
  });

  it('degraded→critical escalation alerts immediately, even inside the cooldown', () => {
    const p = makePolicy();
    p.onCheckResult('brain', 'degraded', 1000);
    p.onCheckResult('brain', 'degraded', 2000);
    expect(p.onCheckResult('brain', 'degraded', COOLDOWN + 1000).action).toBe('alert'); // first high
    const esc = p.onCheckResult('brain', 'critical', COOLDOWN + 2000);
    expect(esc).toEqual({ action: 'alert', severity: 'critical' });
  });

  it('critical→degraded de-escalation stays silent until recovery', () => {
    const p = makePolicy();
    expect(p.onCheckResult('brain', 'critical', 1000).action).toBe('alert');
    for (const t of [2000, 3000, 4000]) {
      expect(p.onCheckResult('brain', 'degraded', t).action).toBe('none');
    }
    expect(p.onCheckResult('brain', 'healthy', 5000).action).toBe('recovered');
  });

  it('degraded needs 3 consecutive ticks before alerting', () => {
    const p = makePolicy();
    expect(p.onCheckResult('memory', 'degraded', 1000).action).toBe('none');
    expect(p.onCheckResult('memory', 'degraded', 61_000).action).toBe('none');
    expect(p.onCheckResult('memory', 'degraded', 121_000)).toEqual({
      action: 'alert',
      severity: 'high',
    });
  });

  it('a healthy tick resets the degraded streak', () => {
    const p = makePolicy();
    p.onCheckResult('memory', 'degraded', 1000);
    p.onCheckResult('memory', 'degraded', 61_000);
    p.onCheckResult('memory', 'healthy', 121_000);
    // Streak restarted — two more degraded ticks are not enough.
    expect(p.onCheckResult('memory', 'degraded', 181_000).action).toBe('none');
    expect(p.onCheckResult('memory', 'degraded', 241_000).action).toBe('none');
  });

  it('recovery fires once after an alerted check heals, then stays silent', () => {
    const p = makePolicy();
    p.onCheckResult('brain', 'critical', 1000);
    expect(p.onCheckResult('brain', 'healthy', 61_000)).toEqual({ action: 'recovered' });
    expect(p.onCheckResult('brain', 'healthy', 121_000)).toEqual({ action: 'none' });
  });

  it('suppressed (cooldown) criticals still mark the check as alerted for recovery', () => {
    const p = makePolicy();
    p.onCheckResult('brain', 'critical', 1000); // alert
    p.onCheckResult('brain', 'critical', 61_000); // suppressed by cooldown
    expect(p.onCheckResult('brain', 'healthy', 121_000)).toEqual({ action: 'recovered' });
  });

  it('never-alerted healthy checks produce no recovery', () => {
    const p = makePolicy();
    expect(p.onCheckResult('databases', 'healthy', 1000)).toEqual({ action: 'none' });
  });

  it('checks are independent', () => {
    const p = makePolicy();
    p.onCheckResult('brain', 'critical', 1000);
    expect(p.onCheckResult('disk_space', 'critical', 1000).action).toBe('alert');
  });
});
