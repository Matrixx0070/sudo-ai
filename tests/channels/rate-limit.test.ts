/**
 * @file rate-limit.test.ts
 * @description Unit tests for the per-peer token-bucket rate limiter.
 *
 * Tests covering:
 *  1.  Fresh peer allowed (remaining = burst + perMinute - 1)
 *  2.  N requests allowed, N+1 blocked
 *  3.  Refill: advancing clock restores tokens
 *  4.  burstWarned deduplication: 10 rapid denials → only first triggers warning
 *  5.  reset() clears bucket; next check allowed
 *  6.  Per-channel config override via env vars
 *  7.  GC: buckets older than 1h are pruned
 *  8.  Bucket cap: 50,001 inserts → oldest evicted
 *  9.  Persistence round-trip: flush → reload → state survives
 * 10.  Hook fires on first block only
 * 11.  Clock skew: negative delta clamped to 0 (no free tokens)
 * 12.  peerId with `::` treated safely (no collision)
 * 13.  Burst exhaustion: burst+perMinute+1 requests → last blocked
 * 14.  Reset after block allows immediately
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, readFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// We test by importing a factory that creates isolated RateLimiterImpl
// instances. We monkey-patch Date.now where clock control is needed.
// ---------------------------------------------------------------------------

// Re-export internals for testing by using a module-factory approach.
// Rate-limit module exposes the singleton; we bypass by re-importing
// a fresh class instance constructed with our spies.

// Because the module exports a singleton, we simulate clock-controlled
// token bucket logic by testing a fresh import each time with vi.useFakeTimers.

import type { RateLimiter, RateLimitCheckResult, HookEmitterLike } from '../../src/core/channels/rate-limit.js';

// ---------------------------------------------------------------------------
// Helper: build an isolated RateLimiterImpl using the internal constructor
// by dynamically importing after resetting module state.
// ---------------------------------------------------------------------------

async function makeIsolatedLimiter(envOverrides: Record<string, string | undefined> = {}): Promise<RateLimiter & { _gc(): void; _flushPersisted(): Promise<void>; _loadPersisted(): Promise<void>; buckets: Map<string, unknown> }> {
  // Set env before import.
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  // Dynamic import with cache-bust using a query param (works in Node ESM via vite/vitest).
  // Actually vitest doesn't support cache-busting easily; we'll rely on vi.resetModules().
  const mod = await import('../../src/core/channels/rate-limit.js');

  // Restore env.
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  return mod.rateLimiter as unknown as RateLimiter & { _gc(): void; _flushPersisted(): Promise<void>; _loadPersisted(): Promise<void>; buckets: Map<string, unknown> };
}

// ---------------------------------------------------------------------------
// Because the module exports a singleton and vitest caches imports, we use
// the exported singleton but carefully clean state between tests using
// `reset()`. For tests requiring env config, we use vi.resetModules().
// ---------------------------------------------------------------------------

describe('Rate Limiter — Token Bucket', () => {
  let limiter: Awaited<ReturnType<typeof makeIsolatedLimiter>>;

  beforeEach(async () => {
    vi.resetModules();
    // Clear any per-channel overrides.
    delete process.env['SUDO_RATE_LIMIT_PER_MIN'];
    delete process.env['SUDO_RATE_LIMIT_BURST'];
    delete process.env['SUDO_RATE_LIMIT_TELEGRAM_PER_MIN'];
    delete process.env['SUDO_RATE_LIMIT_TELEGRAM_BURST'];
    delete process.env['SUDO_RATE_LIMIT_DISCORD_PER_MIN'];
    delete process.env['SUDO_RATE_LIMIT_PERSIST'];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // Test 1: Fresh peer is allowed; remaining = burst + perMinute - 1
  // -------------------------------------------------------------------------
  it('1. fresh peer: first request allowed, remaining = burst+perMinute-1', async () => {
    vi.resetModules();
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const result = await rl.check('telegram', 'user-fresh-1');
    expect(result.allowed).toBe(true);
    // Default: perMinute=20, burst=5 → maxTokens=25; after consuming 1 → remaining=24
    expect(result.remaining).toBe(24);
  });

  // -------------------------------------------------------------------------
  // Test 2: N requests allowed, N+1 blocked
  // -------------------------------------------------------------------------
  it('2. exactly maxTokens requests allowed; maxTokens+1 is blocked', async () => {
    vi.resetModules();
    // Use small values to keep test fast.
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '3';
    process.env['SUDO_RATE_LIMIT_BURST'] = '2';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-ntests-${randomUUID()}`;
    // maxTokens = perMinute + burst = 3 + 2 = 5
    let lastAllowed: RateLimitCheckResult | undefined;
    for (let i = 0; i < 5; i++) {
      lastAllowed = await rl.check('telegram', peer);
      expect(lastAllowed.allowed).toBe(true);
    }
    const blocked = await rl.check('telegram', peer);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.remaining).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: Refill — advance clock, tokens refilled, allowed again
  // -------------------------------------------------------------------------
  it('3. refill: advancing clock by 60s restores tokens', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '2';
    process.env['SUDO_RATE_LIMIT_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-refill-${randomUUID()}`;
    // Exhaust 2 tokens.
    await rl.check('telegram', peer);
    await rl.check('telegram', peer);
    const blocked = await rl.check('telegram', peer);
    expect(blocked.allowed).toBe(false);

    // Advance clock by 60 s → 2 tokens refilled.
    vi.advanceTimersByTime(60_000);
    const refilled = await rl.check('telegram', peer);
    expect(refilled.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: burstWarned deduplication — 10 rapid denials → only first warns
  // -------------------------------------------------------------------------
  it('4. burstWarned dedup: first denial returns burstWarned=false, subsequent return true', async () => {
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '1';
    process.env['SUDO_RATE_LIMIT_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-dedup-${randomUUID()}`;
    // Consume the 1 token.
    await rl.check('telegram', peer);

    // First denial — should warn.
    const first = await rl.check('telegram', peer);
    expect(first.allowed).toBe(false);
    expect(first.burstWarned).toBe(false); // transition: was false → now true

    // Subsequent denials — already warned.
    for (let i = 0; i < 9; i++) {
      const subsequent = await rl.check('telegram', peer);
      expect(subsequent.allowed).toBe(false);
      expect(subsequent.burstWarned).toBe(true); // already warned
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: reset() clears bucket; next check is allowed
  // -------------------------------------------------------------------------
  it('5. reset: clear bucket → next check allowed', async () => {
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '1';
    process.env['SUDO_RATE_LIMIT_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-reset-${randomUUID()}`;
    // Exhaust.
    await rl.check('telegram', peer);
    const blocked = await rl.check('telegram', peer);
    expect(blocked.allowed).toBe(false);

    // Reset.
    rl.reset('telegram', peer);
    const after = await rl.check('telegram', peer);
    expect(after.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 6: Per-channel config override
  // -------------------------------------------------------------------------
  it('6. per-channel override: SUDO_RATE_LIMIT_TELEGRAM_PER_MIN overrides global', async () => {
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '100'; // high global
    process.env['SUDO_RATE_LIMIT_TELEGRAM_PER_MIN'] = '1';
    process.env['SUDO_RATE_LIMIT_TELEGRAM_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-chan-override-${randomUUID()}`;
    // With perMinute=1, burst=0 → maxTokens=1
    await rl.check('telegram', peer); // consumes the 1 token
    const blocked = await rl.check('telegram', peer);
    expect(blocked.allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 7: GC prunes buckets older than 1h
  // -------------------------------------------------------------------------
  it('7. GC: buckets with lastAccess > 1h are pruned', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const impl = rl as unknown as { buckets: Map<string, unknown>; _gc(): void };

    // Insert 100 buckets via check().
    const peers: string[] = [];
    for (let i = 0; i < 100; i++) {
      const peer = `gc-peer-${i}`;
      peers.push(peer);
      await rl.check('telegram', peer);
    }
    expect(impl.buckets.size).toBe(100);

    // Advance 2 hours — all buckets become stale.
    vi.advanceTimersByTime(2 * 3_600_000);

    // Manually trigger GC (interval fires would work too but direct call is faster).
    impl._gc();

    expect(impl.buckets.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 8: Bucket cap — 50,001 buckets → oldest is evicted
  // -------------------------------------------------------------------------
  it('8. cap: inserting 50,001 buckets evicts oldest 10,000', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const impl = rl as unknown as { buckets: Map<string, unknown>; _enforceCapIfNeeded(): void };

    // Insert 50,000 buckets. Use distinct timestamps so LRU works.
    for (let i = 0; i < 50_000; i++) {
      vi.setSystemTime(i); // each gets a unique lastAccess
      await rl.check('test', `cap-peer-${i}`);
    }
    expect(impl.buckets.size).toBe(50_000);

    // Insert one more — triggers cap enforcement.
    vi.setSystemTime(50_001);
    await rl.check('test', 'cap-peer-trigger');

    // Should have evicted 10,000 oldest → 50,001 - 10,000 = 40,001
    expect(impl.buckets.size).toBeLessThanOrEqual(40_001);
    // The oldest should be gone.
    expect(impl.buckets.has('test::cap-peer-0')).toBe(false);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 9: Persistence round-trip — write valid JSON file, load it, verify
  // bucket state is restored (tests the serialisation + validation logic).
  // -------------------------------------------------------------------------
  it('9. persistence: write valid JSON → _loadPersisted restores bucket state', async () => {
    const ORIGINAL_CWD = process.cwd();
    // The rate limiter resolves WORKSPACE_DIR = process.cwd()/workspace at import
    // time. chdir into a fresh temp dir BEFORE importing so this test reads,
    // writes, and deletes an isolated rate-limits.json and never touches the
    // real workspace/rate-limits.json.
    const tempCwd = await mkdtemp(join(tmpdir(), 'rate-limit-test-'));
    process.chdir(tempCwd);
    try {
      vi.resetModules();
      process.env['SUDO_RATE_LIMIT_PER_MIN'] = '10';
      process.env['SUDO_RATE_LIMIT_BURST'] = '0';
      process.env['SUDO_RATE_LIMIT_PERSIST'] = '1';

      const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
      const impl = rl as unknown as {
        _loadPersisted(): Promise<void>;
        buckets: Map<string, { tokens: number; lastRefill: number; lastAccess: number; burstWarned: boolean }>;
      };

      const peer = `persist-peer-${randomUUID()}`;
      const key = `telegram::${peer}`;
      const now = Date.now();

      // cwd is the temp dir, so this writes into the isolated workspace.
      const workspaceDir = join(process.cwd(), 'workspace');
      await mkdir(workspaceDir, { recursive: true });
      const persistFile = join(workspaceDir, 'rate-limits.json');
      const savedBucket = { tokens: 3.5, lastRefill: now, lastAccess: now, burstWarned: false };
      await writeFile(persistFile, JSON.stringify({ [key]: savedBucket }), 'utf-8');

      // Clear buckets and reload.
      impl.buckets.clear();
      await impl._loadPersisted();

      const restored = impl.buckets.get(key);
      expect(restored).toBeDefined();
      expect(restored!.tokens).toBeCloseTo(3.5);
      expect(restored!.burstWarned).toBe(false);
    } finally {
      process.chdir(ORIGINAL_CWD);
      await rm(tempCwd, { recursive: true, force: true });
      delete process.env['SUDO_RATE_LIMIT_PERSIST'];
    }
  });

  // -------------------------------------------------------------------------
  // Test 10: Hook fires on first block only
  // -------------------------------------------------------------------------
  it('10. hook: rate-limit:triggered fires once per block-window (first denial only)', async () => {
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '1';
    process.env['SUDO_RATE_LIMIT_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');

    const emitted: Array<{ event: string; peerId?: string }> = [];
    const mockEmitter: HookEmitterLike = {
      emit: vi.fn(async (event, ctx) => {
        emitted.push({ event, peerId: (ctx as { peerId?: string }).peerId });
      }),
    };
    rl.setHookEmitter(mockEmitter);

    const peer = `user-hook-${randomUUID()}`;
    await rl.check('telegram', peer); // consumes only token

    // First denial → hook fires.
    await rl.check('telegram', peer);
    // Second denial → hook must NOT fire again.
    await rl.check('telegram', peer);
    await rl.check('telegram', peer);

    // Flush any pending microtasks (hooks are async void, so a tick is enough).
    await Promise.resolve();
    await Promise.resolve();

    expect(emitted.filter(e => e.event === 'rate-limit:triggered')).toHaveLength(1);
    expect(emitted[0]?.peerId).toBe(peer);
  });

  // -------------------------------------------------------------------------
  // Test 11: Clock skew — negative delta clamped to 0
  // -------------------------------------------------------------------------
  it('11. clock skew: backward clock does not grant extra tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '2';
    process.env['SUDO_RATE_LIMIT_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-skew-${randomUUID()}`;

    // Consume both tokens.
    await rl.check('telegram', peer);
    await rl.check('telegram', peer);
    const blocked = await rl.check('telegram', peer);
    expect(blocked.allowed).toBe(false);

    // Move clock backwards — should not grant extra tokens.
    vi.setSystemTime(50_000);
    const stillBlocked = await rl.check('telegram', peer);
    expect(stillBlocked.allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 12: peerId with `::` doesn't cause key collision
  // -------------------------------------------------------------------------
  it('12. peerId with `::` is sanitized — no collision with real channel separator', async () => {
    vi.resetModules();
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const impl = rl as unknown as { buckets: Map<string, unknown> };

    // Peer "a::b" in channel "c" should NOT collide with peer "b" in channel "c::a".
    await rl.check('c', 'a::b');
    await rl.check('c::a', 'b');

    // Both should be separate bucket entries.
    expect(impl.buckets.size).toBeGreaterThanOrEqual(2);
    // Keys should differ.
    const keys = Array.from(impl.buckets.keys()).filter(k => k.includes('a') && k.includes('b'));
    expect(new Set(keys).size).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Test 13: Burst exhaustion path — burst=5, perMinute=10 → 15 allowed then blocked
  // -------------------------------------------------------------------------
  it('13. burst exhaustion: burst+perMinute requests allowed, next blocked, retryAfterMs > 0', async () => {
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '10';
    process.env['SUDO_RATE_LIMIT_BURST'] = '5';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-burst-${randomUUID()}`;
    // 15 should be allowed.
    for (let i = 0; i < 15; i++) {
      const r = await rl.check('telegram', peer);
      expect(r.allowed).toBe(true);
    }
    // 16th blocked.
    const blocked = await rl.check('telegram', peer);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 14: burstWarned resets after refill above 1 token
  // -------------------------------------------------------------------------
  it('14. burstWarned resets when bucket refills; next block triggers fresh warning', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '2';
    process.env['SUDO_RATE_LIMIT_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-warned-reset-${randomUUID()}`;

    // Exhaust and get warned.
    await rl.check('telegram', peer);
    await rl.check('telegram', peer);
    const first = await rl.check('telegram', peer);
    expect(first.burstWarned).toBe(false); // first warning

    // Wait 30s — partial refill (1 token for 2/min rate).
    vi.advanceTimersByTime(30_000);

    // Now consume that refilled token.
    const allowed = await rl.check('telegram', peer);
    expect(allowed.allowed).toBe(true);

    // Block again — burstWarned should have reset since we had ≥1 token.
    const second = await rl.check('telegram', peer);
    expect(second.allowed).toBe(false);
    expect(second.burstWarned).toBe(false); // fresh warning again
  });

  // -------------------------------------------------------------------------
  // Test 15: Burst ceiling — SUDO_RATE_LIMIT_BURST=999999999 → effective=1000
  // -------------------------------------------------------------------------
  it('15. burst ceiling: SUDO_RATE_LIMIT_BURST=999999999 is capped to 1000', async () => {
    vi.resetModules();
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '1';
    process.env['SUDO_RATE_LIMIT_BURST'] = '999999999';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const peer = `user-ceil-${randomUUID()}`;

    // With perMinute=1 and burst capped to 1000 → maxTokens = 1001.
    // Exhaust 1001 tokens — all should be allowed.
    for (let i = 0; i < 1001; i++) {
      const r = await rl.check('telegram', peer);
      expect(r.allowed).toBe(true);
    }
    // 1002nd should be blocked — confirms ceiling of 1000 was enforced.
    const blocked = await rl.check('telegram', peer);
    expect(blocked.allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 16: peerId collision — "a::b" and "a__b" must produce different keys
  // -------------------------------------------------------------------------
  it('16. peerId collision: "a::b" and "a__b" in same channel map to different buckets', async () => {
    vi.resetModules();
    // Use small limits so each peer has exactly 1 token (perMinute=1, burst=0).
    process.env['SUDO_RATE_LIMIT_PER_MIN'] = '1';
    process.env['SUDO_RATE_LIMIT_BURST'] = '0';
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const impl = rl as unknown as { buckets: Map<string, unknown> };

    // Clear any pre-existing state.
    impl.buckets.clear();

    // Exhaust "a::b" (1 token).
    await rl.check('chan', 'a::b');
    const r1 = await rl.check('chan', 'a::b');
    expect(r1.allowed).toBe(false); // bucket exhausted

    // "a__b" should be a completely separate bucket — still has its 1 token.
    const r2 = await rl.check('chan', 'a__b');
    expect(r2.allowed).toBe(true); // different bucket, unaffected

    // Confirm they are truly separate entries in the map.
    expect(impl.buckets.size).toBe(2);
    const keys = Array.from(impl.buckets.keys());
    expect(new Set(keys).size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 17: LRU eviction correctness with 60K inserts
  // -------------------------------------------------------------------------
  it('17. LRU eviction: 60K inserts → eviction ran, oldest removed, size correct', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');
    const impl = rl as unknown as { buckets: Map<string, unknown>; _enforceCapIfNeeded(): void };

    // Insert 50,001 buckets with distinct timestamps so LRU order is defined.
    for (let i = 0; i < 50_001; i++) {
      vi.setSystemTime(i);
      await rl.check('lru', `lru-peer-${i}`);
    }

    // After 50,001 inserts the cap enforcement fires automatically.
    // Expected: 50,001 - 10,000 (evicted) = 40,001 remaining.
    expect(impl.buckets.size).toBeLessThanOrEqual(40_001);

    // The oldest bucket (timestamp 0) must have been evicted.
    expect(impl.buckets.has('lru::lru-peer-0')).toBe(false);

    // Insert another 10,000 to fill it back above cap and verify a second eviction.
    const startSize = impl.buckets.size;
    for (let i = 50_001; i < 50_001 + 10_001; i++) {
      vi.setSystemTime(i);
      await rl.check('lru', `lru-peer-${i}`);
    }
    // A second wave of evictions should keep total well below 50,001 + 10,001.
    expect(impl.buckets.size).toBeLessThan(50_001 + 10_001);
    // Confirm total never exceeds cap after an eviction cycle.
    expect(impl.buckets.size).toBeLessThanOrEqual(40_001 + 1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Test 18: Discord /ask interaction flood — 6th hit returns rate-limit reply
  // -------------------------------------------------------------------------
  it('18. Discord /ask flood: rate-limiter blocks excess slash commands via interaction.reply', async () => {
    vi.resetModules();
    // Small limits: perMinute=3, burst=2 → maxTokens=5.
    process.env['SUDO_RATE_LIMIT_DISCORD_PER_MIN'] = '3';
    process.env['SUDO_RATE_LIMIT_DISCORD_BURST'] = '2';

    const { DiscordAdapter } = await import('../../src/core/channels/discord.js');
    // Import rate-limiter from the same module graph so env is read.
    const { rateLimiter: rl } = await import('../../src/core/channels/rate-limit.js');

    const adapter = new DiscordAdapter('DISCORD_TOKEN', []);
    // Register a no-op handler so _dispatch doesn't warn.
    let dispatchCount = 0;
    adapter.onMessage(async () => { dispatchCount++; });

    // Reset the specific userId bucket to start clean.
    const userId = 'test-user-discord-flood';
    rl.reset('discord', userId);

    // Build a minimal mock interaction factory.
    function makeInteraction(overrides: Record<string, unknown> = {}) {
      const replySpy = vi.fn(async () => undefined);
      const deferReplySpy = vi.fn(async () => undefined);
      return {
        isChatInputCommand: () => true,
        commandName: 'ask',
        channelId: 'chan-123',
        user: { id: userId, displayName: 'Tester', username: 'tester' },
        channel: { isDMBased: () => false },
        options: { getString: () => 'test question' },
        reply: replySpy,
        deferReply: deferReplySpy,
        ...overrides,
        _replySpy: replySpy,
        _deferReplySpy: deferReplySpy,
      };
    }

    // Fire 5 interactions — all should pass through to _dispatch (deferReply called).
    for (let i = 0; i < 5; i++) {
      const interaction = makeInteraction();
      await (adapter as unknown as { _handleInteraction(i: unknown): Promise<void> })._handleInteraction(interaction);
      expect(interaction._deferReplySpy).toHaveBeenCalledTimes(1);
      expect(interaction._replySpy).not.toHaveBeenCalled();
    }
    expect(dispatchCount).toBe(5);

    // 6th interaction — must be blocked by rate limiter.
    const blockedInteraction = makeInteraction();
    await (adapter as unknown as { _handleInteraction(i: unknown): Promise<void> })._handleInteraction(blockedInteraction);

    // reply() should have been called with rate-limit content, NOT deferReply().
    expect(blockedInteraction._replySpy).toHaveBeenCalledTimes(1);
    expect(blockedInteraction._deferReplySpy).not.toHaveBeenCalled();

    // Confirm the reply contains a rate-limit message.
    const replyArg = blockedInteraction._replySpy.mock.calls[0]?.[0] as { content: string; ephemeral: boolean };
    expect(replyArg.ephemeral).toBe(true);
    expect(replyArg.content).toMatch(/slow down|Rate limited/i);

    // _dispatch should NOT have been called for the blocked interaction.
    expect(dispatchCount).toBe(5);

    delete process.env['SUDO_RATE_LIMIT_DISCORD_PER_MIN'];
    delete process.env['SUDO_RATE_LIMIT_DISCORD_BURST'];
  });
});
