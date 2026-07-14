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

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { writeFileAtomic } from '../../core/shared/atomic-write.js';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { dataPath } from '../../core/shared/paths.js';
import { createLogger } from '../../core/shared/logger.js';

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
 * Fixed OAuth redirect URI registered for the Claude Code client_id. Anthropic
 * rejects arbitrary loopback redirects for this client ("Invalid OAuth Request
 * — Missing redirect_uri parameter"); the authorize request and the token
 * exchange must BOTH use this exact hosted callback. After approval it renders
 * the `code#state` for the user to paste back. NB: the user must already be
 * signed in to claude.ai, or the authorize endpoint bounces through login and
 * drops the query params (same "Missing redirect_uri" error). Verified against
 * the claude CLI bundle (oauth/code/callback on platform.claude.com).
 */
const OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const OAUTH_SCOPE = 'user:inference';

/** Anthropic `/v1/models` endpoint — same host the AI SDK uses for inference. */
const MODELS_URL = 'https://api.anthropic.com/v1/models';
/** Anthropic API version header — same value Claude Code sends. */
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * OAuth-specific Anthropic beta header. The token endpoint returns OAuth
 * tokens that the inference API only accepts when this header is present.
 */
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
/**
 * Auto-refresh the cached models list when older than this (24h). The picker
 * UI also exposes a manual refresh.
 */
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Refresh uses the same UUID client_id as the authorize+exchange. The legacy
 * 'claude-code' slug was accepted at integration time (2026-06-14) but stopped
 * working a day later — Anthropic now returns 400 "Invalid request format"
 * for that value. The UUID returns valid token responses (or 429 when
 * rate-limited, which is normal). Keeping the two client_ids identical is
 * also the simpler invariant: one constant to track.
 */
const REFRESH_CLIENT_ID = CLAUDE_CODE_CLIENT_ID;

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
  /**
   * User-picked default model id (e.g. "claude-opus-4-8"). When unset, the
   * provider falls back to the latest model from `models` (by created_at).
   */
  defaultModel?: string;
  /** Cached `/v1/models` response — refreshed on demand by `refreshModels`. */
  models?: ClaudeModelEntry[];
  /** ms epoch when `models` was fetched, used to decide if it's stale. */
  modelsFetchedAt?: number;
}

/**
 * A single model entry as returned by Anthropic's `/v1/models`. We persist a
 * trimmed view (id, display_name, created_at) and ignore the verbose
 * capability matrix — none of the picker UI needs it today, and keeping the
 * store small keeps boot fast.
 */
export interface ClaudeModelEntry {
  id: string;
  displayName: string;
  /** ISO 8601 string from the API; preserved as-is so sort comparisons work. */
  createdAt: string;
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
  /** Resolved default model id (user-picked, or latest from `models`). */
  defaultModel: string | null;
  /** Cached model list count — 0 when the list has never been fetched. */
  modelsCount: number;
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
        defaultModel: raw.defaultModel,
        models: Array.isArray(raw.models) ? raw.models : undefined,
        modelsFetchedAt: raw.modelsFetchedAt,
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
      // Atomic + 0o600: a torn write would corrupt the OAuth store and break the
      // provider (the 401-storm mode); the temp inherits the secret file's perms.
      writeFileAtomic(this.storePath, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
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
    const redirectUri = OAUTH_REDIRECT_URI;
    const authorizeUrl = buildAuthorizeUrl(verifier, state, redirectUri);
    this.pending = { verifier, state, authorizeUrl, redirectUri, createdAt: Date.now() };
    log.info('PKCE login started — authorize URL ready');
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
        defaultModel: null,
        modelsCount: 0,
      };
    }
    return {
      connected: true,
      expiresAtMs: this.credentials.expiresAt,
      expiresInSec: Math.round((this.credentials.expiresAt - Date.now()) / 1000),
      scopes: this.credentials.scopes,
      subscriptionType: this.credentials.subscriptionType ?? null,
      storePath: this.storePath,
      defaultModel: this.getDefaultModel(),
      modelsCount: this.credentials.models?.length ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Models — listing + default selection
  // -------------------------------------------------------------------------

  /**
   * Return the cached model list (may be empty if `refreshModels` has never
   * been called or after a `disconnect`). Sorted newest first by `createdAt`.
   */
  listModels(): ClaudeModelEntry[] {
    const models = this.credentials?.models ?? [];
    // Defensive copy so callers can't mutate the stored array. The sort key is
    // an ISO 8601 string, which compares correctly with string comparison.
    return [...models].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /**
   * Resolve which model the brain should use:
   *   1. The user-picked default (`defaultModel`) if it still exists in the
   *      cached list (or no list yet).
   *   2. Otherwise the newest cached model by `createdAt`.
   *   3. Otherwise null.
   */
  getDefaultModel(): string | null {
    if (!this.credentials) return null;
    const picked = this.credentials.defaultModel;
    const cached = this.credentials.models ?? [];
    if (picked) {
      // If we have a cached list and the picked id is gone (deprecated by
      // Anthropic), fall through to the latest — never return a stale id.
      if (cached.length === 0 || cached.some((m) => m.id === picked)) {
        return picked;
      }
    }
    if (cached.length === 0) return null;
    const sorted = this.listModels();
    return sorted[0]?.id ?? null;
  }

  /**
   * Persist the user-picked default model id. Returns false when the id is
   * not present in the cached list (caller should refresh first or surface
   * the error to the user).
   */
  setDefaultModel(id: string): boolean {
    if (!this.credentials) return false;
    const cached = this.credentials.models ?? [];
    if (cached.length > 0 && !cached.some((m) => m.id === id)) {
      log.warn({ id, cached: cached.map((m) => m.id) }, 'setDefaultModel: id not in cached model list');
      return false;
    }
    this.credentials.defaultModel = id;
    this.saveCredentials();
    log.info({ id }, 'Claude OAuth default model set');
    return true;
  }

  /**
   * Fetch the live `/v1/models` list with the current OAuth token, cache it
   * on disk, and return the trimmed view. Throws on any non-2xx so callers
   * can surface the API error verbatim.
   */
  async refreshModels(): Promise<ClaudeModelEntry[]> {
    if (!this.credentials) {
      throw new Error('Cannot refresh models — not connected');
    }
    // The token must be valid for the inference API to accept the request.
    // getAccessToken returns null inside the 10-min refresh buffer, so trigger
    // a refresh first when needed.
    let token = this.getAccessToken();
    if (!token) {
      const ok = await this.refreshToken();
      if (!ok) throw new Error('Token refresh failed before models fetch');
      token = this.getAccessToken();
      if (!token) throw new Error('Token still unavailable after refresh');
    }

    let res: Response;
    try {
      res = await fetch(MODELS_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA,
        },
      });
    } catch (err) {
      throw new Error(`Models fetch network error: ${String(err)}`);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)');
      throw new Error(`Models fetch HTTP ${res.status}: ${errText.substring(0, 300)}`);
    }

    const raw = (await res.json()) as { data?: Array<{ id?: string; display_name?: string; created_at?: string }> };
    const data = Array.isArray(raw.data) ? raw.data : [];
    const trimmed: ClaudeModelEntry[] = data
      .filter((m): m is { id: string; display_name?: string; created_at?: string } => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        displayName: typeof m.display_name === 'string' ? m.display_name : m.id,
        createdAt: typeof m.created_at === 'string' ? m.created_at : new Date(0).toISOString(),
      }));

    this.credentials.models = trimmed;
    this.credentials.modelsFetchedAt = Date.now();
    this.saveCredentials();
    log.info({ count: trimmed.length }, 'Claude OAuth models refreshed');
    return this.listModels();
  }

  /**
   * Lazy variant: returns the cached list if still fresh (< MODELS_TTL_MS),
   * otherwise refreshes. Used by the dashboard so the user sees something
   * immediately even if a manual refresh hasn't been hit recently.
   */
  async getModelsLazy(): Promise<ClaudeModelEntry[]> {
    if (!this.credentials) return [];
    const age = Date.now() - (this.credentials.modelsFetchedAt ?? 0);
    if (this.credentials.models && this.credentials.models.length > 0 && age < MODELS_TTL_MS) {
      return this.listModels();
    }
    try {
      return await this.refreshModels();
    } catch (err) {
      log.warn({ err: String(err) }, 'getModelsLazy: refresh failed — returning cached list (possibly empty)');
      return this.listModels();
    }
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
        writeFileAtomic(this.storePath, '{}', { mode: 0o600 });
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
