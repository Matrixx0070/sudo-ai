/**
 * Unit tests for the Mastodon adapter (src/core/tools/builtin/social/mastodon.ts).
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

function makeSuccessResponse(overrides: Partial<{ id: string; url: string; created_at: string }> = {}): Response {
  return makeFetchResponse(200, {
    id: overrides.id ?? 'abc123',
    url: overrides.url ?? 'https://mastodon.social/@testuser/abc123',
    created_at: overrides.created_at ?? '2026-04-12T10:00:00.000Z',
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
  process.env['MASTODON_ACCESS_TOKEN'] = 'test-token-123';
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
// Tests
// ---------------------------------------------------------------------------

describe('postToMastodon — happy path', () => {
  it('returns MastodonPostResult with id, url, createdAt on 200 OK', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', mockFetch);

    const result = await postToMastodon({ status: 'Hello Mastodon!' });

    expect(result.id).toBe('abc123');
    expect(result.url).toBe('https://mastodon.social/@testuser/abc123');
    expect(result.createdAt).toBe('2026-04-12T10:00:00.000Z');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('defaults visibility to "public" when omitted', async () => {
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return makeSuccessResponse();
    });
    vi.stubGlobal('fetch', mockFetch);

    await postToMastodon({ status: 'Visibility test' });

    expect(capturedBody['visibility']).toBe('public');
  });

  it('includes in_reply_to_id in request body when inReplyToId is provided', async () => {
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return makeSuccessResponse();
    });
    vi.stubGlobal('fetch', mockFetch);

    await postToMastodon({ status: 'A reply', inReplyToId: 'original-456' });

    expect(capturedBody['in_reply_to_id']).toBe('original-456');
  });
});

describe('postToMastodon — validation errors (no fetch call)', () => {
  it('throws MastodonError(422) when status exceeds 500 characters without calling fetch', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const longStatus = 'a'.repeat(501);
    await expect(postToMastodon({ status: longStatus }))
      .rejects.toThrow(MastodonError);

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: longStatus });
    } catch (err) {
      caughtError = err as MastodonError;
    }
    expect(caughtError?.statusCode).toBe(422);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('postToMastodon — missing env vars', () => {
  it('throws MastodonError with statusCode 0 when MASTODON_INSTANCE is missing', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    delete process.env['MASTODON_INSTANCE'];

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Hello' });
    } catch (err) {
      caughtError = err as MastodonError;
    }
    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws MastodonError with statusCode 0 when MASTODON_ACCESS_TOKEN is missing', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    delete process.env['MASTODON_ACCESS_TOKEN'];

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Hello' });
    } catch (err) {
      caughtError = err as MastodonError;
    }
    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('postToMastodon — 429 rate limiting', () => {
  it('sleeps computed time and fires a single retry on 429 with X-RateLimit-Reset header', async () => {
    // Set reset time 2s from now (to ensure positive waitMs)
    const resetEpochSec = Math.floor(Date.now() / 1000) + 2;
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

    // Mock setTimeout to capture sleep duration and resolve immediately
    let sleepDuration = 0;
    vi.stubGlobal('setTimeout', (fn: () => void, ms: number) => {
      sleepDuration = ms;
      fn(); // resolve immediately
      return 0;
    });

    const result = await postToMastodon({ status: 'Rate limit test' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleepDuration).toBeGreaterThan(0);
    expect(sleepDuration).toBeLessThanOrEqual(300_000);
    expect(result.id).toBe('abc123');
  });

  it('throws MastodonError(429) when retry also returns 429', async () => {
    const rateLimitResponse = makeFetchResponse(429, 'Still rate limited');
    const mockFetch = vi.fn().mockResolvedValue(rateLimitResponse);
    vi.stubGlobal('fetch', mockFetch);

    // Override setTimeout to resolve immediately for the wait
    vi.stubGlobal('setTimeout', (fn: () => void, _ms: number) => {
      fn();
      return 0;
    });

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Rate limit after retry' });
    } catch (err) {
      caughtError = err as MastodonError;
    }
    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('postToMastodon — HTTP error responses', () => {
  it('throws MastodonError(500) on server error', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeFetchResponse(500, 'Internal Server Error'),
    );
    vi.stubGlobal('fetch', mockFetch);

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Server error test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }
    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(500);
  });

  it('throws MastodonError with truncated message when response body is non-JSON (LOW #8 regression)', async () => {
    const longNonJsonBody = 'x'.repeat(600);
    // 200 OK but body is not valid JSON — triggers the JSON.parse catch path
    const mockFetch = vi.fn().mockResolvedValue(
      makeFetchResponse(200, longNonJsonBody),
    );
    vi.stubGlobal('fetch', mockFetch);

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Non-JSON response test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }
    expect(caughtError).toBeInstanceOf(MastodonError);
    // Message should be truncated at 500 chars, not exceed
    expect(caughtError?.message.length).toBeLessThanOrEqual(600);
    // Message should contain the truncated non-JSON content indicator
    expect(caughtError?.message).toContain('non-JSON');
  });
});

describe('postToMastodon — normalizeInstance via MASTODON_INSTANCE env', () => {
  it('throws MastodonError(0) when MASTODON_INSTANCE is "//evil.com" (protocol-relative)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    process.env['MASTODON_INSTANCE'] = '//evil.com';

    let caughtError: MastodonError | undefined;
    try {
      await postToMastodon({ status: 'Protocol-relative test' });
    } catch (err) {
      caughtError = err as MastodonError;
    }
    expect(caughtError).toBeInstanceOf(MastodonError);
    expect(caughtError?.statusCode).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts "mastodon.social" (bare hostname, no scheme)', async () => {
    process.env['MASTODON_INSTANCE'] = 'mastodon.social';
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', mockFetch);

    const result = await postToMastodon({ status: 'Bare hostname test' });
    expect(result.id).toBe('abc123');
    // Verify URL constructed correctly
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toContain('mastodon.social/api/v1/statuses');
  });

  it('strips https:// and trailing slash from "https://mastodon.social/"', async () => {
    process.env['MASTODON_INSTANCE'] = 'https://mastodon.social/';
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', mockFetch);

    await postToMastodon({ status: 'Https with slash test' });
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    // Should not double-encode the scheme
    expect(calledUrl).toBe('https://mastodon.social/api/v1/statuses');
  });

  it('preserves non-443 port in "mastodon.social:8443"', async () => {
    process.env['MASTODON_INSTANCE'] = 'mastodon.social:8443';
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal('fetch', mockFetch);

    await postToMastodon({ status: 'Port preservation test' });
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toContain('mastodon.social:8443');
  });
});
