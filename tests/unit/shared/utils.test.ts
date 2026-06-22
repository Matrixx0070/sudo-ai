/**
 * Unit coverage for the pure helpers in src/core/shared/utils.ts.
 *
 * These functions had no dedicated test file. They are small, pure (or with
 * well-documented side effects) and underpin id generation, hashing, retry,
 * text truncation and token estimation across the codebase, so locking their
 * behaviour down with a focused suite is cheap insurance against regressions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  genId,
  contentHash,
  retry,
  sleep,
  debounce,
  truncate,
  estimateTokens,
  todayISO,
  ageInDays,
  safeJsonParse,
} from '../../../src/core/shared/utils.js';

describe('genId', () => {
  it('returns a non-empty url-safe string', () => {
    const id = genId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => genId()));
    expect(ids.size).toBe(1000);
  });
});

describe('contentHash', () => {
  it('computes a stable 64-char sha256 hex digest', () => {
    const h = contentHash('hello');
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(h).toHaveLength(64);
  });

  it('is deterministic and case-sensitive', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('ABC'));
  });

  it('throws a TypeError on non-string input', () => {
    // @ts-expect-error deliberately passing a wrong type
    expect(() => contentHash(123)).toThrow(TypeError);
  });
});

describe('retry', () => {
  it('returns the first successful result without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retry(fn, 3, [0, 0, 0])).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');
    await expect(retry(fn, 3, [0, 0])).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(retry(fn, 2, [0])).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid maxAttempts with a RangeError', async () => {
    await expect(retry(async () => 1, 0)).rejects.toThrow(RangeError);
  });
});

describe('sleep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves after the given delay', async () => {
    let done = false;
    const p = sleep(1000).then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(done).toBe(true);
  });

  it('clamps negative durations to zero', async () => {
    const p = sleep(-5);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBeUndefined();
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('invokes once with the latest args after the quiet period', () => {
    const spy = vi.fn();
    const d = debounce(spy, 100);
    d('a');
    d('b');
    d('c');
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('throws a RangeError for a negative quiet period', () => {
    expect(() => debounce(() => {}, -1)).toThrow(RangeError);
  });
});

describe('truncate', () => {
  it('returns the original string when it already fits', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('returns empty for non-positive maxChars', () => {
    expect(truncate('anything', 0)).toBe('');
  });

  it('appends an ellipsis when truncating', () => {
    const out = truncate('the quick brown fox jumps', 12);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it('returns empty string for non-string input', () => {
    // @ts-expect-error deliberately passing a wrong type
    expect(truncate(null, 5)).toBe('');
  });

  it('returns just the ellipsis when maxChars is too small for any content', () => {
    expect(truncate('hello world', 1)).toBe('…');
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty or non-string input', () => {
    expect(estimateTokens('')).toBe(0);
    // @ts-expect-error deliberately passing a wrong type
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('estimates ~1 token per 4 characters, rounding up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('todayISO', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ageInDays', () => {
  it('returns roughly the elapsed days for a past date', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const age = ageInDays(tenDaysAgo);
    expect(age).toBeGreaterThan(9.9);
    expect(age).toBeLessThan(10.1);
  });

  it('returns a negative value for a future date', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(ageInDays(tomorrow)).toBeLessThan(0);
  });
});

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', null)).toEqual({ a: 1 });
  });

  it('returns the fallback on invalid JSON', () => {
    expect(safeJsonParse('not json', 'fallback')).toBe('fallback');
  });
});
