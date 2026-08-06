/**
 * @file auth.ts
 * @description YouTube OAuth 2.0 access-token provider with automatic refresh.
 *
 * Closes GAP-01. Before this module every YouTube write in the repo read a bare
 * `YOUTUBE_OAUTH_TOKEN` env string — a Google access token, which expires in
 * roughly one hour. That made unattended operation impossible: a human had to
 * paste a fresh token before each run.
 *
 * The refresh-token pattern here mirrors `src/core/gdrive/auth.ts`, including
 * 0600 persistence of rotated credentials so long-lived daemons survive a
 * restart. It deliberately does NOT import the gdrive module: CLAUDE.md
 * invariant 3 keeps `core/gdrive` out of other subsystems, and coupling
 * publishing to the Drive stack would be wrong regardless.
 *
 * The token exchange is a plain POST to Google's token endpoint rather than a
 * `googleapis` OAuth2 client. One endpoint, one grant type — a direct call is
 * simpler than the client object and lets tests inject a fetch instead of
 * mocking a library.
 *
 * Environment:
 *   YOUTUBE_OAUTH_CLIENT_ID      — OAuth client id
 *   YOUTUBE_OAUTH_CLIENT_SECRET  — OAuth client secret
 *   YOUTUBE_OAUTH_REFRESH_TOKEN  — long-lived refresh token (preferred: via file)
 *   YOUTUBE_TOKEN_FILE           — cache path (default: data/youtube-oauth.json, 0600)
 *   YOUTUBE_OAUTH_TOKEN          — LEGACY static access token; still honoured so
 *                                  existing setups keep working, but it cannot be
 *                                  renewed and is unsuitable for unattended use.
 *
 * Credentials are never logged. Only token *lengths* and expiry timestamps are.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { identityPath } from '../shared/paths.js';

const log = createLogger('youtube:auth');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Refresh this many ms before the real expiry so an in-flight call never races it. */
const EXPIRY_SKEW_MS = 60_000;

// ADR 0011: the OAuth cache is principal identity, so it resolves through the
// identity root instead of a cwd-relative 'data/...' literal that ignored
// DATA_DIR entirely (and so read prod credentials under staging).
const DEFAULT_TOKEN_FILE = identityPath('youtube-oauth.json');

/** Shape persisted to YOUTUBE_TOKEN_FILE. Never contains the client secret. */
export interface YouTubeTokenCache {
  accessToken: string;
  /** Epoch ms at which the access token stops being valid. */
  expiresAt: number;
  /** Present when Google rotated the refresh token during an exchange. */
  refreshToken?: string;
}

export interface YouTubeAuthConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** Legacy non-renewable access token. */
  staticToken?: string;
  tokenFile: string;
}

/** How the returned token was obtained — lets callers warn about the legacy lane. */
export type TokenSource = 'refreshed' | 'cached' | 'static';

export interface TokenResult {
  accessToken: string;
  source: TokenSource;
  /** Epoch ms, or null for the legacy static lane where expiry is unknown. */
  expiresAt: number | null;
}

/** Injectable seam so tests exercise the real logic without network or clock. */
export interface AuthDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  readCache: (path: string) => YouTubeTokenCache | null;
  writeCache: (path: string, cache: YouTubeTokenCache) => void;
}

export class YouTubeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeAuthError';
  }
}

// ---------------------------------------------------------------------------
// Config + cache I/O
// ---------------------------------------------------------------------------

/** Read auth config from the environment. Missing values stay undefined. */
export function readAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YouTubeAuthConfig {
  return {
    clientId: env['YOUTUBE_OAUTH_CLIENT_ID']?.trim() || undefined,
    clientSecret: env['YOUTUBE_OAUTH_CLIENT_SECRET']?.trim() || undefined,
    refreshToken: env['YOUTUBE_OAUTH_REFRESH_TOKEN']?.trim() || undefined,
    staticToken: env['YOUTUBE_OAUTH_TOKEN']?.trim() || undefined,
    tokenFile: env['YOUTUBE_TOKEN_FILE']?.trim() || DEFAULT_TOKEN_FILE,
  };
}

/** True when a full refresh-capable credential set is present. */
export function canRefresh(config: YouTubeAuthConfig): boolean {
  return Boolean(config.clientId && config.clientSecret && config.refreshToken);
}

export function readCacheFile(path: string): YouTubeTokenCache | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<YouTubeTokenCache>;
    if (typeof raw.accessToken !== 'string' || !raw.accessToken) return null;
    if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt)) return null;
    return {
      accessToken: raw.accessToken,
      expiresAt: raw.expiresAt,
      ...(typeof raw.refreshToken === 'string' && raw.refreshToken
        ? { refreshToken: raw.refreshToken }
        : {}),
    };
  } catch {
    // Missing or corrupt cache is not an error — we simply refresh.
    return null;
  }
}

export function writeCacheFile(path: string, cache: YouTubeTokenCache): void {
  try {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(cache), { mode: 0o600 });
  } catch (err) {
    // Best-effort: losing the cache costs one extra refresh, not correctness.
    log.warn({ err: (err as Error).message }, 'Could not persist YouTube token cache');
  }
}

const defaultDeps: AuthDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
  readCache: readCacheFile,
  writeCache: writeCacheFile,
};

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Throws {@link YouTubeAuthError} on any non-OK response. It never falls back to
 * a stale token: publishing with an expired credential fails confusingly at the
 * API, whereas failing here says exactly what is wrong.
 */
export async function refreshAccessToken(
  config: YouTubeAuthConfig,
  deps: AuthDeps = defaultDeps,
): Promise<YouTubeTokenCache> {
  if (!canRefresh(config)) {
    throw new YouTubeAuthError(
      'Cannot refresh: YOUTUBE_OAUTH_CLIENT_ID, YOUTUBE_OAUTH_CLIENT_SECRET and ' +
        'YOUTUBE_OAUTH_REFRESH_TOKEN must all be set.',
    );
  }

  const body = new URLSearchParams({
    client_id: config.clientId!,
    client_secret: config.clientSecret!,
    refresh_token: config.refreshToken!,
    grant_type: 'refresh_token',
  });

  const res = await deps.fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let payload: GoogleTokenResponse;
  try {
    payload = (await res.json()) as GoogleTokenResponse;
  } catch {
    throw new YouTubeAuthError(`Token endpoint returned non-JSON (HTTP ${res.status}).`);
  }

  if (!res.ok || !payload.access_token) {
    // `invalid_grant` is the one worth calling out: it means the refresh token
    // was revoked or expired, and only a human re-running consent can fix it.
    const detail = payload.error_description ?? payload.error ?? `HTTP ${res.status}`;
    const hint =
      payload.error === 'invalid_grant'
        ? ' — the refresh token is revoked or expired; re-run the one-time consent flow.'
        : '';
    throw new YouTubeAuthError(`YouTube token refresh failed: ${detail}${hint}`);
  }

  const expiresInMs = (payload.expires_in ?? 3600) * 1000;
  const cache: YouTubeTokenCache = {
    accessToken: payload.access_token,
    expiresAt: deps.now() + expiresInMs,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
  };

  log.info(
    { expiresAt: new Date(cache.expiresAt).toISOString(), rotated: Boolean(payload.refresh_token) },
    'YouTube access token refreshed',
  );
  return cache;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** A cached token is usable until EXPIRY_SKEW_MS before its stated expiry. */
export function isCacheFresh(cache: YouTubeTokenCache, now: number): boolean {
  return cache.expiresAt - EXPIRY_SKEW_MS > now;
}

/**
 * Return a usable YouTube access token, refreshing and persisting as needed.
 *
 * Resolution order:
 *   1. Fresh cached token from YOUTUBE_TOKEN_FILE.
 *   2. Refresh via the refresh-token grant (result is cached at 0600).
 *   3. Legacy static YOUTUBE_OAUTH_TOKEN — returned with a warning, because it
 *      cannot be renewed and will stop working within the hour.
 *
 * @throws {YouTubeAuthError} when no credential of any kind is configured.
 */
export async function getYouTubeAccessToken(
  config: YouTubeAuthConfig = readAuthConfigFromEnv(),
  deps: AuthDeps = defaultDeps,
): Promise<TokenResult> {
  if (canRefresh(config)) {
    const cached = deps.readCache(config.tokenFile);
    if (cached && isCacheFresh(cached, deps.now())) {
      return { accessToken: cached.accessToken, source: 'cached', expiresAt: cached.expiresAt };
    }

    // A rotated refresh token in the cache supersedes the configured one.
    const effective: YouTubeAuthConfig = cached?.refreshToken
      ? { ...config, refreshToken: cached.refreshToken }
      : config;

    const fresh = await refreshAccessToken(effective, deps);
    // Carry the refresh token forward so rotation is never lost across restarts.
    deps.writeCache(config.tokenFile, {
      ...fresh,
      refreshToken: fresh.refreshToken ?? effective.refreshToken!,
    });
    return { accessToken: fresh.accessToken, source: 'refreshed', expiresAt: fresh.expiresAt };
  }

  if (config.staticToken) {
    log.warn(
      'Using legacy YOUTUBE_OAUTH_TOKEN. Google access tokens expire in ~1h and this one ' +
        'cannot be renewed — unattended operation will fail. Configure ' +
        'YOUTUBE_OAUTH_CLIENT_ID/_SECRET/_REFRESH_TOKEN instead.',
    );
    return { accessToken: config.staticToken, source: 'static', expiresAt: null };
  }

  throw new YouTubeAuthError(
    'No YouTube credential configured. Set YOUTUBE_OAUTH_CLIENT_ID, ' +
      'YOUTUBE_OAUTH_CLIENT_SECRET and YOUTUBE_OAUTH_REFRESH_TOKEN (preferred), ' +
      'or YOUTUBE_OAUTH_TOKEN for a single short-lived session.',
  );
}

/** True when any YouTube credential is configured. Cheap, no network. */
export function hasYouTubeCredential(config: YouTubeAuthConfig = readAuthConfigFromEnv()): boolean {
  return canRefresh(config) || Boolean(config.staticToken);
}
