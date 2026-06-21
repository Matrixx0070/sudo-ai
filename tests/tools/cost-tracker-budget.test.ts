/**
 * Tests for resolveDailyLimit — the check-budget argument resolver in
 * meta.cost-tracker.
 *
 * The live bug: the heartbeat cost-check calls check-budget with NO dailyLimit,
 * the tool returned "dailyLimit is required", SUDO fell back to `today` every
 * tick, and the repetition tripped the doom-loop detector. The fix makes an
 * omitted limit fall back to SUDO_DAILY_BUDGET_USD and report "disabled" cleanly
 * when no cap is set — while still accepting an explicit number or numeric string.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDailyLimit } from '../../src/core/tools/builtin/meta/cost-tracker.js';
import { DEFAULT_DAILY_BUDGET_USD } from '../../src/core/billing/daily-budget.js';

const ENV_KEY = 'SUDO_DAILY_BUDGET_USD';
let saved: string | undefined;

beforeEach(() => { saved = process.env[ENV_KEY]; });
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe('resolveDailyLimit — no explicit argument (heartbeat path)', () => {
  it('falls back to the default budget when env is unset', () => {
    delete process.env[ENV_KEY];
    expect(resolveDailyLimit(undefined)).toEqual({ kind: 'limit', limit: DEFAULT_DAILY_BUDGET_USD });
  });

  it('falls back to a configured positive budget', () => {
    process.env[ENV_KEY] = '12.5';
    expect(resolveDailyLimit(undefined)).toEqual({ kind: 'limit', limit: 12.5 });
  });

  it('reports disabled for the off sentinel (no error → no doom loop)', () => {
    process.env[ENV_KEY] = 'off';
    expect(resolveDailyLimit(undefined)).toEqual({ kind: 'disabled' });
  });

  it('reports disabled for a zero / non-positive budget', () => {
    process.env[ENV_KEY] = '0';
    expect(resolveDailyLimit(null)).toEqual({ kind: 'disabled' });
  });

  it('treats an empty / whitespace string like an omitted argument', () => {
    process.env[ENV_KEY] = 'off';
    expect(resolveDailyLimit('')).toEqual({ kind: 'disabled' });
    expect(resolveDailyLimit('   ')).toEqual({ kind: 'disabled' });
  });
});

describe('resolveDailyLimit — explicit argument wins', () => {
  it('accepts a number', () => {
    process.env[ENV_KEY] = 'off'; // ignored — explicit arg wins
    expect(resolveDailyLimit(3.5)).toEqual({ kind: 'limit', limit: 3.5 });
  });

  it('coerces a numeric string (SUDO\'s string-vs-number hypothesis)', () => {
    delete process.env[ENV_KEY];
    expect(resolveDailyLimit('5.00')).toEqual({ kind: 'limit', limit: 5 });
  });

  it('treats an explicit 0 as a literal $0 cap, not "disabled"', () => {
    delete process.env[ENV_KEY];
    expect(resolveDailyLimit(0)).toEqual({ kind: 'limit', limit: 0 });
  });

  it('rejects a non-numeric string', () => {
    const r = resolveDailyLimit('abc');
    expect(r.kind).toBe('error');
  });

  it('rejects a negative number', () => {
    const r = resolveDailyLimit(-1);
    expect(r.kind).toBe('error');
  });
});
