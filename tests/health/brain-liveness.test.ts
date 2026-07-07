/**
 * @file tests/health/brain-liveness.test.ts
 * @description Tests for the real brain-liveness check — actually probes and
 *   asserts a reply, unlike the env-presence checkBrain.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBrainLivenessCheck } from '../../src/core/health/checks.js';

describe('createBrainLivenessCheck', () => {
  it('healthy when the probe returns a non-empty reply', async () => {
    const check = createBrainLivenessCheck(async () => 'pong');
    const r = await check();
    expect(r.name).toBe('brain_liveness');
    expect(r.status).toBe('healthy');
  });

  it('critical when the probe returns an empty reply (provider not answering)', async () => {
    const check = createBrainLivenessCheck(async () => '   ');
    const r = await check();
    expect(r.status).toBe('critical');
    expect(r.message).toMatch(/empty/i);
  });

  it('critical when the probe throws (e.g. invalid key / all providers dead)', async () => {
    const check = createBrainLivenessCheck(async () => { throw new Error('Incorrect API key provided'); });
    const r = await check();
    expect(r.status).toBe('critical');
    expect(r.message).toMatch(/Incorrect API key/);
  });

  it('critical when the probe hangs past the timeout', async () => {
    const check = createBrainLivenessCheck(
      () => new Promise<string>(() => { /* never resolves */ }),
      { timeoutMs: 30 },
    );
    const r = await check();
    expect(r.status).toBe('critical');
    expect(r.message).toMatch(/timed out/);
  });

  it('throttles: spends one probe per interval, caches the verdict between', async () => {
    const probe = vi.fn(async () => 'ok');
    const check = createBrainLivenessCheck(probe, { intervalMs: 60_000 });
    await check();
    await check();
    await check();
    expect(probe).toHaveBeenCalledTimes(1); // cached on the 2nd/3rd tick
  });

  it('re-probes after the interval elapses', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const probe = vi.fn(async () => 'ok');
      const check = createBrainLivenessCheck(probe, { intervalMs: 10_000 });
      await check();                 // probe #1 at t=1_000_000
      now += 5_000; await check();   // cached
      now += 6_000; await check();   // interval elapsed → probe #2
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
