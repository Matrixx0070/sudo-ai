/**
 * Seat call-count ceiling (runaway-loop backstop). Seat routes (claude-oauth)
 * are priced $0 in limits.ts, so the USD budget cannot bound them — the policy
 * layer caps raw calls/day instead. Same asymmetry as budgets: user lane
 * degrades (never blocked), background lane fails closed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runWithPolicy, __resetPolicyState, setBudgetAlertSink, type BudgetAlert } from '../../src/llm/policy.js';
import { LLMPolicyError } from '../../src/llm/errors.js';

const SEAT_ROUTE = 'claude-oauth:messages';

function run(priority: 'user' | 'background', route = SEAT_ROUTE): ReturnType<typeof runWithPolicy<string>> {
  return runWithPolicy<string>({
    route,
    caller: 'test-caller',
    priority,
    attempt: async () => 'ok',
  });
}

beforeEach(() => {
  __resetPolicyState();
  process.env['SUDO_SEAT_DAILY_CALL_LIMIT'] = '3';
});
afterEach(() => {
  __resetPolicyState();
  delete process.env['SUDO_SEAT_DAILY_CALL_LIMIT'];
});

describe('seat call-count ceiling', () => {
  it('background seat calls fail closed past the ceiling; alert fires', async () => {
    const alerts: BudgetAlert[] = [];
    setBudgetAlertSink((a) => alerts.push(a));
    for (let i = 0; i < 3; i++) {
      await expect(run('background')).resolves.toMatchObject({ value: 'ok' });
    }
    await expect(run('background')).rejects.toThrow(LLMPolicyError);
    await expect(run('background')).rejects.toThrow(/seat call ceiling/);
    expect(alerts.some((a) => a.verdict === 'seat_calls_exceeded' && a.lane === 'background')).toBe(true);
  });

  it('user seat calls are never blocked — they degrade past the ceiling', async () => {
    for (let i = 0; i < 3; i++) await run('background');
    const out = await run('user');
    expect(out.value).toBe('ok');
    expect(out.budgetDecision).toBe('degrade');
  });

  it('non-seat routes are not counted or capped', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(run('background', 'gateway:chat')).resolves.toMatchObject({ value: 'ok' });
    }
  });

  it("'off' disables the ceiling", async () => {
    process.env['SUDO_SEAT_DAILY_CALL_LIMIT'] = 'off';
    for (let i = 0; i < 6; i++) {
      await expect(run('background')).resolves.toMatchObject({ value: 'ok' });
    }
  });
});
