/**
 * GW-1: persistent LLM budget enforcement.
 *
 * Covers the four cases from the spec test list:
 *  - boot-derivation of today's spend from a seeded gateway.db,
 *  - restart-survival (spend survives a simulated process restart),
 *  - user-lane degrade vs background-lane skip at the cap,
 *  - cost estimation + NULL-cost tolerance in day-spend derivation.
 *
 * Only Date is faked so lane microtasks stay real; sleep is injected.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayCallLog } from '../../src/llm/logging.js';
import {
  runWithPolicy,
  getSpend,
  initDaySpendFromHistory,
  isGlobalBudgetEnforced,
  __resetPolicyState,
} from '../../src/llm/policy.js';
import { estimateCostUsd } from '../../src/llm/limits.js';
import { LLMPolicyError } from '../../src/llm/errors.js';

const TODAY = '2026-07-18';
const instantSleep = (): Promise<void> => Promise.resolve();

let dir: string;
let dbPath: string;

const ENV_KEYS = ['SUDO_DAILY_LLM_BUDGET_USD', 'SUDO_LLM_GLOBAL_BUDGET_USD'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(path.join(tmpdir(), 'gw1-'));
  dbPath = path.join(dir, 'gateway.db');
  __resetPolicyState();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetPolicyState();
  rmSync(dir, { recursive: true, force: true });
});

function seed(log: GatewayCallLog, caller: string, costUsd: number | undefined, id: string): void {
  log.record({
    traceId: id,
    ts: `${TODAY}T10:00:00.000Z`,
    caller,
    route: 'xai/grok-4-fast',
    tokensIn: 1000,
    tokensOut: 1000,
    ...(costUsd !== undefined ? { costUsd } : {}),
  });
}

describe('GW-1 cost estimation (limits.ts)', () => {
  it('prices a known cheap model from token counts', () => {
    // grok-4-fast: 0.2/M in, 0.5/M out → 1M in + 1M out = 0.2 + 0.5 = 0.7
    expect(estimateCostUsd('xai/grok-4-fast', 1_000_000, 1_000_000)).toBeCloseTo(0.7, 6);
  });
  it('prices via alias resolution', () => {
    // sudo/cheap → xai/grok-4-fast-non-reasoning (0.2/0.5)
    expect(estimateCostUsd('sudo/cheap', 1_000_000, 0)).toBeCloseTo(0.2, 6);
  });
  it('costs nothing for local ollama', () => {
    expect(estimateCostUsd('ollama/llama3.2', 5_000_000, 5_000_000)).toBe(0);
  });
  it('falls back to a mid-tier estimate for unknown models', () => {
    expect(estimateCostUsd('someprovider/unknown-model', 1_000_000, 0)).toBeGreaterThan(0);
  });
});

describe('GW-1 day-spend derivation (logging.ts)', () => {
  it('sums today rows by caller key and total', () => {
    const log = new GatewayCallLog(dbPath);
    seed(log, 'agent-loop', 0.5, 'a1');
    seed(log, 'swarm:researcher', 0.25, 's1');
    seed(log, 'swarm:writer', 0.25, 's2');
    const { total, byCaller } = log.daySpend(TODAY);
    log.close();
    expect(total).toBeCloseTo(1.0, 6);
    expect(byCaller.get('agent-loop')).toBeCloseTo(0.5, 6);
    // swarm:* collapses to caller key 'swarm'
    expect(byCaller.get('swarm')).toBeCloseTo(0.5, 6);
  });

  it('ignores rows from other days', () => {
    const log = new GatewayCallLog(dbPath);
    log.record({ traceId: 'y1', ts: '2026-07-17T10:00:00.000Z', caller: 'agent-loop', costUsd: 9.0 });
    seed(log, 'agent-loop', 0.5, 'a1');
    const { total } = log.daySpend(TODAY);
    log.close();
    expect(total).toBeCloseTo(0.5, 6);
  });

  it('tolerates NULL cost rows (counts them as 0, never throws)', () => {
    const log = new GatewayCallLog(dbPath);
    seed(log, 'agent-loop', undefined, 'a1'); // no explicit cost → stored as NULL
    seed(log, 'cognitive-stream', 0, 'c1'); // explicit zero
    const { total } = log.daySpend(TODAY);
    log.close();
    // record() does not estimate (that's transport's job); NULL + 0 both add 0.
    expect(total).toBe(0);
    expect(Number.isFinite(total)).toBe(true);
  });
});

describe('GW-1 restart survival', () => {
  it('re-derives today spend from a fresh handle on the same db', () => {
    const log1 = new GatewayCallLog(dbPath);
    seed(log1, 'agent-loop', 0.75, 'a1');
    log1.close(); // simulate process exit

    // "restart": brand new handle, same file.
    const log2 = new GatewayCallLog(dbPath);
    const { total, byCaller } = log2.daySpend(TODAY);
    log2.close();
    expect(total).toBeCloseTo(0.75, 6);

    // Boot seeds the in-memory policy counter from the derived numbers.
    initDaySpendFromHistory({ day: TODAY, total, byCaller });
    expect(getSpend('agent-loop')).toBeCloseTo(0.75, 6);
  });

  it('ignores a stale (wrong-day) seed', () => {
    initDaySpendFromHistory({ day: '2026-07-17', total: 99, byCaller: new Map() });
    expect(getSpend('agent-loop')).toBe(0);
  });
});

describe('GW-1 enforcement asymmetry at cap', () => {
  it('isGlobalBudgetEnforced reads SUDO_DAILY_LLM_BUDGET_USD', () => {
    expect(isGlobalBudgetEnforced()).toBe(false);
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = '10';
    expect(isGlobalBudgetEnforced()).toBe(true);
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = 'off';
    expect(isGlobalBudgetEnforced()).toBe(false);
  });

  it('user call over global budget DEGRADES (never blocked)', async () => {
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = '1';
    initDaySpendFromHistory({ day: TODAY, total: 5, byCaller: new Map([['swarm', 5]]) });
    const outcome = await runWithPolicy<string>({
      route: 'gateway:chat',
      caller: 'swarm:researcher',
      priority: 'user',
      estimateCostUsd: 0.5,
      attempt: async () => 'ok',
      sleep: instantSleep,
    });
    expect(outcome.value).toBe('ok');
    expect(outcome.budgetDecision).toBe('degrade');
  });

  it('background call over global budget FAILS CLOSED (skipped)', async () => {
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = '1';
    initDaySpendFromHistory({ day: TODAY, total: 5, byCaller: new Map([['cognitive-stream', 5]]) });
    await expect(
      runWithPolicy<string>({
        route: 'gateway:chat',
        caller: 'cognitive-stream',
        priority: 'background',
        estimateCostUsd: 0.5,
        attempt: async () => 'ok',
        sleep: instantSleep,
      }),
    ).rejects.toMatchObject({ skipped: true });
  });

  it('background call UNDER budget runs', async () => {
    process.env['SUDO_DAILY_LLM_BUDGET_USD'] = '100';
    const outcome = await runWithPolicy<string>({
      route: 'gateway:chat',
      caller: 'cognitive-stream',
      priority: 'background',
      estimateCostUsd: 0.5,
      attempt: async () => 'ok',
      sleep: instantSleep,
    });
    expect(outcome.value).toBe('ok');
    expect(outcome.budgetDecision).toBe('ok');
  });
});

// Guard: LLMPolicyError shape is what the skip assertions rely on.
it('LLMPolicyError carries skipped flag', () => {
  const e = new LLMPolicyError('x', { class: 'billing', route: 'r', retryable: false, skipped: true });
  expect(e.skipped).toBe(true);
});
