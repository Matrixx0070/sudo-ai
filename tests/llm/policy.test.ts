/**
 * gw-refactor Phase 4: runWithPolicy — retry (pre-first-token only), per-route
 * circuit breaker with user pass-through, priority lanes with per-caller caps,
 * and asymmetric budgets. Only Date is faked (vi.useFakeTimers toFake:['Date'])
 * so lane microtasks/setTimeout stay real; sleep is always injected — no real
 * waits over 50ms anywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runWithPolicy,
  recordSpend,
  getSpend,
  degradeAlias,
  __resetPolicyState,
  type AttemptContext,
} from '../../src/llm/policy.js';
import { LLMPolicyError } from '../../src/llm/errors.js';

const instantSleep = (): Promise<void> => Promise.resolve();
const midRng = (): number => 0.5; // jitter factor exactly 1.0
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const ENV_KEYS = [
  'SUDO_LLM_RETRY_DISABLE',
  'SUDO_LLM_LANE_CAPS',
  'SUDO_LLM_BUDGETS',
  'SUDO_LLM_GLOBAL_BUDGET_USD',
  'SUDO_LLM_BACKGROUND_HALT',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetPolicyState();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetPolicyState();
});

interface RunOverrides {
  route?: string;
  caller?: string;
  priority?: 'user' | 'background';
  estimateCostUsd?: number;
  attempt?: (ctx: AttemptContext) => Promise<string>;
  classify?: () => 'overloaded' | 'auth';
  sleeps?: number[];
}

function run(o: RunOverrides = {}): ReturnType<typeof runWithPolicy<string>> {
  return runWithPolicy<string>({
    route: o.route ?? 'gateway:chat',
    caller: o.caller ?? 'test-caller',
    priority: o.priority ?? 'background',
    ...(o.estimateCostUsd !== undefined ? { estimateCostUsd: o.estimateCostUsd } : {}),
    attempt: o.attempt ?? (async () => 'ok'),
    ...(o.classify !== undefined ? { classify: o.classify } : {}),
    rng: midRng,
    sleep: async (ms) => {
      o.sleeps?.push(ms);
      await instantSleep();
    },
  });
}

/** One failed call: non-retryable class → single attempt, one breaker failure. */
async function failOnce(route: string, priority: 'user' | 'background' = 'background'): Promise<void> {
  await expect(
    run({ route, priority, attempt: async () => { throw new Error('boom'); }, classify: () => 'auth' }),
  ).rejects.toThrow('boom');
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe('retry', () => {
  it('retries retryable failures with exponential backoff, max 3 attempts (success on 3rd)', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const out = await run({
      sleeps,
      classify: () => 'overloaded',
      attempt: async () => {
        calls++;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
    });
    expect(out.value).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([250, 500]); // 250*2^n, rng 0.5 → zero jitter
  });

  it('gives up after 3 attempts and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      run({ classify: () => 'overloaded', attempt: async () => { calls++; throw new Error(`fail${calls}`); } }),
    ).rejects.toThrow('fail3');
    expect(calls).toBe(3);
  });

  it('applies ±20% jitter from the injected RNG', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await runWithPolicy<string>({
      route: 'gateway:chat',
      caller: 'test-caller',
      priority: 'background',
      classify: () => 'overloaded',
      attempt: async () => {
        calls++;
        if (calls < 2) throw new Error('flaky');
        return 'ok';
      },
      rng: () => 1, // max jitter → factor 1.2
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(sleeps).toEqual([300]); // 250 * 1.2
  });

  it('does NOT retry non-retryable classes', async () => {
    let calls = 0;
    await expect(
      run({ classify: () => 'auth', attempt: async () => { calls++; throw new Error('denied'); } }),
    ).rejects.toThrow('denied');
    expect(calls).toBe(1);
  });

  it('never retries after markFirstToken — error is terminal', async () => {
    let calls = 0;
    await expect(
      run({
        classify: () => 'overloaded',
        attempt: async (ctx) => {
          calls++;
          ctx.markFirstToken();
          throw new Error('mid-stream');
        },
      }),
    ).rejects.toThrow('mid-stream');
    expect(calls).toBe(1);
  });

  it('still retries when the failure happens before the first token', async () => {
    let calls = 0;
    const out = await run({
      classify: () => 'overloaded',
      attempt: async (ctx) => {
        calls++;
        if (calls === 1) throw new Error('pre-token'); // no markFirstToken yet
        ctx.markFirstToken();
        return 'ok';
      },
    });
    expect(out.value).toBe('ok');
    expect(calls).toBe(2);
  });

  it('fires onFirstToken exactly once', async () => {
    const seen = vi.fn();
    await runWithPolicy<string>({
      route: 'gateway:chat',
      caller: 'test-caller',
      priority: 'user',
      onFirstToken: seen,
      attempt: async (ctx) => {
        ctx.markFirstToken();
        ctx.markFirstToken();
        return 'ok';
      },
      sleep: instantSleep,
      rng: midRng,
    });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('SUDO_LLM_RETRY_DISABLE=1 → single attempt even for retryable classes', async () => {
    process.env['SUDO_LLM_RETRY_DISABLE'] = '1';
    let calls = 0;
    await expect(
      run({ classify: () => 'overloaded', attempt: async () => { calls++; throw new Error('once'); } }),
    ).rejects.toThrow('once');
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe('circuit breaker', () => {
  const ROUTE = 'anthropic:messages';

  async function openBreaker(): Promise<void> {
    for (let i = 0; i < 5; i++) await failOnce(ROUTE);
  }

  it('opens after 5 failures in 60s: background skipped with .skipped=true', async () => {
    await openBreaker();
    const err = await run({ route: ROUTE, priority: 'background' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('overloaded');
    expect((err as LLMPolicyError).skipped).toBe(true);
    expect((err as LLMPolicyError).retryable).toBe(false);
  });

  it('does not open on 5 failures spread beyond the 60s window', async () => {
    for (let i = 0; i < 4; i++) await failOnce(ROUTE);
    vi.advanceTimersByTime(61_000);
    await failOnce(ROUTE); // old 4 pruned — only 1 in window
    const out = await run({ route: ROUTE, priority: 'background' });
    expect(out.value).toBe('ok');
  });

  it('open breaker: user calls pass through', async () => {
    await openBreaker();
    let attempted = false;
    const out = await run({ route: ROUTE, priority: 'user', attempt: async () => { attempted = true; return 'ok'; } });
    expect(attempted).toBe(true);
    expect(out.value).toBe('ok');
  });

  it('half-open after 30s: successful probe closes the breaker', async () => {
    await openBreaker();
    vi.advanceTimersByTime(30_001);
    const probe = await run({ route: ROUTE, priority: 'background' }); // the single probe
    expect(probe.value).toBe('ok');
    // Closed again — background flows without another wait.
    const next = await run({ route: ROUTE, priority: 'background' });
    expect(next.value).toBe('ok');
  });

  it('half-open: failed probe re-opens for another 30s', async () => {
    await openBreaker();
    vi.advanceTimersByTime(30_001);
    await failOnce(ROUTE); // probe fails → re-open
    await expect(run({ route: ROUTE, priority: 'background' })).rejects.toMatchObject({
      skipped: true,
      class: 'overloaded',
    });
    vi.advanceTimersByTime(30_001);
    const out = await run({ route: ROUTE, priority: 'background' });
    expect(out.value).toBe('ok'); // second probe succeeds → closed
  });

  it('is per-route: an open breaker on one route does not affect another', async () => {
    await openBreaker();
    const out = await run({ route: 'gateway:chat', priority: 'background' });
    expect(out.value).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Priority lanes + per-caller caps
// ---------------------------------------------------------------------------

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('priority lanes', () => {
  it('caps swarm:* at 3 concurrent — the 4th waits until a release', async () => {
    const gate = deferred();
    const started: string[] = [];
    const swarmCall = (name: string): ReturnType<typeof runWithPolicy<string>> =>
      run({
        route: 'gateway:chat',
        caller: `swarm:${name}`,
        attempt: async () => { started.push(name); await gate.promise; return name; },
      });
    const p = [swarmCall('a'), swarmCall('b'), swarmCall('c'), swarmCall('d')];
    await tick();
    expect(started).toEqual(['a', 'b', 'c']); // cap 3 — 'd' queued
    gate.resolve();
    const values = (await Promise.all(p)).map((o) => o.value);
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    expect(values).toEqual(['a', 'b', 'c', 'd']);
  });

  it('user preempts queued background on a contended route (cognitive-stream cap 1)', async () => {
    const gate = deferred();
    const started: string[] = [];
    const call = (name: string, priority: 'user' | 'background'): ReturnType<typeof runWithPolicy<string>> =>
      run({
        route: 'gateway:chat',
        caller: 'cognitive-stream',
        priority,
        attempt: async () => {
          started.push(name);
          if (name === 'first') await gate.promise;
          return name;
        },
      });
    const p1 = call('first', 'background');
    await tick();
    const p2 = call('bg-queued', 'background');
    const p3 = call('user-late', 'user');
    await tick();
    expect(started).toEqual(['first']); // cap 1 — both queued
    gate.resolve();
    await Promise.all([p1, p2, p3]);
    // The later USER call acquired before the earlier queued background one.
    expect(started).toEqual(['first', 'user-late', 'bg-queued']);
  });

  it('honors SUDO_LLM_LANE_CAPS overrides', async () => {
    process.env['SUDO_LLM_LANE_CAPS'] = '{"swarm":1}';
    const gate = deferred();
    const started: string[] = [];
    const p1 = run({ caller: 'swarm:a', attempt: async () => { started.push('a'); await gate.promise; return 'a'; } });
    await tick();
    const p2 = run({ caller: 'swarm:b', attempt: async () => { started.push('b'); return 'b'; } });
    await tick();
    expect(started).toEqual(['a']); // cap tightened to 1
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(started).toEqual(['a', 'b']);
  });

  it('uncapped callers run unlimited concurrently', async () => {
    const gate = deferred();
    const started: string[] = [];
    const p = Array.from({ length: 5 }, (_, i) =>
      run({ caller: 'agent-loop', attempt: async () => { started.push(String(i)); await gate.promise; return 'x'; } }),
    );
    await tick();
    expect(started).toHaveLength(5);
    gate.resolve();
    await Promise.all(p);
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe('budgets', () => {
  it('recordSpend/getSpend accumulate per caller key (prefix before ":")', () => {
    recordSpend('swarm:researcher', 1.25);
    recordSpend('swarm:coder', 0.75);
    expect(getSpend('swarm:anything')).toBe(2);
  });

  it('background over per-caller budget → skipped LLMPolicyError class billing', async () => {
    process.env['SUDO_LLM_BUDGETS'] = '{"swarm": 1}';
    recordSpend('swarm:researcher', 2);
    await expect(run({ caller: 'swarm:researcher', priority: 'background' })).rejects.toMatchObject({
      class: 'billing',
      skipped: true,
      retryable: false,
    });
  });

  it('user over per-caller budget → NOT blocked: runs with degrade decision', async () => {
    process.env['SUDO_LLM_BUDGETS'] = '{"swarm": 1}';
    recordSpend('swarm:researcher', 2);
    let ctxDecision = '';
    const out = await run({
      caller: 'swarm:researcher',
      priority: 'user',
      attempt: async (ctx) => { ctxDecision = ctx.budgetDecision; return 'ok'; },
    });
    expect(out.value).toBe('ok');
    expect(out.budgetDecision).toBe('degrade');
    expect(ctxDecision).toBe('degrade');
  });

  it('estimateCostUsd counts against the budget pre-flight', async () => {
    process.env['SUDO_LLM_BUDGETS'] = '{"swarm": 1}';
    await expect(
      run({ caller: 'swarm:x', priority: 'background', estimateCostUsd: 1.5 }),
    ).rejects.toMatchObject({ skipped: true, class: 'billing' });
    // Under the cap → fine.
    const out = await run({ caller: 'swarm:x', priority: 'background', estimateCostUsd: 0.5 });
    expect(out.value).toBe('ok');
  });

  it('degradeAlias steps frontier → mid → cheap → local and pins at local', () => {
    expect(degradeAlias('sudo/frontier')).toBe('sudo/mid');
    expect(degradeAlias('sudo/mid')).toBe('sudo/cheap');
    expect(degradeAlias('sudo/cheap')).toBe('sudo/local');
    expect(degradeAlias('sudo/local')).toBe('sudo/local');
    expect(degradeAlias('anthropic/claude-opus-4-8')).toBe('anthropic/claude-opus-4-8');
  });

  // GW-1: user priority is NEVER blocked by budget — over the global cap it
  // DEGRADES (runs on a cheaper alias) instead of halting. Background over the
  // cap still fails closed. agent-loop is exempt from the global cap entirely.
  it('global cap degrades user, skips background, exempts agent-loop', async () => {
    process.env['SUDO_LLM_GLOBAL_BUDGET_USD'] = '1';
    recordSpend('whatever', 2);
    const degraded = await run({ caller: 'swarm:x', priority: 'user' });
    expect(degraded.value).toBe('ok');
    expect(degraded.budgetDecision).toBe('degrade');
    await expect(run({ caller: 'cron:daily', priority: 'background' })).rejects.toMatchObject({
      skipped: true,
    });
    const out = await run({ caller: 'agent-loop', priority: 'user' });
    expect(out.value).toBe('ok');
  });

  it('SUDO_LLM_BACKGROUND_HALT=1 skips ALL background calls, user unaffected', async () => {
    process.env['SUDO_LLM_BACKGROUND_HALT'] = '1';
    await expect(run({ caller: 'agent-loop', priority: 'background' })).rejects.toMatchObject({
      skipped: true,
    });
    const out = await run({ caller: 'swarm:x', priority: 'user' });
    expect(out.value).toBe('ok');
  });

  it('spend resets on day rollover', async () => {
    process.env['SUDO_LLM_BUDGETS'] = '{"swarm": 1}';
    recordSpend('swarm:x', 2);
    vi.setSystemTime(new Date('2026-07-15T00:00:01Z'));
    expect(getSpend('swarm:x')).toBe(0);
    const out = await run({ caller: 'swarm:x', priority: 'background' });
    expect(out.value).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Fail-open on malformed policy config
// ---------------------------------------------------------------------------

describe('fail-open', () => {
  it('malformed SUDO_LLM_LANE_CAPS / SUDO_LLM_BUDGETS never block a call', async () => {
    process.env['SUDO_LLM_LANE_CAPS'] = 'not-json';
    process.env['SUDO_LLM_BUDGETS'] = '{broken';
    const out = await run({ caller: 'swarm:x', priority: 'user' });
    expect(out.value).toBe('ok');
    expect(out.budgetDecision).toBe('ok');
  });

  it('a throwing onFirstToken hook does not fail the call', async () => {
    const out = await runWithPolicy<string>({
      route: 'gateway:chat',
      caller: 'test-caller',
      priority: 'user',
      onFirstToken: () => { throw new Error('hook bug'); },
      attempt: async (ctx) => { ctx.markFirstToken(); return 'ok'; },
      sleep: instantSleep,
      rng: midRng,
    });
    expect(out.value).toBe('ok');
  });
});
