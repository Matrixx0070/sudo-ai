/**
 * @file tests/learning/policy-refresh.test.ts
 * @description Theme 1 follow-up — background (scheduled) policy refresh. The
 * loop periodically calls policy.refreshPolicies() off the request critical path
 * (unref'd timer + setImmediate), clamped, overlap-guarded, fail-open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPolicyRefreshLoop, POLICY_REFRESH_MIN_MS } from '../../src/core/learning/policy-refresh.js';

describe('Theme 1: background policy refresh loop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('PR-1: interval <= 0 or non-finite → disabled, never refreshes', async () => {
    const policy = { refreshPolicies: vi.fn() };
    const stops = [
      startPolicyRefreshLoop(policy, 0),
      startPolicyRefreshLoop(policy, -5),
      startPolicyRefreshLoop(policy, Number.NaN),
    ];
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS * 3);
    expect(policy.refreshPolicies).not.toHaveBeenCalled();
    stops.forEach((s) => expect(s).not.toThrow()); // no-op stops are safe
  });

  it('PR-2: refreshes on schedule', async () => {
    const policy = { refreshPolicies: vi.fn() };
    const stop = startPolicyRefreshLoop(policy, POLICY_REFRESH_MIN_MS);
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS);
    expect(policy.refreshPolicies).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS);
    expect(policy.refreshPolicies).toHaveBeenCalledTimes(2);
    stop();
  });

  it('PR-3: clamps a too-small interval up to the floor', async () => {
    const policy = { refreshPolicies: vi.fn() };
    const stop = startPolicyRefreshLoop(policy, 1000); // below the floor
    await vi.advanceTimersByTimeAsync(1000);
    expect(policy.refreshPolicies).not.toHaveBeenCalled(); // not yet — clamped to MIN
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS - 1000);
    expect(policy.refreshPolicies).toHaveBeenCalledTimes(1);
    stop();
  });

  it('PR-4: fail-open — a throwing refresh calls onError and the loop survives', async () => {
    const policy = { refreshPolicies: vi.fn(() => { throw new Error('boom'); }) };
    const onError = vi.fn();
    const stop = startPolicyRefreshLoop(policy, POLICY_REFRESH_MIN_MS, onError);
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS);
    expect(policy.refreshPolicies).toHaveBeenCalledTimes(2); // still firing
    stop();
  });

  it('PR-5: stop() halts further refreshes', async () => {
    const policy = { refreshPolicies: vi.fn() };
    const stop = startPolicyRefreshLoop(policy, POLICY_REFRESH_MIN_MS);
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS);
    expect(policy.refreshPolicies).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(POLICY_REFRESH_MIN_MS * 3);
    expect(policy.refreshPolicies).toHaveBeenCalledTimes(1); // no more after stop
  });
});
