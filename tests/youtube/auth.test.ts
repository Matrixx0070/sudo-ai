/**
 * Tests for the YouTube OAuth token provider (GAP-01).
 *
 * The point of this module is that the system keeps working after the one-hour
 * access-token expiry, so the tests drive a fake clock across that boundary
 * rather than asserting on shapes.
 */

import { describe, it, expect, vi } from 'vitest';
import { identityPath } from '../../src/core/shared/paths.js';
import {
  canRefresh,
  getYouTubeAccessToken,
  isCacheFresh,
  readAuthConfigFromEnv,
  refreshAccessToken,
  hasYouTubeCredential,
  YouTubeAuthError,
  type AuthDeps,
  type YouTubeAuthConfig,
  type YouTubeTokenCache,
} from '../../src/core/youtube/auth.js';

const FULL_CONFIG: YouTubeAuthConfig = {
  clientId: 'cid',
  clientSecret: 'csecret',
  refreshToken: 'rtoken',
  tokenFile: '/tmp/does-not-exist/youtube-oauth.json',
};

/** Build deps with an in-memory cache and a controllable clock. */
function makeDeps(overrides: Partial<AuthDeps> = {}) {
  const store: { cache: YouTubeTokenCache | null } = { cache: null };
  let clock = 1_000_000;
  const deps: AuthDeps & { store: typeof store; setNow: (t: number) => void } = {
    fetch: vi.fn(),
    now: () => clock,
    readCache: () => store.cache,
    writeCache: (_p, c) => {
      store.cache = c;
    },
    store,
    setNow: (t: number) => {
      clock = t;
    },
    ...overrides,
  } as AuthDeps & { store: typeof store; setNow: (t: number) => void };
  return deps;
}

function tokenResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('readAuthConfigFromEnv', () => {
  it('reads the refresh-token credential set', () => {
    const cfg = readAuthConfigFromEnv({
      YOUTUBE_OAUTH_CLIENT_ID: 'a',
      YOUTUBE_OAUTH_CLIENT_SECRET: 'b',
      YOUTUBE_OAUTH_REFRESH_TOKEN: 'c',
      YOUTUBE_TOKEN_FILE: '/tmp/t.json',
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ clientId: 'a', clientSecret: 'b', refreshToken: 'c', tokenFile: '/tmp/t.json' });
    expect(canRefresh(cfg)).toBe(true);
  });

  it('defaults the token file and treats blank env vars as absent', () => {
    const cfg = readAuthConfigFromEnv({ YOUTUBE_OAUTH_CLIENT_ID: '   ' } as NodeJS.ProcessEnv);
    expect(cfg.clientId).toBeUndefined();
    // ADR 0011: the OAuth cache is principal identity, so the default resolves
    // through the identity root instead of the cwd-relative 'data/...' literal
    // that ignored DATA_DIR (and so read prod credentials under staging).
    expect(cfg.tokenFile).toBe(identityPath('youtube-oauth.json'));
    expect(cfg.tokenFile).toMatch(/[/\\]youtube-oauth\.json$/);
    expect(canRefresh(cfg)).toBe(false);
  });

  it('reports credential presence for both lanes', () => {
    expect(hasYouTubeCredential({ tokenFile: 'x' })).toBe(false);
    expect(hasYouTubeCredential({ tokenFile: 'x', staticToken: 'legacy' })).toBe(true);
    expect(hasYouTubeCredential(FULL_CONFIG)).toBe(true);
  });
});

describe('isCacheFresh', () => {
  it('treats a token inside the 60s skew window as stale', () => {
    const cache: YouTubeTokenCache = { accessToken: 'a', expiresAt: 100_000 };
    expect(isCacheFresh(cache, 30_000)).toBe(true);
    // 50s before expiry — inside the skew, so not fresh.
    expect(isCacheFresh(cache, 50_000)).toBe(false);
    expect(isCacheFresh(cache, 200_000)).toBe(false);
  });
});

describe('refreshAccessToken', () => {
  it('exchanges the refresh token and computes expiry from expires_in', async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () => tokenResponse({ access_token: 'fresh-at', expires_in: 3600 })),
    });
    const cache = await refreshAccessToken(FULL_CONFIG, deps);

    expect(cache.accessToken).toBe('fresh-at');
    expect(cache.expiresAt).toBe(deps.now() + 3_600_000);

    const [url, init] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('rtoken');
    expect(sent.get('client_secret')).toBe('csecret');
  });

  it('captures a rotated refresh token when Google returns one', async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () =>
        tokenResponse({ access_token: 'at', expires_in: 100, refresh_token: 'rotated' }),
      ),
    });
    const cache = await refreshAccessToken(FULL_CONFIG, deps);
    expect(cache.refreshToken).toBe('rotated');
  });

  it('defaults to a one-hour lifetime when expires_in is absent', async () => {
    const deps = makeDeps({ fetch: vi.fn(async () => tokenResponse({ access_token: 'at' })) });
    const cache = await refreshAccessToken(FULL_CONFIG, deps);
    expect(cache.expiresAt).toBe(deps.now() + 3_600_000);
  });

  it('refuses to refresh without a complete credential set', async () => {
    const deps = makeDeps();
    await expect(refreshAccessToken({ tokenFile: 'x', clientId: 'only-one' }, deps)).rejects.toThrow(
      YouTubeAuthError,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('surfaces invalid_grant with the re-consent hint rather than a bare HTTP error', async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () =>
        tokenResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, false, 400),
      ),
    });
    await expect(refreshAccessToken(FULL_CONFIG, deps)).rejects.toThrow(/re-run the one-time consent flow/);
  });

  it('fails loudly on a non-JSON response instead of returning a bad token', async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response),
    });
    await expect(refreshAccessToken(FULL_CONFIG, deps)).rejects.toThrow(/non-JSON/);
  });

  it('fails when the response is OK but carries no access_token', async () => {
    const deps = makeDeps({ fetch: vi.fn(async () => tokenResponse({ expires_in: 3600 })) });
    await expect(refreshAccessToken(FULL_CONFIG, deps)).rejects.toThrow(YouTubeAuthError);
  });
});

describe('getYouTubeAccessToken', () => {
  it('survives the one-hour expiry boundary unattended — the point of GAP-01', async () => {
    let issued = 0;
    const deps = makeDeps({
      fetch: vi.fn(async () => tokenResponse({ access_token: `at-${++issued}`, expires_in: 3600 })),
    });

    const first = await getYouTubeAccessToken(FULL_CONFIG, deps);
    expect(first).toMatchObject({ accessToken: 'at-1', source: 'refreshed' });

    // Same hour: served from cache, no second network call.
    const second = await getYouTubeAccessToken(FULL_CONFIG, deps);
    expect(second).toMatchObject({ accessToken: 'at-1', source: 'cached' });
    expect(deps.fetch).toHaveBeenCalledTimes(1);

    // Advance past expiry — this is where the old static-token code died.
    deps.setNow(deps.now() + 3_600_001);
    const third = await getYouTubeAccessToken(FULL_CONFIG, deps);
    expect(third).toMatchObject({ accessToken: 'at-2', source: 'refreshed' });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it('persists the refresh token alongside the access token so restarts survive', async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () => tokenResponse({ access_token: 'at', expires_in: 3600 })),
    });
    await getYouTubeAccessToken(FULL_CONFIG, deps);
    expect(deps.store.cache?.refreshToken).toBe('rtoken');
  });

  it('prefers a rotated refresh token from cache over the configured one', async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () => tokenResponse({ access_token: 'at', expires_in: 3600 })),
    });
    deps.store.cache = { accessToken: 'stale', expiresAt: 0, refreshToken: 'rotated-earlier' };

    await getYouTubeAccessToken(FULL_CONFIG, deps);
    const [, init] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(init.body as string).get('refresh_token')).toBe('rotated-earlier');
  });

  it('falls back to the legacy static token when no refresh credentials exist', async () => {
    const deps = makeDeps();
    const result = await getYouTubeAccessToken({ tokenFile: 'x', staticToken: 'legacy-at' }, deps);
    expect(result).toEqual({ accessToken: 'legacy-at', source: 'static', expiresAt: null });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('throws a directive error when nothing is configured', async () => {
    const deps = makeDeps();
    await expect(getYouTubeAccessToken({ tokenFile: 'x' }, deps)).rejects.toThrow(
      /No YouTube credential configured/,
    );
  });

  it('propagates refresh failure instead of silently using a stale cached token', async () => {
    const deps = makeDeps({
      fetch: vi.fn(async () => tokenResponse({ error: 'invalid_grant' }, false, 400)),
    });
    deps.store.cache = { accessToken: 'stale-at', expiresAt: 0 };
    await expect(getYouTubeAccessToken(FULL_CONFIG, deps)).rejects.toThrow(YouTubeAuthError);
  });
});
