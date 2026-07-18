/**
 * GW-1 MEDIUM-1: the spend-ACCRUAL path is exercised for real.
 *
 * gw1-budget.test.ts only ever seeds the in-memory counter via
 * initDaySpendFromHistory — so deleting the recordSpend() call inside the
 * transport accrual choke point would leave that suite green. This test drives
 * the real path a live call takes:
 *
 *   __recordCallForBudgetTest(entry)   [transport.ts recordCall]
 *     → withEstimatedCost(entry)       [transport.ts: tokens → USD]
 *     → recordGatewayCall / getGatewayCallLog().record()  [logging.ts]
 *     → recordSpend(caller, usd)       [policy.ts in-memory counter]
 *
 * and asserts getSpend() rises by exactly the estimated cost. Remove the
 * recordSpend() call in transport.ts and this test goes red.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __recordCallForBudgetTest } from '../../src/llm/transport.js';
import { getGatewayCallLog, __resetGatewayCallLog } from '../../src/llm/logging.js';
import { getSpend, __resetPolicyState } from '../../src/llm/policy.js';
import { estimateCostUsd } from '../../src/llm/limits.js';

const ROUTE = 'xai/grok-4-fast';
const TOKENS_IN = 500_000;
const TOKENS_OUT = 500_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gw1-accrual-'));
  dbPath = path.join(dir, 'gateway.db');
  __resetPolicyState();
  __resetGatewayCallLog();
  getGatewayCallLog(dbPath); // pin the singleton to the temp DB (no real-workspace writes)
});

afterEach(() => {
  __resetGatewayCallLog();
  __resetPolicyState();
  rmSync(dir, { recursive: true, force: true });
});

describe('GW-1 spend accrues through the real recordCall path', () => {
  it('getSpend rises by the estimated cost after a simulated call (no seed)', () => {
    const caller = 'agent-loop';
    expect(getSpend(caller)).toBe(0); // nothing seeded

    const expected = estimateCostUsd(ROUTE, TOKENS_IN, TOKENS_OUT);
    expect(expected).toBeGreaterThan(0); // guard: the fixture must have a real cost

    __recordCallForBudgetTest({
      traceId: 'accrual-1',
      caller,
      route: ROUTE,
      tokensIn: TOKENS_IN,
      tokensOut: TOKENS_OUT,
      // deliberately NO costUsd → withEstimatedCost must derive it
    });

    // If the recordSpend() call in transport.ts.recordCall is removed, this stays 0.
    expect(getSpend(caller)).toBeCloseTo(expected, 9);
  });

  it('accumulates across calls and collapses swarm:* to the caller key', () => {
    const per = estimateCostUsd(ROUTE, TOKENS_IN, TOKENS_OUT);
    __recordCallForBudgetTest({ traceId: 'a', caller: 'swarm:researcher', route: ROUTE, tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT });
    __recordCallForBudgetTest({ traceId: 'b', caller: 'swarm:writer', route: ROUTE, tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT });
    expect(getSpend('swarm')).toBeCloseTo(per * 2, 9);
  });

  it('a zero-token error row does not move the counter', () => {
    __recordCallForBudgetTest({ traceId: 'err', caller: 'agent-loop', route: ROUTE, errorClass: 'overloaded' });
    expect(getSpend('agent-loop')).toBe(0);
  });
});
