/**
 * retry-policy — the fourth verify mode (forward-looking sequence analysis). Proves the
 * recovery classification (failure → recovery action → successful retry), the ordering
 * requirement, the forward window, session isolation, and the reused gate.
 */
import { describe, it, expect } from 'vitest';
import {
  verifyRetryPolicy, decideRetryPolicyAdoption, makeBrowserRefRetryPolicy, RETRY_POLICIES,
} from '../../src/core/learning/retry-policy.js';
import type { ToolEvent } from '../../src/core/learning/workflow-order.js';

const policy = makeBrowserRefRetryPolicy();
const REF = 'browser.click: ref=3 not found on the page. The page may have re-rendered.';
const ev = (sessionId: string, tool: string, success: boolean, sec: number): ToolEvent =>
  ({ sessionId, tool, success, errorMessage: success ? '' : REF, createdAtMs: sec * 1000 });

describe('makeBrowserRefRetryPolicy', () => {
  it('targets the stale-ref cluster with snapshot→click recovery', () => {
    expect(policy.tool).toBe('browser.click');
    expect(policy.errorPattern).toBe('not found on the page');
    expect(policy.recoveryTool('browser.snapshot')).toBe(true);
    expect(policy.retryTool('browser.click')).toBe(true);
  });
});

describe('verifyRetryPolicy', () => {
  it('failure → snapshot(ok) → click(ok) in window → RECOVERED', () => {
    const r = verifyRetryPolicy([
      ev('s', 'browser.click', false, 1),
      ev('s', 'browser.snapshot', true, 5),
      ev('s', 'browser.click', true, 9),
    ], policy);
    expect(r.failures).toBe(1);
    expect(r.recovered).toBe(1);
    expect(r.recoveryPct).toBe(100);
  });

  it('a successful retry WITHOUT a re-snapshot is NOT attributed to the policy', () => {
    const r = verifyRetryPolicy([
      ev('s', 'browser.click', false, 1),
      ev('s', 'browser.click', true, 5), // retried the stale ref, no snapshot between
    ], policy);
    expect(r.recovered).toBe(0);
  });

  it('snapshot then a FAILED retry → not recovered', () => {
    const r = verifyRetryPolicy([
      ev('s', 'browser.click', false, 1),
      ev('s', 'browser.snapshot', true, 5),
      ev('s', 'browser.click', false, 9),
    ], policy);
    expect(r.recovered).toBe(0);
  });

  it('recovery OUTSIDE the forward window does not count', () => {
    const r = verifyRetryPolicy([
      ev('s', 'browser.click', false, 0),
      ev('s', 'browser.snapshot', true, 4 * 60),  // > 3 min window
      ev('s', 'browser.click', true, 4 * 60 + 5),
    ], policy);
    expect(r.recovered).toBe(0);
  });

  it('the recovery must come AFTER the failure (a prior snapshot does not count)', () => {
    const r = verifyRetryPolicy([
      ev('s', 'browser.snapshot', true, 1),        // before the failure
      ev('s', 'browser.click', false, 5),
      ev('s', 'browser.click', true, 9),           // retry, but no snapshot AFTER the failure
    ], policy);
    expect(r.recovered).toBe(0);
  });

  it('recovery in another session does not count (session isolation)', () => {
    const r = verifyRetryPolicy([
      ev('s', 'browser.click', false, 1),
      ev('other', 'browser.snapshot', true, 3),
      ev('other', 'browser.click', true, 5),
    ], policy);
    expect(r.recovered).toBe(0);
    expect(r.sessionsSeen).toBe(2);
  });
});

describe('decideRetryPolicyAdoption (reuses the shared gate)', () => {
  it('adopts a strongly-recovering policy, rejects a weak one, defers thin data', () => {
    expect(decideRetryPolicyAdoption({ failures: 25, recovered: 22, unrecovered: 3, recoveryPct: 88, sessionsSeen: 20 })).toBe('adopt');
    expect(decideRetryPolicyAdoption({ failures: 25, recovered: 10, unrecovered: 15, recoveryPct: 40, sessionsSeen: 20 })).toBe('reject');
    expect(decideRetryPolicyAdoption({ failures: 4, recovered: 1, unrecovered: 3, recoveryPct: 25, sessionsSeen: 3 })).toBe('insufficient-data');
  });
  it('registers the browser ref retry policy', () => {
    expect(RETRY_POLICIES.map((p) => p.policyId)).toContain('browser-ref-resnapshot-retry');
  });
});
