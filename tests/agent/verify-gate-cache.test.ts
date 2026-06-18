/**
 * @file tests/agent/verify-gate-cache.test.ts
 * @description ConfidenceGate per-tool confidence cache (TTL-LRU).
 *
 * The gate's lookup opens audit.db (+ calibration.db) per evaluated destructive
 * tool call. The opt-in cache (SUDO_VERIFY_GATE_CACHE=1) memoises that lookup so
 * a burst of evaluations of the same tool within the TTL skips the DB opens.
 * Caching never changes the decision — only how often the lookup runs.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ConfidenceGate,
  isCacheEnabled,
  readCacheTtlMs,
  readCacheMax,
  type ToolRegistryForGate,
} from '../../src/core/agent/verify-gate.js';

/** A registry that reports every requested tool as destructive (so the gate reaches the lookup). */
const destructiveRegistry: ToolRegistryForGate = {
  get: (name: string) => ({ name, safety: 'destructive' as const }),
};

/** Base gate opts: enabled, deterministic threshold/min-samples, cache ON. */
function gateOpts(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    threshold: 0.55,
    minSamples: 1,
    cacheEnabled: true,
    cacheTtlMs: 1000,
    cacheMax: 256,
    ...over,
  };
}

describe('ConfidenceGate confidence cache', () => {
  it('VGC-1: a second evaluation within TTL is served from cache (lookup runs once)', () => {
    const lookup = vi.fn(() => ({ confidence: 0.9, samples: 10 }));
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, now: () => 1000 }));

    const a = gate.evaluate('write_file');
    const b = gate.evaluate('write_file');

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.reason).toBe('above-threshold');
  });

  it('VGC-2: an entry past its TTL is refreshed (lookup runs again)', () => {
    let clock = 1000;
    const lookup = vi.fn(() => ({ confidence: 0.9, samples: 10 }));
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, cacheTtlMs: 500, now: () => clock }));

    gate.evaluate('write_file');
    clock = 1499; // still inside TTL (expiresAt = 1000 + 500 = 1500)
    gate.evaluate('write_file');
    expect(lookup).toHaveBeenCalledTimes(1);

    clock = 1501; // past TTL
    gate.evaluate('write_file');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('VGC-3: with the cache disabled (default), every evaluation hits the lookup', () => {
    const lookup = vi.fn(() => ({ confidence: 0.9, samples: 10 }));
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ cacheEnabled: false, confidenceLookup: lookup }));

    gate.evaluate('write_file');
    gate.evaluate('write_file');
    gate.evaluate('write_file');
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('VGC-4: cache is keyed per tool — distinct tools each run the lookup', () => {
    const lookup = vi.fn((name: string) => ({ confidence: name === 'rm' ? 0.2 : 0.9, samples: 10 }));
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, now: () => 1000 }));

    const rm = gate.evaluate('rm');
    const write = gate.evaluate('write_file');
    gate.evaluate('rm'); // cached
    gate.evaluate('write_file'); // cached

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(rm.reason).toBe('below-threshold');
    expect(write.reason).toBe('above-threshold');
  });

  it('VGC-5: LRU evicts the oldest entry past capacity', () => {
    const lookup = vi.fn(() => ({ confidence: 0.9, samples: 10 }));
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, cacheMax: 2, now: () => 1000 }));

    gate.evaluate('a'); // cache: [a]
    gate.evaluate('b'); // cache: [a, b]
    gate.evaluate('c'); // cache: [b, c] — 'a' evicted
    expect(lookup).toHaveBeenCalledTimes(3);

    gate.evaluate('b'); // still cached
    gate.evaluate('c'); // still cached
    expect(lookup).toHaveBeenCalledTimes(3);

    gate.evaluate('a'); // evicted earlier → re-runs
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('VGC-6: a hit promotes the entry (LRU recency), protecting it from eviction', () => {
    const lookup = vi.fn(() => ({ confidence: 0.9, samples: 10 }));
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, cacheMax: 2, now: () => 1000 }));

    gate.evaluate('a'); // [a]
    gate.evaluate('b'); // [a, b]
    gate.evaluate('a'); // hit → promote → [b, a]
    gate.evaluate('c'); // [a, c] — 'b' evicted (now oldest)
    expect(lookup).toHaveBeenCalledTimes(3);

    gate.evaluate('a'); // protected by promotion → still cached
    expect(lookup).toHaveBeenCalledTimes(3);
    gate.evaluate('c'); // most-recent insert → still cached
    expect(lookup).toHaveBeenCalledTimes(3);
    gate.evaluate('b'); // was evicted → re-runs
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('VGC-7: a null (no-history) result is cached too (no repeated DB opens)', () => {
    const lookup = vi.fn(() => null);
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, now: () => 1000 }));

    const a = gate.evaluate('write_file');
    const b = gate.evaluate('write_file');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(a.reason).toBe('no-history');
    expect(b.reason).toBe('no-history');
  });

  it('VGC-8: a throwing lookup is not cached — the next evaluation retries', () => {
    const lookup = vi.fn(() => { throw new Error('db locked'); });
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, now: () => 1000 }));

    const a = gate.evaluate('write_file');
    const b = gate.evaluate('write_file');
    expect(lookup).toHaveBeenCalledTimes(2); // not cached
    expect(a.reason).toBe('error');
    expect(b.reason).toBe('error');
  });

  it('VGC-9: cacheTtlMs=0 disables the cache even when enabled', () => {
    const lookup = vi.fn(() => ({ confidence: 0.9, samples: 10 }));
    const gate = new ConfidenceGate(destructiveRegistry, gateOpts({ confidenceLookup: lookup, cacheTtlMs: 0 }));

    gate.evaluate('write_file');
    gate.evaluate('write_file');
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe('cache env readers', () => {
  it('isCacheEnabled defaults OFF and reads the strict "1"', () => {
    expect(isCacheEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCacheEnabled({ SUDO_VERIFY_GATE_CACHE: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isCacheEnabled({ SUDO_VERIFY_GATE_CACHE: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('readCacheTtlMs defaults to 5000 and accepts 0 as a disable sentinel', () => {
    expect(readCacheTtlMs({} as NodeJS.ProcessEnv)).toBe(5000);
    expect(readCacheTtlMs({ SUDO_VERIFY_GATE_CACHE_TTL_MS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(readCacheTtlMs({ SUDO_VERIFY_GATE_CACHE_TTL_MS: '250' } as NodeJS.ProcessEnv)).toBe(250);
    expect(readCacheTtlMs({ SUDO_VERIFY_GATE_CACHE_TTL_MS: '-5' } as NodeJS.ProcessEnv)).toBe(5000);
  });

  it('readCacheMax defaults to 256 and floors to >=1', () => {
    expect(readCacheMax({} as NodeJS.ProcessEnv)).toBe(256);
    expect(readCacheMax({ SUDO_VERIFY_GATE_CACHE_MAX: '8' } as NodeJS.ProcessEnv)).toBe(8);
    expect(readCacheMax({ SUDO_VERIFY_GATE_CACHE_MAX: '0' } as NodeJS.ProcessEnv)).toBe(256);
  });
});
