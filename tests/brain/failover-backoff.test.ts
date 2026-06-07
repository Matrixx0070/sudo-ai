/**
 * @file tests/brain/failover-backoff.test.ts
 * @description Phase B — hardened backoff: jitter + Retry-After-aware cooldowns,
 * plus the structured error taxonomy classifier and Brain's Retry-After parsing.
 */

import { describe, it, expect } from 'vitest';
import { ModelFailover } from '../../src/core/brain/failover.js';
import { Brain } from '../../src/core/brain/brain.js';
import { TRANSIENT_COOLDOWN } from '../../src/core/shared/constants.js';

const MODEL = 'xai/grok-3-fast';
const BASE = TRANSIENT_COOLDOWN[0]; // 5000ms

function fresh(): ModelFailover {
  return new ModelFailover([MODEL]);
}

describe('Phase B: failover backoff hardening', () => {
  describe('jitter', () => {
    it('BACKOFF-1: rng=0 → exactly the base schedule (never shorter)', () => {
      const f = fresh();
      f.recordError(MODEL, 'rate_limit', { rng: () => 0 });
      const remaining = f.getCooldownRemaining(MODEL);
      expect(remaining).toBeGreaterThanOrEqual(BASE - 100);
      expect(remaining).toBeLessThanOrEqual(BASE);
    });

    it('BACKOFF-2: rng=1 → base + 20% jitter ceiling', () => {
      const f = fresh();
      f.recordError(MODEL, 'rate_limit', { rng: () => 1 });
      const remaining = f.getCooldownRemaining(MODEL);
      const ceiling = BASE * 1.2;
      expect(remaining).toBeGreaterThanOrEqual(ceiling - 100);
      expect(remaining).toBeLessThanOrEqual(ceiling);
    });
  });

  describe('Retry-After', () => {
    it('BACKOFF-3: a longer Retry-After overrides the schedule', () => {
      const f = fresh();
      f.recordError(MODEL, 'rate_limit', { retryAfterMs: 30_000, rng: () => 0 });
      const remaining = f.getCooldownRemaining(MODEL);
      expect(remaining).toBeGreaterThanOrEqual(30_000 - 100);
      expect(remaining).toBeLessThanOrEqual(30_000);
    });

    it('BACKOFF-4: a shorter Retry-After does NOT shorten the schedule', () => {
      const f = fresh();
      f.recordError(MODEL, 'rate_limit', { retryAfterMs: 1_000, rng: () => 0 });
      const remaining = f.getCooldownRemaining(MODEL);
      expect(remaining).toBeGreaterThanOrEqual(BASE - 100);
      expect(remaining).toBeLessThanOrEqual(BASE);
    });

    it('BACKOFF-5: a pathological Retry-After is capped at 1 hour', () => {
      const f = fresh();
      f.recordError(MODEL, 'rate_limit', { retryAfterMs: 99_999_999, rng: () => 0 });
      const remaining = f.getCooldownRemaining(MODEL);
      expect(remaining).toBeGreaterThanOrEqual(3_600_000 - 100);
      expect(remaining).toBeLessThanOrEqual(3_600_000);
    });
  });

  describe('classifyCategory (structured taxonomy)', () => {
    it('BACKOFF-6: maps each category to its retry class', () => {
      const f = fresh();
      expect(f.classifyCategory('rate_limit')).toBe('transient');
      expect(f.classifyCategory('overloaded')).toBe('transient');
      expect(f.classifyCategory('timeout')).toBe('transient');
      expect(f.classifyCategory('billing')).toBe('billing');
      expect(f.classifyCategory('auth_permanent')).toBe('permanent');
      expect(f.classifyCategory('auth')).toBe('other');
      expect(f.classifyCategory('format')).toBe('other');
    });
  });

  describe('Brain.extractErrorDetails Retry-After parsing', () => {
    const extract = (err: unknown) => (Brain as any).extractErrorDetails(err) as {
      status: number; body: string | undefined; retryAfterMs: number | undefined;
    };

    it('BACKOFF-7: parses delta-seconds from responseHeaders', () => {
      const r = extract({ statusCode: 429, responseHeaders: { 'retry-after': '12' } });
      expect(r.status).toBe(429);
      expect(r.retryAfterMs).toBe(12_000);
    });

    it('BACKOFF-8: case-insensitive + dug out of nested lastError', () => {
      const r = extract({ lastError: { statusCode: 429, responseHeaders: { 'Retry-After': '7' } } });
      expect(r.retryAfterMs).toBe(7_000);
    });

    it('BACKOFF-9: parses an HTTP-date form into ms-from-now', () => {
      const when = new Date(Date.now() + 5_000).toUTCString();
      const r = extract({ statusCode: 503, responseHeaders: { 'retry-after': when } });
      expect(r.retryAfterMs).toBeGreaterThanOrEqual(3_000);
      expect(r.retryAfterMs).toBeLessThanOrEqual(6_000);
    });

    it('BACKOFF-10: no header → undefined', () => {
      const r = extract({ statusCode: 500, message: 'boom' });
      expect(r.retryAfterMs).toBeUndefined();
    });
  });
});
