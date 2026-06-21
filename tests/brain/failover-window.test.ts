/**
 * Failover RETRY WINDOW — the in-call sleep between sequential failover
 * attempts (failoverBackoffMs) + attempt count (MAX_FAILOVER_ATTEMPTS), and the
 * env overrides that let a total upstream overload be ridden out for >60s
 * instead of surfacing "All failover attempts failed" after ~9s.
 *
 * (Distinct from failover-backoff.test.ts, which covers the ModelFailover
 * per-profile COOLDOWN schedule.)
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  failoverBackoffMs,
  FAILOVER_BACKOFF_CAP_MS,
  MAX_FAILOVER_ATTEMPTS,
} from '../../src/core/brain/brain.js';

describe('failoverBackoffMs (call-time behaviour)', () => {
  afterEach(() => {
    delete process.env['SUDO_FAILOVER_BACKOFF_DISABLE'];
  });

  it('only backs off for overloaded/transient/timeout categories', () => {
    expect(failoverBackoffMs('auth', 0)).toBe(0);
    expect(failoverBackoffMs('format', 3)).toBe(0);
    expect(failoverBackoffMs('rate_limit', 2)).toBe(0);
    expect(failoverBackoffMs('overloaded', 0)).toBeGreaterThan(0);
    expect(failoverBackoffMs('transient', 0)).toBeGreaterThan(0);
    expect(failoverBackoffMs('timeout', 0)).toBeGreaterThan(0);
  });

  it('grows exponentially and caps at FAILOVER_BACKOFF_CAP_MS (default 15s)', () => {
    expect(FAILOVER_BACKOFF_CAP_MS).toBe(15_000);
    expect(failoverBackoffMs('overloaded', 0)).toBe(250);
    expect(failoverBackoffMs('overloaded', 3)).toBe(2_000);
    expect(failoverBackoffMs('overloaded', 5)).toBe(8_000);
    expect(failoverBackoffMs('overloaded', 6)).toBe(15_000); // 250*2^6=16000 → capped
    expect(failoverBackoffMs('overloaded', 9)).toBe(15_000);
  });

  it('honours retry-after but caps it at the backoff cap', () => {
    expect(failoverBackoffMs('overloaded', 0, 3_000)).toBe(3_000);
    expect(failoverBackoffMs('overloaded', 0, 99_000)).toBe(15_000);
  });

  it('returns 0 when SUDO_FAILOVER_BACKOFF_DISABLE=1', () => {
    process.env['SUDO_FAILOVER_BACKOFF_DISABLE'] = '1';
    expect(failoverBackoffMs('overloaded', 5)).toBe(0);
  });

  it('defaults to 10 attempts and rides out >60s with the 15s cap', () => {
    expect(MAX_FAILOVER_ATTEMPTS).toBe(10);
    let total = 0;
    for (let a = 0; a < MAX_FAILOVER_ATTEMPTS - 1; a++) total += failoverBackoffMs('overloaded', a);
    expect(total).toBeGreaterThan(60_000);
  });
});

describe('failover window env overrides (module-load)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete process.env['SUDO_FAILOVER_MAX_ATTEMPTS'];
    delete process.env['SUDO_FAILOVER_BACKOFF_CAP_MS'];
    vi.resetModules();
  });

  it('honours SUDO_FAILOVER_MAX_ATTEMPTS and SUDO_FAILOVER_BACKOFF_CAP_MS', async () => {
    process.env['SUDO_FAILOVER_MAX_ATTEMPTS'] = '20';
    process.env['SUDO_FAILOVER_BACKOFF_CAP_MS'] = '30000';
    const m = await import('../../src/core/brain/brain.js');
    expect(m.MAX_FAILOVER_ATTEMPTS).toBe(20);
    expect(m.FAILOVER_BACKOFF_CAP_MS).toBe(30_000);
    expect(m.failoverBackoffMs('overloaded', 9)).toBe(30_000); // 250*2^9=128000 → capped
  });

  it('clamps absurd values to sane bounds', async () => {
    process.env['SUDO_FAILOVER_MAX_ATTEMPTS'] = '999';
    process.env['SUDO_FAILOVER_BACKOFF_CAP_MS'] = '999999';
    const m = await import('../../src/core/brain/brain.js');
    expect(m.MAX_FAILOVER_ATTEMPTS).toBe(30);       // clamped to 30
    expect(m.FAILOVER_BACKOFF_CAP_MS).toBe(60_000); // clamped to 60s
  });
});
