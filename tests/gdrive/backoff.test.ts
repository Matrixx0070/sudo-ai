import { describe, it, expect } from 'vitest';
import { withBackoff, backoffDelayMs } from '../../src/core/gdrive/backoff.js';
import { GdriveApiError, mapGdriveError } from '../../src/core/gdrive/errors.js';

const instantSleep = () => Promise.resolve();

function apiError(status: number, reason?: string): unknown {
  return {
    message: `http ${status}`,
    response: {
      status,
      data: { error: { errors: reason ? [{ reason }] : [], message: `http ${status}` } },
    },
  };
}

describe('mapGdriveError', () => {
  it('classifies 429 and 403-rate as retryable rate errors', () => {
    expect(mapGdriveError(apiError(429)).kind).toBe('rate');
    expect(mapGdriveError(apiError(403, 'userRateLimitExceeded')).kind).toBe('rate');
    expect(mapGdriveError(apiError(403, 'rateLimitExceeded')).retryable).toBe(true);
  });

  it('classifies permission 403 / 401 as non-retryable auth', () => {
    const e = mapGdriveError(apiError(403, 'insufficientFilePermissions'));
    expect(e.kind).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(mapGdriveError(apiError(401)).kind).toBe('auth');
  });

  it('classifies 404, 5xx, 400, and network codes', () => {
    expect(mapGdriveError(apiError(404)).kind).toBe('not_found');
    expect(mapGdriveError(apiError(503)).kind).toBe('server');
    expect(mapGdriveError(apiError(400)).kind).toBe('invalid');
    expect(mapGdriveError({ message: 'x', code: 'ECONNRESET' }).kind).toBe('network');
  });

  it('is idempotent on already-mapped errors', () => {
    const e = new GdriveApiError('rate', 'x', 429);
    expect(mapGdriveError(e)).toBe(e);
  });
});

describe('withBackoff', () => {
  it('retries retryable errors up to maxRetries then throws mapped error', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw apiError(503);
        },
        { maxRetries: 3, sleep: instantSleep },
      ),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(calls).toBe(4); // initial + 3 retries
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls++;
          throw apiError(403, 'insufficientFilePermissions');
        },
        { maxRetries: 5, sleep: instantSleep },
      ),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toBe(1);
  });

  it('returns the value once a retry succeeds', async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls++;
        if (calls < 3) throw apiError(429);
        return 'ok';
      },
      { maxRetries: 5, sleep: instantSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('delay grows exponentially with full jitter and caps', () => {
    // random()=1 gives the ceiling for each attempt.
    const one = () => 0.999999;
    const d0 = backoffDelayMs(0, 500, 30_000, one);
    const d1 = backoffDelayMs(1, 500, 30_000, one);
    const d6 = backoffDelayMs(6, 500, 30_000, one);
    expect(d0).toBeLessThanOrEqual(500);
    expect(d1).toBeLessThanOrEqual(1000);
    expect(d1).toBeGreaterThan(d0 / 2); // grew
    expect(d6).toBeLessThanOrEqual(30_000); // capped
    // random()=0 -> full jitter can pick zero.
    expect(backoffDelayMs(3, 500, 30_000, () => 0)).toBe(0);
  });
});
