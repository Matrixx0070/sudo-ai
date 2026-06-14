/**
 * @file claude-oauth-manager.ts
 * @description Self-contained Claude OAuth (PKCE) connector.
 *
 * Unlike claude-token-manager.ts (which piggy-backs on the `claude` CLI's
 * credentials file), this manager owns the entire OAuth lifecycle:
 *
 *   1. PKCE login: generates verifier+challenge, returns the authorize URL,
 *      exchanges the user-pasted code at /v1/oauth/token.
 *   2. Persistent store: writes its own credentials to <DATA_DIR>/claude-oauth.json
 *      (independent of /root/.claude/.credentials.json).
 *   3. Auto-refresh: same proven loop as ClaudeTokenManager — refreshes 10 min
 *      before expiry, writes the new token back to disk.
 *
 * The PKCE parameters (authorize URL, client_id, redirect_uri, scope, code#state
 * concatenation in the exchange body) are reverse-engineered from the Claude
 * Code CLI's documented OAuth flow. The refresh endpoint and client_id used for
 * the refresh grant are byte-identical to the existing ClaudeTokenManager.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:claude-oauth');

// ---------------------------------------------------------------------------
// Constants — Claude Code OAuth parameters
//
// These were verified end-to-end against a live Claude.ai Max account on
// 2026-06-14. The endpoints + body shapes match what `claude setup-token`
// itself sends; both were extracted from the @anthropic-ai/claude-code 2.1.177
// binary and confirmed by a real token exchange that returned a Bearer token.
// ---------------------------------------------------------------------------

const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/**
 * Loopback redirect host — the per-login URI is built by combining this with
 * a random port chosen at startLogin() time. The authorize endpoint accepts
 * any loopback port (RFC 8252 §7.3). The user's browser will fail to reach
 * the port (we're typically on a remote host), but the URL bar shows
 * `?code=...&state=...` which is what they paste back.
 */
const LOOPBACK_HOST = 'http://localhost';
const OAUTH_SCOPE = 'user:inference';

/**
 * The refresh grant accepts a separate, legacy client_id string. Kept identical
 * to claude-token-manager.ts so this manager refreshes the same way the proven
 * path does — only the authorize+exchange step uses the UUID client_id.
 */
const REFRESH_CLIENT_ID = 'claude-code';

const DEFAULT_STORE_PATH = dataPath('claude-oauth.json');

/** Refresh the token this many ms before it expires (10 minutes). */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** How often the auto-refresh timer checks expiry (30 minutes). */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Default access-token lifetime when the token endpoint omits expires_in (8h). */
const DEFAULT_TOKEN_LIFETIME_SEC = 28_800;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Absolute ms epoch when the access token expires. */
  expiresAt: number;
  scopes: string[];
  /** Optional — populated when the token endpoint returns it. */
  subscriptionType?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  account?: { subscription_type?: string };
}

/** PKCE handshake state held between login/start and login/complete. */
export interface PendingLogin {
  verifier: string;
  state: string;
  authorizeUrl: string;
  /** Per-login loopback redirect — must be reused verbatim in the exchange. */
  redirectUri: string;
  createdAt: number;
}

export interface ClaudeOAuthStatus {
  connected: boolean;
  expiresAtMs: number | null;
  expiresInSec: number | null;
  scopes: string[];
  subscriptionType: string | null;
  storePath: string;
}

// ---------------------------------------------------------------------------
// PKCE helpers (RFC 7636)
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkceVerifier(): string {
  // 32 bytes -> 43-char base64url string, well within the RFC's 43..128 range.
  return base64UrlEncode(randomBytes(32));
}

export function pkceChallengeFor(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

/**
 * Pick a random ephemeral port in the range [10000, 60000). The exact port
 * does not matter — the authorize endpoint accepts any loopback port — but it
 * must match between the authorize URL and the exchange body.
 */
function randomLoopbackPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

export function buildLoopbackRedirectUri(port: number): string {
  return `${LOOPBACK_HOST}:${port}/callback`;
}

export function buildAuthorizeUrl(verifier: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CODE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: pkceChallengeFor(verifier),
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// ClaudeOAuthManager
// ---------------------------------------------------------------------------

export class ClaudeOAuthManager {
  private credentials: ClaudeOAuthCredentials | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private pending: PendingLogin | null = null;

  constructor(private readonly storePath: string = DEFAULT_STORE_PATH) {
    this.loadCredentials();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private loadCredentials(): void {
    try {
      if (!existsSync(this.storePath)) {
        log.debug({ path: this.storePath }, 'No Claude OAuth credentials file yet');
        return;
      }
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<ClaudeOAuthCredentials>;
      if (!raw.accessToken || !raw.refreshToken || typeof raw.expiresAt !== 'number') {
        log.warn({ path: this.storePath }, 'Claude OAuth credentials file is incomplete — ignoring');
        return;
      }
      this.credentials = {
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiresAt: raw.expiresAt,
        scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
        subscriptionType: raw.subscriptionType,
      };
      log.info(
        {
          path: this.storePath,
          expiresInMin: Math.round((this.credentials.expiresAt - Date.now()) / 60_000),
          subscriptionType: this.credentials.subscriptionType,
        },
        'Claude OAuth credentials loaded',
      );
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to load Claude OAuth credentials');
    }
  }

  private saveCredentials(): void {
    if (!this.credentials) return;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      writeFileSync(this.storePath, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
      log.debug({ path: this.storePath }, 'Claude OAuth credentials persisted');
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to persist Claude OAuth credentials');
    }
  }

  // -------------------------------------------------------------------------
  // PKCE login flow
  // -------------------------------------------------------------------------

  /**
   * Start a new login: generates a fresh PKCE verifier+state, returns the
   * authorize URL the user must open. The verifier is held in memory until
   * completeLogin() consumes it.
   */
  startLogin(): PendingLogin {
    const verifier = generatePkceVerifier();
    // 32-byte state matches what `claude setup-token` itself sends (~43 chars
    // base64url) — Anthropic accepts shorter, but mirroring is the safest
    // forward-compatible choice.
    const state = base64UrlEncode(randomBytes(32));
    const port = randomLoopbackPort();
    const redirectUri = buildLoopbackRedirectUri(port);
    const authorizeUrl = buildAuthorizeUrl(verifier, state, redirectUri);
    this.pending = { verifier, state, authorizeUrl, redirectUri, createdAt: Date.now() };
    log.info({ port }, 'PKCE login started — authorize URL ready');
    return this.pending;
  }

  /**
   * Complete a previously-started login by exchanging the user-pasted code.
   *
   * The user can paste either just the raw code (`abc123`) or the entire
   * callback URL bar contents (`http://localhost:.../callback?code=abc123&state=...`).
   * We normalise to the raw code value before sending. The exchange body shape
   * is JSON `{grant_type, code, redirect_uri, client_id, code_verifier, state}`
   * — verified live against a Max account on 2026-06-14.
   *
   * @throws Error when no login is in progress or when the token endpoint
   *         returns a non-2xx response.
   */
  async completeLogin(pastedCode: string): Promise<ClaudeOAuthCredentials> {
    const pending = this.pending;
    if (!pending) {
      throw new Error('No Claude OAuth login in progress — call startLogin first');
    }

    const trimmed = pastedCode.trim();
    if (!trimmed) {
      throw new Error('Pasted code is empty');
    }

    // Extract just the code value, tolerating any of:
    //   "code"
    //   "code&state=..."
    //   "http://localhost:N/callback?code=...&state=..."
    let codePart = trimmed;
    if (/^https?:\/\//i.test(trimmed) || trimmed.includes('?')) {
      const match = /[?&]code=([^&#]+)/.exec(trimmed);
      if (match?.[1]) codePart = decodeURIComponent(match[1]);
    } else {
      codePart = trimmed.split(/[&?#]/)[0] ?? trimmed;
    }

    const body = {
      grant_type: 'authorization_code',
      code: codePart,
      redirect_uri: pending.redirectUri,
      client_id: CLAUDE_CODE_CLIENT_ID,
      code_verifier: pending.verifier,
      state: pending.state,
    };

    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Token exchange network error: ${String(err)}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)');
      log.error(
        { status: res.status, body: errText.substring(0, 300) },
        'Claude OAuth token exchange failed',
      );
      throw new Error(`Token exchange HTTP ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = (await res.json()) as TokenResponse;
    if (!data.access_token || !data.refresh_token) {
      throw new Error('Token endpoint response missing access_token or refresh_token');
    }

    const creds: ClaudeOAuthCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? DEFAULT_TOKEN_LIFETIME_SEC) * 1_000,
      scopes: data.scope ? data.scope.split(/\s+/) : OAUTH_SCOPE.split(/\s+/),
      subscriptionType: data.account?.subscription_type,
    };

    this.credentials = creds;
    this.pending = null;
    this.saveCredentials();

    log.info(
      {
        expiresInMin: Math.round((creds.expiresAt - Date.now()) / 60_000),
        scopes: creds.scopes,
      },
      'Claude OAuth login complete',
    );
    return creds;
  }

  /**
   * Cancel an in-progress login (clears the pending verifier+state).
   */
  cancelLogin(): void {
    this.pending = null;
  }

  // -------------------------------------------------------------------------
  // Token use + refresh
  // -------------------------------------------------------------------------

  /**
   * Return the access token if it's outside the refresh buffer; otherwise null.
   */
  getAccessToken(): string | null {
    if (!this.credentials) return null;
    if (this.credentials.expiresAt - Date.now() < REFRESH_BUFFER_MS) return null;
    return this.credentials.accessToken;
  }

  /**
   * Force a refresh against /v1/oauth/token. Updates in-memory + on-disk state.
   * Returns true on success.
   */
  async refreshToken(): Promise<boolean> {
    if (!this.credentials?.refreshToken) {
      log.warn('Cannot refresh — no refresh token in store');
      return false;
    }

    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: this.credentials.refreshToken,
          client_id: REFRESH_CLIENT_ID,
        }),
      });
    } catch (err) {
      log.error({ err: String(err) }, 'Claude OAuth refresh network error');
      return false;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)');
      log.error({ status: res.status, body: errText.substring(0, 300) }, 'Claude OAuth refresh HTTP error');
      return false;
    }

    let data: TokenResponse;
    try {
      data = (await res.json()) as TokenResponse;
    } catch (err) {
      log.error({ err: String(err) }, 'Claude OAuth refresh response is not JSON');
      return false;
    }

    if (!data.access_token) {
      log.error('Claude OAuth refresh response missing access_token');
      return false;
    }

    this.credentials.accessToken = data.access_token;
    if (data.refresh_token) this.credentials.refreshToken = data.refresh_token;
    this.credentials.expiresAt = Date.now() + (data.expires_in ?? DEFAULT_TOKEN_LIFETIME_SEC) * 1_000;
    this.saveCredentials();

    log.info(
      { expiresInMin: Math.round((this.credentials.expiresAt - Date.now()) / 60_000) },
      'Claude OAuth token refreshed',
    );
    return true;
  }

  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    if (this.credentials) {
      const left = this.credentials.expiresAt - Date.now();
      if (left < REFRESH_BUFFER_MS) {
        this.refreshToken().catch((err: unknown) => {
          log.error({ err: String(err) }, 'Immediate Claude OAuth refresh failed');
        });
      }
    }
    this.refreshTimer = setInterval(() => {
      void this.checkAndRefresh();
    }, CHECK_INTERVAL_MS);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
    log.info(
      { checkIntervalMin: CHECK_INTERVAL_MS / 60_000, bufferMin: REFRESH_BUFFER_MS / 60_000 },
      'Claude OAuth auto-refresh started',
    );
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async checkAndRefresh(): Promise<void> {
    if (!this.credentials) {
      this.loadCredentials();
      return;
    }
    const left = this.credentials.expiresAt - Date.now();
    if (left < REFRESH_BUFFER_MS) {
      await this.refreshToken();
    }
  }

  // -------------------------------------------------------------------------
  // Introspection + teardown
  // -------------------------------------------------------------------------

  isAvailable(): boolean {
    return this.credentials !== null && this.credentials.accessToken.length > 0;
  }

  getStatus(): ClaudeOAuthStatus {
    if (!this.credentials) {
      return {
        connected: false,
        expiresAtMs: null,
        expiresInSec: null,
        scopes: [],
        subscriptionType: null,
        storePath: this.storePath,
      };
    }
    return {
      connected: true,
      expiresAtMs: this.credentials.expiresAt,
      expiresInSec: Math.round((this.credentials.expiresAt - Date.now()) / 1000),
      scopes: this.credentials.scopes,
      subscriptionType: this.credentials.subscriptionType ?? null,
      storePath: this.storePath,
    };
  }

  /**
   * Wipe in-memory + on-disk credentials. Stops auto-refresh.
   */
  disconnect(): void {
    this.credentials = null;
    this.pending = null;
    this.stopAutoRefresh();
    try {
      if (existsSync(this.storePath)) {
        writeFileSync(this.storePath, '{}', { mode: 0o600 });
      }
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to wipe Claude OAuth store on disconnect');
    }
    log.info('Claude OAuth credentials disconnected');
  }
}

// ---------------------------------------------------------------------------
// Singleton — shared between cli.ts boot, the provider factory, the CLI
// subcommand process (which constructs its own), and the admin routes.
// ---------------------------------------------------------------------------

let singleton: ClaudeOAuthManager | null = null;

/** Return the process-wide manager, creating it lazily. */
export function getClaudeOAuthManager(): ClaudeOAuthManager {
  if (!singleton) singleton = new ClaudeOAuthManager();
  return singleton;
}

/** Reset the singleton — for tests only. */
export function __resetClaudeOAuthManagerForTests(): void {
  singleton?.stopAutoRefresh();
  singleton = null;
}
