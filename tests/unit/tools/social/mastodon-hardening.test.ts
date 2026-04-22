/**
 * Hardening tests for mastodon.ts — Items 6 and 8.
 *
 * ITEM 6: 429 retry aborts on caller signal (wait budget guard).
 * ITEM 8: normalizeInstance explicit non-http(s) rejection.
 *
 * fetch is mocked via vi.stubGlobal. No real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postToMastodon, MastodonError } from '../../../../src/core/tools/builtin/social/mastodon.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name] ?? null,
    },
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(typeof body === 'string' ? {} : body),
  } as unknown as Response;
}

function makeSuccessResponse(): Response {
  return makeFetchResponse(200, {
    id: 'abc123',
    url: 'https://mastodon.social/@testuser/abc123',
    created_at: '2026-04-12T10:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalInstance: string | undefined;
let originalToken: string | undefined;

beforeEach(() => {
  originalInstance = process.env['MASTODON_INSTANCE'];
  originalToken = process.env['MASTODON_ACCESS_TOKEN'];
  process.env['MASTODON_INSTANCE'] = 'mastodon.social';
  process.env['MASTODON_ACCESS_TOKEN'] = 'test-token-hardening';
});

afterEach(() => {
  if (originalInstance === undefined) {
    delete process.env['MASTODON_INSTANCE'];
  } else {
    process.env['MASTODON_INSTANCE'] = originalInstance;
  }
  if (originalToken === undefined) {
    delete process.env['MASTODON_ACCESS_TOKEN'];
  } else {
    process.env['MASTODON_ACCESS_TOKEN'] = originalToken;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ITEM 6 — 429 retry budget guard
// ---------------------------------------------------------------------------

describe('ITEM 6 — Mastodon 429 retry budget guard', () => {
  it('throws MastodonError(429) immediately when waitMs > 25_000, without sleeping', async () => {
    // Fix Date.now so the wait computation is deterministic.
    const fixedNow = 1_700_000_000_000; // arbitrary fixed timestamp
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    // X-RateLimit-Reset is 60 seconds from "now"
    const resetEpochSec = Math.floor(fixedNow / 1000) + 60;
    const rateLimitResponse = makeFetchResponse(429, 'Rate limited', {
      'X-RateLimit-Reset': String(resetEpochSec),
    });

    // Only one fetch call should happen (the initial one); no retry.
    const mockFetch = vi.fn().mockResolvedValueOnce(rateLimitResponse);
    vi.stubGlobal('fetch', mockFetch);

    // Do NOT stub setTimeout — if the code tries to sleep 60s the vitest
    // 15s timeout will catch it, confirming a genuine regression.

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Rate limit budget test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }

    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(429);
    expect(caughtError?.message).toBe('rate limit reset exceeds retry budget');
    // retryAfterMs should carry the actual wait so dispatcher can re-queue
    expect(caughtError?.retryAfterMs).toBeGreaterThan(25_000);
    // Only 1 fetch call — no retry was attempted
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws MastodonError(429) without sleeping when X-RateLimit-Reset is exactly 25_001ms away', async () => {
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    // 25_001ms from now — just over the threshold
    const resetEpochSec = (fixedNow + 25_001) / 1000;
    const rateLimitResponse = makeFetchResponse(429, 'Rate limited', {
      'X-RateLimit-Reset': String(resetEpochSec),
    });
    const mockFetch = vi.fn().mockResolvedValueOnce(rateLimitResponse);
    vi.stubGlobal('fetch', mockFetch);

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Boundary test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }

    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(429);
    expect(caughtError?.message).toBe('rate limit reset exceeds retry budget');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sleeps and retries normally when waitMs <= 25_000', async () => {
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    // 15 seconds from now — within the budget
    const resetEpochSec = Math.floor(fixedNow / 1000) + 15;
    const rateLimitResponse = makeFetchResponse(429, 'Rate limited', {
      'X-RateLimit-Reset': String(resetEpochSec),
    });
    const successResponse = makeSuccessResponse();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? rateLimitResponse : successResponse;
    });
    vi.stubGlobal('fetch', mockFetch);

    // Stub setTimeout to capture duration but resolve immediately
    let sleepDuration = 0;
    vi.stubGlobal('setTimeout', (fn: () => void, ms: number) => {
      sleepDuration = ms;
      fn();
      return 0;
    });

    const result = await postToMastodon({ status: 'Within budget test' });

    expect(result.id).toBe('abc123');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleepDuration).toBeGreaterThan(0);
    expect(sleepDuration).toBeLessThanOrEqual(25_000);
  });

  it('retries without sleeping when waitMs is 0 (missing X-RateLimit-Reset header)', async () => {
    // No X-RateLimit-Reset header → waitMs = 0 → no sleep, just retry
    const rateLimitResponse = makeFetchResponse(429, 'Rate limited'); // no headers
    const successResponse = makeSuccessResponse();

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? rateLimitResponse : successResponse;
    });
    vi.stubGlobal('fetch', mockFetch);

    // setTimeout should not be called for a 0ms wait
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const result = await postToMastodon({ status: 'No rate limit header test' });

    expect(result.id).toBe('abc123');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // setTimeout may or may not be called with 0ms — what matters is success
    // (some environments call it; the key is no >0 sleep was forced)
    const heavySleepCalls = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => typeof ms === 'number' && ms > 0,
    );
    expect(heavySleepCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ITEM 8 — normalizeInstance explicit non-http(s) scheme rejection
// ---------------------------------------------------------------------------

describe('ITEM 8 — normalizeInstance non-http(s) scheme rejection', () => {
  it('throws MastodonError with exact message for ftp:// scheme', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    process.env['MASTODON_INSTANCE'] = 'ftp://mastodon.social';

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'ftp scheme test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }

    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(0);
    expect(caughtError?.message).toBe('MASTODON_INSTANCE: non-http(s) scheme not allowed');
    // fetch must never be called for config-level rejections
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws MastodonError with exact message for file:// scheme', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    process.env['MASTODON_INSTANCE'] = 'file:///etc/passwd';

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'file scheme test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }

    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(0);
    expect(caughtError?.message).toBe('MASTODON_INSTANCE: non-http(s) scheme not allowed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws MastodonError with exact message for ws:// scheme', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    process.env['MASTODON_INSTANCE'] = 'ws://mastodon.social';

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'ws scheme test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }

    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(0);
    expect(caughtError?.message).toBe('MASTODON_INSTANCE: non-http(s) scheme not allowed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts https:// scheme (happy path)', async () => {
    process.env['MASTODON_INSTANCE'] = 'https://mastodon.social';
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', mockFetch);

    const result = await postToMastodon({ status: 'https happy path' });
    expect(result.id).toBe('abc123');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('accepts http:// scheme (non-TLS instance, happy path)', async () => {
    process.env['MASTODON_INSTANCE'] = 'http://local.mastodon.internal';
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', mockFetch);

    const result = await postToMastodon({ status: 'http happy path' });
    expect(result.id).toBe('abc123');
  });

  it('accepts bare hostname with no scheme', async () => {
    process.env['MASTODON_INSTANCE'] = 'mastodon.social';
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', mockFetch);

    const result = await postToMastodon({ status: 'bare hostname test' });
    expect(result.id).toBe('abc123');
  });

  it('still rejects protocol-relative URLs (//evil.com) independently', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    process.env['MASTODON_INSTANCE'] = '//evil.com';

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'protocol-relative test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }

    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
