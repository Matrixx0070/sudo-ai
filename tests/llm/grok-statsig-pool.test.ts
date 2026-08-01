/**
 * Parallel/pooled statsig supply for the free app-chat lane.
 * Covers: on-demand mint when empty, prime-to-target, distinct tokens under
 * concurrency, stale eviction, mint-retry on empty yields, and hard-fail after
 * exhausted retries. Fully injected mint + clock — no browser/network.
 */

import { describe, it, expect } from 'vitest';
import { GrokStatsigPool } from '../../src/llm/grok-statsig-pool.js';

/** Unique, valid-length (>=80) tokens, with a call counter. */
function mintFactory(overrides: string[] = []) {
  let n = 0;
  const calls = { count: 0 };
  const mint = async (): Promise<string> => {
    const i = calls.count++;
    if (i < overrides.length) return overrides[i]!;
    return `tok${++n}`.padEnd(94, 'x');
  };
  return { mint, calls };
}

describe('GrokStatsigPool', () => {
  it('mints on demand when the buffer is empty', async () => {
    const { mint, calls } = mintFactory();
    const pool = new GrokStatsigPool({ mint, target: 2 });
    const tok = await pool.acquire();
    expect(tok.length).toBeGreaterThanOrEqual(80);
    expect(calls.count).toBeGreaterThanOrEqual(1);
  });

  it('prime fills to target with distinct tokens', async () => {
    const { mint, calls } = mintFactory();
    const pool = new GrokStatsigPool({ mint, target: 3 });
    await pool.prime();
    expect(pool.size()).toBe(3);
    expect(calls.count).toBe(3);
  });

  it('serves distinct tokens under concurrent acquire', async () => {
    const { mint } = mintFactory();
    const pool = new GrokStatsigPool({ mint, target: 5 });
    await pool.prime();
    const toks = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(new Set(toks).size).toBe(3); // no token handed out twice
  });

  it('evicts stale tokens and re-mints instead of serving them', async () => {
    let t = 1000;
    const { mint, calls } = mintFactory();
    const pool = new GrokStatsigPool({ mint, target: 2, maxAgeMs: 5000, now: () => t });
    await pool.prime(); // born at t=1000
    expect(pool.size()).toBe(2);
    t = 1000 + 5001; // advance past maxAge
    expect(pool.size()).toBe(0); // all evicted
    const before = calls.count;
    const tok = await pool.acquire(); // must mint fresh, not serve a stale one
    expect(tok.length).toBeGreaterThanOrEqual(80);
    expect(calls.count).toBeGreaterThan(before);
  });

  it('retries a flaky mint that returns empty/short tokens', async () => {
    // first two mints empty, third valid
    const { mint, calls } = mintFactory(['', 'ab']);
    const pool = new GrokStatsigPool({ mint, target: 1, mintAttempts: 5 });
    const tok = await pool.acquire();
    // returned the first VALID token (3rd mint), past the two empty/short ones
    expect(tok.startsWith('tok')).toBe(true);
    expect(tok.length).toBeGreaterThanOrEqual(80);
    expect(calls.count).toBeGreaterThanOrEqual(3); // two bad + one good (+ background refill)
  });

  it('throws after exhausting mint attempts', async () => {
    const mint = async () => '';
    const pool = new GrokStatsigPool({ mint, target: 1, mintAttempts: 3 });
    await expect(pool.acquire()).rejects.toThrow(/statsig mint failed after 3/);
  });
});

import {
  demoteGrokBrowserlessStatsig,
  isGrokBrowserlessActive,
  __resetGrokBrowserlessDemotion,
} from '../../src/llm/grok-statsig-pool.js';

describe('browserless self-heal (drift auto-demotion)', () => {
  it('is active only when the flag is on; demotion disables it until cooldown', () => {
    __resetGrokBrowserlessDemotion();
    const prev = process.env['SUDO_GROK_STATSIG_BROWSERLESS'];
    process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '1';
    const t0 = 1_000_000;
    expect(isGrokBrowserlessActive(t0)).toBe(true);
    demoteGrokBrowserlessStatsig(30_000); // demote ~30s (real Date.now-based)
    // right now (real clock) it should be demoted; far future re-activates
    expect(isGrokBrowserlessActive(Date.now())).toBe(false);
    expect(isGrokBrowserlessActive(Date.now() + 60_000)).toBe(true);
    __resetGrokBrowserlessDemotion();
    process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = '';
    expect(isGrokBrowserlessActive(t0)).toBe(false); // flag off => never active
    if (prev === undefined) delete process.env['SUDO_GROK_STATSIG_BROWSERLESS'];
    else process.env['SUDO_GROK_STATSIG_BROWSERLESS'] = prev;
  });
});

/**
 * Poisoned-buffer purge (2026-08-01 prod incident).
 *
 * On statsig algorithm drift the pure-Node minter yields length-VALID tokens the
 * server rejects with 403. Demoting the minter alone only redirects FUTURE
 * mints — the buffer still holds tokens made by the drifted algorithm, and they
 * look perfectly fresh (the fault is server-side, invisible in the token). Those
 * kept being served, so the lane went on failing after it was supposed to have
 * self-healed: "rejected even after fresh mints".
 */
describe('purge drops known-bad buffered tokens', () => {
  it('empties the buffer and reports how many were dropped', async () => {
    const { mint } = mintFactory();
    const pool = new GrokStatsigPool({ mint, target: 4 });
    await pool.prime();
    expect(pool.size()).toBe(4);

    expect(pool.purge()).toBe(4);
    expect(pool.size()).toBe(0);
  });

  it('purging an empty buffer is a no-op that drops nothing', async () => {
    const { mint } = mintFactory();
    const pool = new GrokStatsigPool({ mint, target: 2 });
    expect(pool.purge()).toBe(0);
  });

  it('after a purge, acquire mints anew instead of serving a poisoned token', async () => {
    const { mint, calls } = mintFactory();
    const pool = new GrokStatsigPool({ mint, target: 2 });
    await pool.prime();
    const mintedDuringPrime = calls.count;

    pool.purge();
    const tok = await pool.acquire();

    // The token handed out came from a mint AFTER the purge, not the buffer.
    expect(tok.length).toBeGreaterThanOrEqual(80);
    expect(calls.count).toBeGreaterThan(mintedDuringPrime);
  });
});
