/**
 * @file tests/gateway/ws-hardening.test.ts
 * @description GW-8 unit tests — the idempotency store, the sliding-window
 * limiter, and the rpc-schema policy surface (mutating methods, close codes,
 * hello backpressure advertisement). The end-to-end WS wiring is exercised
 * through the pure units these compose from.
 */
import { describe, it, expect } from 'vitest';
import { IdempotencyStore } from '../../src/core/gateway/idempotency.js';
import { SlidingWindowLimiter } from '../../src/core/gateway/rate-limit.js';
import {
  isMutatingMethod,
  MUTATING_METHODS,
  buildHelloOk,
  WS_CLOSE,
  PREAUTH_MAX_FRAME_BYTES,
  MAX_BUFFERED_BYTES,
  MAX_UNAUTHORIZED_FRAMES,
} from '../../src/core/gateway/rpc-schema.js';
import type { GatewayPrincipal } from '../../src/core/gateway/auth.js';

const admin: GatewayPrincipal = {
  ok: true, credential: 'gateway-token', scopes: ['operator.admin'], isOwner: true, reason: 't',
};

describe('GW-8 IdempotencyStore', () => {
  it('runs the factory once per key; a duplicate replays the same result', async () => {
    const store = new IdempotencyStore();
    let calls = 0;
    const factory = () => { calls += 1; return Promise.resolve({ n: calls }); };

    const first = store.run('sessions.send:abc', factory);
    const second = store.run('sessions.send:abc', factory);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(await first.promise).toEqual({ n: 1 });
    expect(await second.promise).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it('different keys execute independently', async () => {
    const store = new IdempotencyStore();
    let calls = 0;
    const factory = () => { calls += 1; return Promise.resolve(calls); };
    await store.run('m:a', factory).promise;
    await store.run('m:b', factory).promise;
    expect(calls).toBe(2);
  });

  it('re-executes after the TTL expires', async () => {
    let now = 1_000_000;
    const store = new IdempotencyStore({ ttlMs: 5000 }, () => now);
    let calls = 0;
    const factory = () => { calls += 1; return Promise.resolve(calls); };
    store.run('m:k', factory);
    now += 6000; // past TTL
    const again = store.run('m:k', factory);
    expect(again.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('caps entries and evicts the oldest', async () => {
    const store = new IdempotencyStore({ maxEntries: 2 });
    store.run('m:1', () => Promise.resolve(1));
    store.run('m:2', () => Promise.resolve(2));
    store.run('m:3', () => Promise.resolve(3)); // evicts m:1
    expect(store.size()).toBe(2);
    // m:1 evicted → re-run happens (replayed false)
    expect(store.run('m:1', () => Promise.resolve(9)).replayed).toBe(false);
  });

  it('caches a rejection so a replay reproduces the same error without re-running', async () => {
    const store = new IdempotencyStore();
    let calls = 0;
    const factory = () => { calls += 1; return Promise.reject(new Error('boom')); };
    const a = store.run('m:x', factory);
    const b = store.run('m:x', factory);
    await expect(a.promise).rejects.toThrow('boom');
    await expect(b.promise).rejects.toThrow('boom');
    expect(b.replayed).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('GW-8 SlidingWindowLimiter', () => {
  it('allows up to the limit then locks out', () => {
    let now = 0;
    const lim = new SlidingWindowLimiter({ limit: 10, windowMs: 60_000, lockoutMs: 300_000 }, () => now);
    for (let i = 0; i < 10; i++) {
      expect(lim.record('ip').allowed).toBe(true);
    }
    // 11th trips the lockout
    const v = lim.record('ip');
    expect(v.allowed).toBe(false);
    expect(v.retryAfterMs).toBe(300_000);
    expect(lim.isLocked('ip')).toBe(true);
  });

  it('lockout expires after lockoutMs', () => {
    let now = 0;
    const lim = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, lockoutMs: 5000 }, () => now);
    lim.record('ip'); // 1 ok
    expect(lim.record('ip').allowed).toBe(false); // locks
    now += 5001;
    expect(lim.isLocked('ip')).toBe(false);
    expect(lim.record('ip').allowed).toBe(true);
  });

  it('reset clears accumulated attempts (honest client never accrues)', () => {
    const lim = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, lockoutMs: 60_000 });
    lim.record('ip');
    lim.reset('ip');
    lim.record('ip');
    expect(lim.record('ip').allowed).toBe(true); // still under limit after reset
  });

  it('window slides — old events drain out', () => {
    let now = 0;
    const lim = new SlidingWindowLimiter({ limit: 2, windowMs: 1000, lockoutMs: 0 }, () => now);
    expect(lim.record('ip').allowed).toBe(true); // t=0
    expect(lim.record('ip').allowed).toBe(true); // t=0
    now = 1001; // first two drained
    expect(lim.record('ip').allowed).toBe(true);
  });

  it('keys are independent and evict at the cap', () => {
    const lim = new SlidingWindowLimiter({ limit: 1, windowMs: 1000, lockoutMs: 0, maxKeys: 2 });
    lim.record('a'); lim.record('b'); lim.record('c');
    expect(lim.size()).toBeLessThanOrEqual(2);
  });
});

describe('GW-8 rpc-schema policy surface', () => {
  it('mutating methods are exactly the side-effecting set', () => {
    expect(isMutatingMethod('sessions.send')).toBe(true);
    expect(isMutatingMethod('chat.send')).toBe(true);
    expect(isMutatingMethod('cron.add')).toBe(true);
    expect(isMutatingMethod('cron.remove')).toBe(true);
    expect(isMutatingMethod('secrets.reload')).toBe(true);
    expect(isMutatingMethod('health')).toBe(false);
    expect(isMutatingMethod('sessions.list')).toBe(false);
    expect(MUTATING_METHODS.has('secrets.resolve')).toBe(false);
  });

  it('close codes follow OpenClaw semantics', () => {
    expect(WS_CLOSE.POLICY).toBe(1008);
    expect(WS_CLOSE.TOO_BIG).toBe(1009);
    expect(WS_CLOSE.SUSPENDING).toBe(1013);
    expect(WS_CLOSE.AUTH_ROTATED).toBe(4001);
  });

  it('policy caps match the advertised numbers', () => {
    expect(PREAUTH_MAX_FRAME_BYTES).toBe(64 * 1024);
    expect(MAX_BUFFERED_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_UNAUTHORIZED_FRAMES).toBe(10);
  });

  it('hello advertises the backpressure policy', () => {
    const hello = buildHelloOk(admin, ['health', 'chat.send']);
    expect(hello.limits).toEqual({ maxPayload: 512 * 1024, maxBufferedBytes: MAX_BUFFERED_BYTES });
  });
});
