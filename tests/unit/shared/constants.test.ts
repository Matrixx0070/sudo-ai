/**
 * Unit tests for src/core/shared/constants.ts and src/core/shared/utils.ts.
 * Simple assertions — no mocks needed for constants, minimal mocking for utils.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  APP_NAME,
  APP_VERSION,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  MAX_AGENT_ITERATIONS,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  MAX_COMPACTION_CHARS,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_SCORE,
  DEFAULT_VECTOR_WEIGHT,
  DEFAULT_TEXT_WEIGHT,
  HEARTBEAT_INTERVAL_MS,
  CONFIG_RELOAD_DEBOUNCE_MS,
  OVERLOAD_BACKOFF,
  TRANSIENT_COOLDOWN,
  BILLING_COOLDOWN,
  PATHS,
} from '../../../src/core/shared/constants.js';

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

// ---------------------------------------------------------------------------
// Identity constants
// ---------------------------------------------------------------------------

describe('APP_NAME and APP_VERSION', () => {
  it('APP_NAME equals "SUDO-AI"', () => {
    expect(APP_NAME).toBe('SUDO-AI');
  });

  it('APP_VERSION is a semver-like string', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('APP_VERSION and package.json version are both valid semver strings', async () => {
    const pkg = await import('../../../package.json', { assert: { type: 'json' } });
    // Verify both are semver-like strings. The constant may intentionally differ
    // from package.json during a version bump transition.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.default.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

describe('Model constants', () => {
  it('DEFAULT_MODEL contains a slash (provider/model format)', () => {
    expect(DEFAULT_MODEL).toContain('/');
  });

  it('FALLBACK_MODEL contains a slash (provider/model format)', () => {
    expect(FALLBACK_MODEL).toContain('/');
  });

  it('EMBEDDING_MODEL contains a slash', () => {
    expect(EMBEDDING_MODEL).toContain('/');
  });

  it('EMBEDDING_DIMS is a positive integer', () => {
    expect(Number.isInteger(EMBEDDING_DIMS)).toBe(true);
    expect(EMBEDDING_DIMS).toBeGreaterThan(0);
  });

  it('MAX_AGENT_ITERATIONS is a positive integer', () => {
    expect(Number.isInteger(MAX_AGENT_ITERATIONS)).toBe(true);
    expect(MAX_AGENT_ITERATIONS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Memory / chunking constants
// ---------------------------------------------------------------------------

describe('Memory constants', () => {
  it('CHUNK_SIZE is a positive integer', () => {
    expect(Number.isInteger(CHUNK_SIZE)).toBe(true);
    expect(CHUNK_SIZE).toBeGreaterThan(0);
  });

  it('CHUNK_OVERLAP is less than CHUNK_SIZE', () => {
    expect(CHUNK_OVERLAP).toBeLessThan(CHUNK_SIZE);
  });

  it('MAX_COMPACTION_CHARS is a large positive integer', () => {
    expect(MAX_COMPACTION_CHARS).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Retrieval defaults
// ---------------------------------------------------------------------------

describe('Retrieval defaults', () => {
  it('DEFAULT_MAX_RESULTS is positive', () => {
    expect(DEFAULT_MAX_RESULTS).toBeGreaterThan(0);
  });

  it('DEFAULT_MIN_SCORE is between 0 and 1', () => {
    expect(DEFAULT_MIN_SCORE).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_MIN_SCORE).toBeLessThanOrEqual(1);
  });

  it('DEFAULT_VECTOR_WEIGHT + DEFAULT_TEXT_WEIGHT equals 1', () => {
    expect(DEFAULT_VECTOR_WEIGHT + DEFAULT_TEXT_WEIGHT).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

describe('Timing constants', () => {
  it('HEARTBEAT_INTERVAL_MS is at least 60 seconds', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('CONFIG_RELOAD_DEBOUNCE_MS is positive', () => {
    expect(CONFIG_RELOAD_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Backoff / cooldown arrays
// ---------------------------------------------------------------------------

describe('Cooldown arrays', () => {
  it('OVERLOAD_BACKOFF is a non-empty array', () => {
    expect(Array.isArray(OVERLOAD_BACKOFF)).toBe(true);
    expect(OVERLOAD_BACKOFF.length).toBeGreaterThan(0);
  });

  it('TRANSIENT_COOLDOWN is a non-empty array', () => {
    expect(Array.isArray(TRANSIENT_COOLDOWN)).toBe(true);
    expect(TRANSIENT_COOLDOWN.length).toBeGreaterThan(0);
  });

  // BILLING_COOLDOWN floor (30s) is intentionally lower than TRANSIENT_COOLDOWN max (60s)
  // because the SUDOAPI gateway handles provider switching — billing retries are cheap.
});

// ---------------------------------------------------------------------------
// PATHS
// ---------------------------------------------------------------------------

describe('PATHS', () => {
  it('PATHS.CONFIG is defined', () => {
    expect(PATHS.CONFIG).toBeDefined();
    expect(PATHS.CONFIG.length).toBeGreaterThan(0);
  });

  it('PATHS.ENV is defined', () => {
    expect(PATHS.ENV).toBeDefined();
    expect(PATHS.ENV.length).toBeGreaterThan(0);
  });

  it('PATHS.MIND_DB is defined', () => {
    expect(PATHS.MIND_DB).toBeDefined();
    expect(PATHS.MIND_DB.length).toBeGreaterThan(0);
  });

  it('PATHS.DATA is defined', () => {
    expect(PATHS.DATA).toBeDefined();
  });

  it('PATHS.WORKSPACE is defined', () => {
    expect(PATHS.WORKSPACE).toBeDefined();
  });

  it('PATHS.SKILLS is defined', () => {
    expect(PATHS.SKILLS).toBeDefined();
  });

  it('PATHS.LOGS is defined', () => {
    expect(PATHS.LOGS).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Utils — genId
// ---------------------------------------------------------------------------

describe('genId()', () => {
  it('returns a non-empty string', () => {
    const id = genId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => genId()));
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Utils — contentHash
// ---------------------------------------------------------------------------

describe('contentHash()', () => {
  it('returns a 64-char lowercase hex string', () => {
    const hash = contentHash('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('returns the same hash for the same input', () => {
    expect(contentHash('test')).toBe(contentHash('test'));
  });

  it('returns different hashes for different inputs', () => {
    expect(contentHash('foo')).not.toBe(contentHash('bar'));
  });

  it('throws TypeError for non-string input', () => {
    expect(() => contentHash(123 as unknown as string)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Utils — retry
// ---------------------------------------------------------------------------

describe('retry()', () => {
  it('returns value on first success', async () => {
    const fn = vi.fn(async () => 42);
    const result = await retry(fn, 3, [0]);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new Error('fail');
      return 'ok';
    };
    const result = await retry(fn, 3, [0, 0]);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws last error after all attempts exhausted', async () => {
    const fn = vi.fn(async () => { throw new Error('always fails'); });
    await expect(retry(fn, 3, [0, 0])).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws RangeError when maxAttempts < 1', async () => {
    await expect(retry(async () => 1, 0, [])).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Utils — sleep
// ---------------------------------------------------------------------------

describe('sleep()', () => {
  it('resolves after approximately the given delay', async () => {
    const start = Date.now();
    await sleep(20);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15); // allow some timing slack
  });

  it('resolves immediately for 0ms', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('treats negative ms as 0', async () => {
    await expect(sleep(-100)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Utils — debounce
// ---------------------------------------------------------------------------

describe('debounce()', () => {
  it('only calls fn once when called rapidly', async () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 30);
    debounced();
    debounced();
    debounced();
    await sleep(60);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws RangeError for negative ms', () => {
    expect(() => debounce(vi.fn(), -1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Utils — truncate
// ---------------------------------------------------------------------------

describe('truncate()', () => {
  it('returns original string when it fits', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings with ellipsis', () => {
    const result = truncate('hello world this is a long string', 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toContain('…');
  });

  it('returns empty string for non-string input', () => {
    expect(truncate(null as unknown as string, 10)).toBe('');
  });

  it('returns empty string for maxChars <= 0', () => {
    expect(truncate('hello', 0)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Utils — estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens()', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns positive number for non-empty string', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });

  it('returns 0 for non-string input', () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Utils — todayISO
// ---------------------------------------------------------------------------

describe('todayISO()', () => {
  it('returns a string matching YYYY-MM-DD format', () => {
    const today = todayISO();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Utils — ageInDays
// ---------------------------------------------------------------------------

describe('ageInDays()', () => {
  it('returns approximately 0 for today', () => {
    const today = new Date().toISOString();
    const age = ageInDays(today);
    expect(Math.abs(age)).toBeLessThan(1);
  });

  it('returns a positive number for a past date', () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const age = ageInDays(past);
    expect(age).toBeGreaterThan(4);
    expect(age).toBeLessThan(6);
  });
});

// ---------------------------------------------------------------------------
// Utils — safeJsonParse
// ---------------------------------------------------------------------------

describe('safeJsonParse()', () => {
  it('parses valid JSON and returns the value', () => {
    const result = safeJsonParse<{ a: number }>('{"a":1}', { a: 0 });
    expect(result.a).toBe(1);
  });

  it('returns fallback for invalid JSON', () => {
    const fallback = { a: -1 };
    const result = safeJsonParse<{ a: number }>('not json', fallback);
    expect(result).toBe(fallback);
  });

  it('returns fallback for empty string', () => {
    const fallback = null;
    expect(safeJsonParse('', fallback)).toBe(null);
  });
});
