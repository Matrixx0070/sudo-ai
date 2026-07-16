import { describe, it, expect } from 'vitest';
import { TokenBucketLimiter } from '../../src/core/gdrive/rate-limiter.js';

/** Fake-clock harness: manual time + manually-fired scheduler. */
function harness(rps: number, burst: number) {
  let now = 0;
  const pending: Array<() => void> = [];
  const limiter = new TokenBucketLimiter({
    requestsPerSecond: rps,
    burst,
    now: () => now,
    schedule: (fn) => pending.push(fn),
  });
  return {
    limiter,
    advance(ms: number) {
      now += ms;
      const fire = pending.splice(0, pending.length);
      for (const f of fire) f();
    },
  };
}

describe('TokenBucketLimiter', () => {
  it('grants up to burst immediately, then queues', async () => {
    const { limiter } = harness(5, 3);
    const grants: number[] = [];
    const p = Promise.all(
      [0, 1, 2, 3].map((i) => limiter.acquire('background').then(() => grants.push(i))),
    );
    await Promise.resolve();
    expect(grants).toEqual([0, 1, 2]);
    expect(limiter.queueDepth.background).toBe(1);
    void p;
  });

  it('refills at the configured rate', async () => {
    const h = harness(5, 1);
    await h.limiter.acquire(); // consumes the single token
    let granted = false;
    const p = h.limiter.acquire().then(() => (granted = true));
    await Promise.resolve();
    expect(granted).toBe(false);
    h.advance(100); // 5 rps -> 0.5 tokens: not enough
    await Promise.resolve();
    expect(granted).toBe(false);
    h.advance(150); // total 250ms -> 1.25 tokens
    await p;
    expect(granted).toBe(true);
  });

  it('interactive lane drains strictly before background', async () => {
    const h = harness(1, 1);
    await h.limiter.acquire(); // exhaust
    const order: string[] = [];
    const b1 = h.limiter.acquire('background').then(() => order.push('bg1'));
    const i1 = h.limiter.acquire('interactive').then(() => order.push('int1'));
    const b2 = h.limiter.acquire('background').then(() => order.push('bg2'));
    const i2 = h.limiter.acquire('interactive').then(() => order.push('int2'));
    h.advance(10_000); // plenty of tokens (capped at burst=1, drains one per pass)
    await Promise.resolve();
    h.advance(10_000);
    await Promise.resolve();
    h.advance(10_000);
    await Promise.resolve();
    h.advance(10_000);
    await Promise.all([b1, i1, b2, i2]);
    expect(order).toEqual(['int1', 'int2', 'bg1', 'bg2']);
  });

  it('a queued request is never bypassed by a fresh acquire', async () => {
    const h = harness(1, 1);
    await h.limiter.acquire();
    const order: string[] = [];
    const queued = h.limiter.acquire('interactive').then(() => order.push('queued'));
    h.advance(2_000);
    // Fresh acquire while a waiter exists must go behind it.
    const fresh = h.limiter.acquire('interactive').then(() => order.push('fresh'));
    await Promise.resolve();
    h.advance(2_000);
    await Promise.all([queued, fresh]);
    expect(order).toEqual(['queued', 'fresh']);
  });
});
