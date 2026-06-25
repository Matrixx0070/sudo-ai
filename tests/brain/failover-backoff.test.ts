/**
 * @file tests/brain/failover-backoff.test.ts
 * @description Phase B — hardened backoff: jitter + Retry-After-aware cooldowns,
 * plus the structured error taxonomy classifier and Brain's Retry-After parsing.
 */

import { describe, it, expect } from 'vitest';
import { ModelFailover } from '../../src/core/brain/failover.js';
import { Brain } from '../../src/core/brain/brain.js';
import { TRANSIENT_COOLDOWN, AUTH_COOLDOWN } from '../../src/core/shared/constants.js';

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

  describe('AUTH cooldown (401 — parked, recoverable, not disabled)', () => {
    it('AUTH-1: a 401 parks the profile on the long AUTH schedule, not the 5s transient one', () => {
      const f = fresh();
      f.recordError(MODEL, 'auth', { rng: () => 0 });
      const remaining = f.getCooldownRemaining(MODEL);
      expect(remaining).toBeGreaterThanOrEqual(AUTH_COOLDOWN[0] - 100); // 60s
      expect(remaining).toBeLessThanOrEqual(AUTH_COOLDOWN[0]);
      expect(AUTH_COOLDOWN[0]).toBeGreaterThan(TRANSIENT_COOLDOWN[0]); // 60s ≫ 5s
    });

    it('AUTH-2: escalates by consecutive failure count', () => {
      const f = fresh();
      f.recordError(MODEL, 'auth', { rng: () => 0 }); // count 1 → 60s
      f.recordError(MODEL, 'auth', { rng: () => 0 }); // count 2 → 5min
      const remaining = f.getCooldownRemaining(MODEL);
      expect(remaining).toBeGreaterThanOrEqual(AUTH_COOLDOWN[1] - 100);
      expect(remaining).toBeLessThanOrEqual(AUTH_COOLDOWN[1]);
    });

    it('AUTH-3: self-recovers on the next success (not permanently disabled)', () => {
      const f = fresh();
      f.recordError(MODEL, 'auth', { rng: () => 0 });
      expect(f.getCooldownRemaining(MODEL)).toBeGreaterThan(0);
      f.recordSuccess(MODEL);
      expect(f.getCooldownRemaining(MODEL)).toBe(0);
    });

    it('AUTH-4: contrasts with auth_permanent (403), which DISABLES the profile', () => {
      const permanent = fresh();
      permanent.recordError(MODEL, 'auth_permanent');
      expect(permanent.getNextProfile()).toBeNull(); // disabled → no usable profile

      const recoverable = fresh();
      recoverable.recordError(MODEL, 'auth');
      expect(recoverable.getNextProfile()).not.toBeNull(); // parked but rescuable
    });
  });

  describe('Brain.extractErrorDetails auth recovery', () => {
    const extract = (err: unknown) => (Brain as any).extractErrorDetails(err) as {
      status: number; body: string | undefined; retryAfterMs: number | undefined;
    };

    it('AUTHX-1: digs a 401 statusCode out of a .cause chain', () => {
      const err = {
        message: 'No output generated. Check the stream for errors.',
        cause: {
          statusCode: 401,
          responseBody: '{"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
        },
      };
      expect(extract(err).status).toBe(401);
    });

    it('AUTHX-2: recovers 401 by body signature when no status is present', () => {
      expect(extract({ message: 'Invalid bearer token' }).status).toBe(401);
      expect(extract(new Error('authentication_error: Invalid bearer token')).status).toBe(401);
    });

    it('AUTHX-3: recovers 401 from an invalid_grant refresh failure body', () => {
      const err = { message: 'boom', cause: { message: '{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}' } };
      expect(extract(err).status).toBe(401);
    });

    it('AUTHX-4: a generic 500 with no auth signature stays 500 (no false positive)', () => {
      expect(extract({ statusCode: 500, message: 'internal boom' }).status).toBe(500);
    });

    it('AUTHX-5: a real 429 is unaffected', () => {
      expect(extract({ statusCode: 429, message: 'rate limited' }).status).toBe(429);
    });

    it('AUTHX-6: permission_error maps to 403', () => {
      expect(extract({ message: 'permission_error: not allowed' }).status).toBe(403);
    });
  });
});
