/**
 * @file auth/oauth.ts
 * @description OAuth 2.0 / SSO Authentication Module for SUDO-AI.
 *
 * Implements:
 * - Authorization Code flow with PKCE (CLI/SPA)
 * - Client Credentials flow (server-to-server)
 * - OpenID Connect (enterprise SSO)
 * - Token refresh with proactive refresh 300s before expiry
 * - Multi-provider OAuth configuration
 * - Token storage in Vault (AES-256-GCM encrypted)
 * - CSRF protection via state parameter
 * - Auto-detection of redirect URI
 *
 * Competitive context: Claude Code supports OAuth (claude.ai), Bedrock, Vertex,
 * Mantle, Foundry, XAA (enterprise SSO). This module closes the auth gap.
 *
 * Usage:
 * ```ts
 * import { OAuthManager } from '../core/auth/oauth.js';
 *
 * const oauth = new OAuthManager({
 *   providers: [githubProvider, googleProvider],
 *   vaultNamespace: 'oauth',
 * });
 *
 * // Start login flow
 * const { url, codeVerifier, state } = await oauth.startLogin('github');
 * // ... redirect user to url ...
 * // User comes back with ?code=xxx&state=yyy
 * const session = await oauth.completeLogin('github', code, state, codeVerifier);
 *
 * // Get valid token (auto-refreshes if expiring soon)
 * const token = await oauth.getValidToken('github');
 * ```
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { createLogger } from '../shared/logger.js';
import type {
  AuthConfig,
  AuthEvent,
  AuthStatus,
  LoginResult,
  LogoutResult,
  OAuthFlowState,
  OAuthProviderConfig,
  OAuthSession,
  OAuthTokenResponse,
  OAuthUserInfo,
} from './oauth-types.js';
import { VaultError } from '../security/vault.js';

const log = createLogger('auth:oauth');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default proactive refresh window: refresh token 300s (5 min) before expiry. */
const DEFAULT_PROACTIVE_REFRESH_SEC = 300;

/** Default flow timeout: 10 minutes. */
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

/** Default vault namespace for OAuth tokens. */
const DEFAULT_VAULT_NAMESPACE = 'oauth';

/** PKCE code challenge method. */
const PKCE_CHALLENGE_METHOD = 'S256';

/** State parameter length. */
const STATE_LENGTH = 32;

/** Code verifier length (43-128 chars per RFC 7636). */
const CODE_VERIFIER_LENGTH = 64;

/** OAuth flow expiry: 10 minutes. */
const FLOW_EXPIRY_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// PKCE Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a PKCE code verifier (cryptographically random).
 * Per RFC 7636, must be 43-128 chars of [A-Z][a-z][0-9]-._~
 */
export function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(CODE_VERIFIER_LENGTH);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

/**
 * Generate PKCE code challenge from verifier using S256 method.
 * challenge = BASE64URL(SHA256(verifier))
 */
export function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return hash.toString('base64url');
}

/**
 * Generate a random state parameter for CSRF protection.
 */
export function generateState(): string {
  return crypto.randomBytes(STATE_LENGTH).toString('base64url');
}

// ---------------------------------------------------------------------------
// Token Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JWT token and return its claims (without verification).
 * For ID token inspection only — always verify signature in production.
 */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Extract user info from an OIDC ID token.
 */
export function extractUserInfo(idToken: string): OAuthUserInfo | null {
  const payload = parseJwtPayload(idToken);
  if (!payload) return null;

  return {
    sub: payload.sub as string ?? '',
    email: payload.email as string | undefined,
    email_verified: payload.email_verified as boolean | undefined,
    name: payload.name as string | undefined,
    given_name: payload.given_name as string | undefined,
    family_name: payload.family_name as string | undefined,
    picture: payload.picture as string | undefined,
    organization: payload.hd as string | undefined
      ?? payload.organization as string | undefined,
    roles: (payload.groups ?? payload.roles ?? []) as string[],
    customClaims: payload,
  };
}

// ---------------------------------------------------------------------------
// OAuth Manager
// ---------------------------------------------------------------------------

/**
 * Manages OAuth 2.0 authentication flows for SUDO-AI.
 *
 * Supports multiple providers (GitHub, Google, Azure AD, custom OIDC),
 * PKCE for CLI flows, automatic token refresh, and encrypted token storage.
 */
export class OAuthManager {
  private readonly providers: Map<string, OAuthProviderConfig> = new Map();
  private readonly sessions: Map<string, OAuthSession> = new Map();
  private readonly flows: Map<string, OAuthFlowState> = new Map();
  private readonly eventListeners: Array<(event: AuthEvent) => void> = [];
  private vaultNamespace: string;
  private autoRefresh: boolean;
  private proactiveRefreshSec: number;
  private redirectPort: number | undefined;
  private flowTimeoutMs: number;
  private refreshTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private vault?: { get: (ns: string, key: string, req: string) => Promise<{ value: string } | null>; set: (ns: string, key: string, value: string) => Promise<void>; delete: (ns: string, key: string, req: string) => Promise<void>; };
  private initialized = false;

  constructor(config: AuthConfig) {
    for (const provider of config.providers) {
      this.providers.set(provider.id, provider);
    }

    this.vaultNamespace = config.vaultNamespace ?? DEFAULT_VAULT_NAMESPACE;
    this.autoRefresh = config.autoRefresh ?? true;
    this.proactiveRefreshSec = config.proactiveRefreshSec ?? DEFAULT_PROACTIVE_REFRESH_SEC;
    this.redirectPort = config.redirectPort;
    this.flowTimeoutMs = config.flowTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;

    log.info({ providerCount: this.providers.size }, 'OAuthManager initialized');
  }

  /**
   * Inject Vault for encrypted token storage.
   * Must be called before any login operations.
   */
  public injectVault(vault: {
    get: (ns: string, key: string, req: string) => Promise<{ value: string } | null>;
    set: (ns: string, key: string, value: string) => Promise<void>;
    delete: (ns: string, key: string, req: string) => Promise<void>;
  }): void {
    this.vault = vault;
    log.info('Vault injected for encrypted OAuth token storage');
  }

  /**
   * Load persisted sessions from Vault.
   */
  public async loadSessions(): Promise<void> {
    if (!this.vault) {
      log.warn('No vault available — sessions will not persist');
      return;
    }

    for (const [providerId] of this.providers) {
      try {
        const result = await this.vault.get(this.vaultNamespace, `session:${providerId}`, 'oauth-manager');
        if (result?.value) {
          const session: OAuthSession = JSON.parse(result.value);
          // Only restore sessions that haven't expired
          if (session.expiresAt > Date.now()) {
            this.sessions.set(providerId, session);
            log.info({ providerId, userId: session.userInfo?.sub }, 'Restored OAuth session');
            // Schedule proactive refresh
            if (this.autoRefresh) {
              this.scheduleRefresh(providerId);
            }
          } else {
            log.info({ providerId }, 'Skipping expired session');
          }
        }
      } catch (err) {
        log.warn({ providerId, err }, 'Failed to load session from vault');
      }
    }

    this.initialized = true;
  }

  /**
   * Save a session to Vault (encrypted).
   */
  private async saveSession(providerId: string, session: OAuthSession): Promise<void> {
    if (!this.vault) return;

    try {
      await this.vault.set(
        this.vaultNamespace,
        `session:${providerId}`,
        JSON.stringify(session),
      );
    } catch (err) {
      log.error({ providerId, err }, 'Failed to save session to vault');
    }
  }

  /**
   * Delete a session from Vault.
   */
  private async deleteSession(providerId: string): Promise<void> {
    if (!this.vault) return;

    try {
      await this.vault.delete(this.vaultNamespace, `session:${providerId}`, 'oauth-manager');
    } catch (err) {
      log.warn({ providerId, err }, 'Failed to delete session from vault');
    }
  }

  // ---------------------------------------------------------------------------
  // Login Flow
  // ---------------------------------------------------------------------------

  /**
   * Start an OAuth login flow for a provider.
   * Returns the authorization URL and PKCE parameters.
   *
   * For CLI flows, redirect the user to the authorization URL.
   * For server flows, use the authorization URL in a redirect response.
   */
  public async startLogin(providerId: string): Promise<{
    authorizationUrl: string;
    codeVerifier: string;
    state: string;
  }> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    // Build authorization URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri ?? this.getDefaultRedirectUri(),
      scope: provider.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: PKCE_CHALLENGE_METHOD,
    });

    // Add extra params
    if (provider.extraAuthParams) {
      for (const [key, value] of Object.entries(provider.extraAuthParams)) {
        params.set(key, value);
      }
    }

    const authorizationUrl = `${provider.authorizationEndpoint}?${params.toString()}`;

    // Store flow state
    const flowState: OAuthFlowState = {
      id: crypto.randomUUID(),
      providerId,
      codeVerifier,
      codeChallenge,
      state,
      authorizationUrl,
      createdAt: Date.now(),
      expiresAt: Date.now() + FLOW_EXPIRY_MS,
    };
    this.flows.set(state, flowState);

    log.info({ providerId, state }, 'OAuth login flow started');

    return { authorizationUrl, codeVerifier, state };
  }

  /**
   * Complete an OAuth login flow by exchanging the authorization code.
   *
   * @param providerId - The provider ID.
   * @param code - The authorization code from the callback.
   * @param state - The state parameter from the callback (for CSRF validation).
   * @param codeVerifier - The PKCE code verifier from startLogin().
   */
  public async completeLogin(
    providerId: string,
    code: string,
    state: string,
    codeVerifier: string,
  ): Promise<LoginResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { success: false, providerId, error: `Unknown provider: ${providerId}` };
    }

    // Validate state parameter
    const flowState = this.flows.get(state);
    if (!flowState) {
      log.warn({ state }, 'Unknown OAuth state — possible CSRF attack');
      return { success: false, providerId, error: 'Invalid state parameter' };
    }

    if (flowState.providerId !== providerId) {
      log.warn({ state, expected: flowState.providerId, got: providerId }, 'Provider mismatch');
      return { success: false, providerId, error: 'Provider mismatch in state' };
    }

    if (flowState.expiresAt < Date.now()) {
      this.flows.delete(state);
      return { success: false, providerId, error: 'OAuth flow expired' };
    }

    // Exchange code for tokens
    try {
      const tokenResponse = await this.exchangeCode(provider, code, codeVerifier, flowState);
      const userInfo = tokenResponse.id_token
        ? extractUserInfo(tokenResponse.id_token)
        : undefined;

      // Calculate expiry time
      const expiresAt = tokenResponse.expires_at
        ? tokenResponse.expires_at * 1000
        : Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;

      // Create session
      const session: OAuthSession = {
        id: crypto.randomUUID(),
        providerId,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        idToken: tokenResponse.id_token,
        tokenType: tokenResponse.token_type ?? 'Bearer',
        scopes: (tokenResponse.scope ?? provider.scopes).split(' '),
        expiresAt,
        createdAt: Date.now(),
        userInfo: userInfo ?? undefined,
        isActive: true,
      };

      // Store session
      this.sessions.set(providerId, session);
      await this.saveSession(providerId, session);

      // Clean up flow state
      this.flows.delete(state);

      // Schedule proactive refresh
      if (this.autoRefresh && tokenResponse.refresh_token) {
        this.scheduleRefresh(providerId);
      }

      // Emit event
      this.emit({
        type: 'login',
        providerId,
        userId: userInfo?.sub ?? 'unknown',
        method: 'oauth',
      });

      log.info({
        providerId,
        userId: userInfo?.sub,
        scopes: session.scopes,
        expiresAt: new Date(expiresAt).toISOString(),
      }, 'OAuth login completed');

      return {
        success: true,
        providerId,
        userId: userInfo?.sub,
        accessToken: tokenResponse.access_token,
        session,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ providerId, error: errorMessage }, 'Token exchange failed');

      this.emit({
        type: 'error',
        providerId,
        error: errorMessage,
        code: 'token_exchange_failed',
      });

      return { success: false, providerId, error: errorMessage };
    }
  }

  // ---------------------------------------------------------------------------
  // Client Credentials Flow
  // ---------------------------------------------------------------------------

  /**
   * Authenticate using client credentials (server-to-server).
   * No user interaction required.
   */
  public async clientCredentialsLogin(providerId: string): Promise<LoginResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { success: false, providerId, error: `Unknown provider: ${providerId}` };
    }

    if (!provider.clientSecret) {
      return { success: false, providerId, error: 'Client secret required for client_credentials flow' };
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        scope: provider.scopes,
      });

      const response = await fetch(provider.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token endpoint returned ${response.status}: ${errorText}`);
      }

      const tokenResponse: OAuthTokenResponse = await response.json();
      const expiresAt = Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;

      const session: OAuthSession = {
        id: crypto.randomUUID(),
        providerId,
        accessToken: tokenResponse.access_token,
        tokenType: tokenResponse.token_type ?? 'Bearer',
        scopes: (tokenResponse.scope ?? provider.scopes).split(' '),
        expiresAt,
        createdAt: Date.now(),
        isActive: true,
      };

      this.sessions.set(providerId, session);
      await this.saveSession(providerId, session);

      if (this.autoRefresh) {
        this.scheduleRefresh(providerId);
      }

      this.emit({
        type: 'login',
        providerId,
        userId: 'client-credentials',
        method: 'client_credentials',
      });

      log.info({ providerId }, 'Client credentials login completed');

      return { success: true, providerId, session };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({ providerId, error: errorMessage }, 'Client credentials login failed');
      return { success: false, providerId, error: errorMessage };
    }
  }

  // ---------------------------------------------------------------------------
  // Token Exchange
  // ---------------------------------------------------------------------------

  /**
   * Exchange an authorization code for tokens.
   */
  private async exchangeCode(
    provider: OAuthProviderConfig,
    code: string,
    codeVerifier: string,
    flowState: OAuthFlowState,
  ): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: provider.redirectUri ?? this.getDefaultRedirectUri(),
      client_id: provider.clientId,
      code_verifier: codeVerifier,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    };

    if (provider.clientSecret) {
      headers['Authorization'] = `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64')}`;
    }

    if (provider.extraTokenHeaders) {
      Object.assign(headers, provider.extraTokenHeaders);
    }

    const response = await fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<OAuthTokenResponse>;
  }

  // ---------------------------------------------------------------------------
  // Token Refresh
  // ---------------------------------------------------------------------------

  /**
   * Get a valid access token, refreshing if necessary.
   * Returns null if no session exists or refresh fails.
   */
  public async getValidToken(providerId: string): Promise<string | null> {
    const session = this.sessions.get(providerId);
    if (!session || !session.isActive) return null;

    // Check if token is still valid
    const now = Date.now();
    const refreshWindow = (this.getProviderConfig(providerId)?.proactiveRefreshSec
      ?? DEFAULT_PROACTIVE_REFRESH_SEC) * 1000;

    if (session.expiresAt > now + refreshWindow) {
      // Token is still valid and not expiring soon
      return session.accessToken;
    }

    // Try to refresh
    if (session.refreshToken) {
      const refreshed = await this.refreshToken(providerId);
      if (refreshed) {
        return refreshed.accessToken;
      }
    }

    // Token is expired or about to expire and can't refresh
    if (session.expiresAt > now) {
      // Still technically valid, return it
      log.warn({ providerId }, 'Using nearly-expired token — refresh failed');
      return session.accessToken;
    }

    // Token is expired
    this.emit({ type: 'token_expired', providerId, userId: session.userInfo?.sub ?? 'unknown' });
    return null;
  }

  /**
   * Refresh an access token using the refresh token.
   */
  public async refreshToken(providerId: string): Promise<OAuthSession | null> {
    const session = this.sessions.get(providerId);
    if (!session?.refreshToken) return null;

    const provider = this.providers.get(providerId);
    if (!provider) return null;

    const maxRetries = provider.refreshRetryCount ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken,
          client_id: provider.clientId,
        });

        if (provider.clientSecret) {
          body.set('client_secret', provider.clientSecret);
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        };

        if (provider.extraTokenHeaders) {
          Object.assign(headers, provider.extraTokenHeaders);
        }

        const response = await fetch(provider.tokenEndpoint, {
          method: 'POST',
          headers,
          body: body.toString(),
        });

        if (!response.ok) {
          const errorText = await response.text();

          // If refresh token is invalid, clear the session
          if (response.status === 400 || response.status === 401) {
            log.warn({ providerId, status: response.status }, 'Refresh token invalid — clearing session');
            session.isActive = false;
            this.sessions.delete(providerId);
            await this.deleteSession(providerId);
            this.emit({ type: 'error', providerId, error: 'Refresh token invalid', code: 'invalid_grant' });
            return null;
          }

          throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
        }

        const tokenResponse: OAuthTokenResponse = await response.json();
        const expiresAt = tokenResponse.expires_at
          ? tokenResponse.expires_at * 1000
          : Date.now() + (tokenResponse.expires_in ?? 3600) * 1000;

        // Update session
        session.accessToken = tokenResponse.access_token;
        session.refreshToken = tokenResponse.refresh_token ?? session.refreshToken;
        session.idToken = tokenResponse.id_token ?? session.idToken;
        session.expiresAt = expiresAt;
        session.lastRefreshedAt = Date.now();
        session.scopes =
          typeof tokenResponse.scope === 'string'
            ? tokenResponse.scope.split(' ')
            : session.scopes;
        session.isActive = true;

        // Parse user info from new ID token if provided
        if (tokenResponse.id_token) {
          const newUserInfo = extractUserInfo(tokenResponse.id_token);
          if (newUserInfo) session.userInfo = newUserInfo;
        }

        this.sessions.set(providerId, session);
        await this.saveSession(providerId, session);

        // Reschedule proactive refresh
        if (this.autoRefresh) {
          this.scheduleRefresh(providerId);
        }

        this.emit({ type: 'refresh', providerId, userId: session.userInfo?.sub ?? 'unknown', success: true });

        log.info({
          providerId,
          userId: session.userInfo?.sub,
          expiresAt: new Date(expiresAt).toISOString(),
        }, 'Token refreshed successfully');

        return session;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn({ providerId, attempt, error: errorMessage }, 'Token refresh attempt failed');

        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s...
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    }

    this.emit({ type: 'refresh', providerId, userId: session.userInfo?.sub ?? 'unknown', success: false });
    return null;
  }

  /**
   * Schedule a proactive token refresh before the token expires.
   * Refreshes at (expiresAt - proactiveRefreshSec).
   */
  private scheduleRefresh(providerId: string): void {
    // Clear existing timer
    const existingTimer = this.refreshTimers.get(providerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const session = this.sessions.get(providerId);
    if (!session?.refreshToken) return;

    const provider = this.providers.get(providerId);
    const refreshSec = provider?.proactiveRefreshSec ?? this.proactiveRefreshSec;
    const refreshMs = refreshSec * 1000;

    // Calculate delay until we should refresh
    const now = Date.now();
    const refreshAt = session.expiresAt - refreshMs;
    const delay = Math.max(0, refreshAt - now);

    if (delay <= 0) {
      // Already past the refresh window — refresh now
      this.refreshToken(providerId).catch((err) => {
        log.warn({ providerId, err }, 'Proactive refresh failed');
      });
      return;
    }

    const timer = setTimeout(() => {
      this.refreshToken(providerId).catch((err) => {
        log.warn({ providerId, err }, 'Proactive refresh failed');
      });
    }, delay);

    this.refreshTimers.set(providerId, timer);

    log.debug({
      providerId,
      refreshIn: `${Math.round(delay / 1000)}s`,
      at: new Date(refreshAt).toISOString(),
    }, 'Scheduled proactive token refresh');
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /**
   * Log out of a provider, revoking tokens if possible.
   */
  public async logout(providerId: string): Promise<LogoutResult> {
    const session = this.sessions.get(providerId);
    const provider = this.providers.get(providerId);

    // Clear refresh timer
    const timer = this.refreshTimers.get(providerId);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(providerId);
    }

    let revokedTokens = 0;

    // Attempt token revocation
    if (session && provider?.revocationEndpoint) {
      try {
        const response = await fetch(provider.revocationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: session.accessToken,
            token_type_hint: 'access_token',
          }).toString(),
        });
        if (response.ok) {
          revokedTokens++;
        }
      } catch (err) {
        log.warn({ providerId, err }, 'Token revocation failed');
      }

      // Also try to revoke refresh token
      if (session.refreshToken) {
        try {
          const response = await fetch(provider.revocationEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: session.refreshToken,
              token_type_hint: 'refresh_token',
            }).toString(),
          });
          if (response.ok) {
            revokedTokens++;
          }
        } catch (err) {
          log.warn({ providerId, err }, 'Refresh token revocation failed');
        }
      }
    }

    // Remove session
    this.sessions.delete(providerId);
    await this.deleteSession(providerId);

    const userId = session?.userInfo?.sub ?? 'unknown';
    this.emit({ type: 'logout', providerId, userId });

    log.info({ providerId, userId }, 'Logged out');

    return {
      success: true,
      providerId,
      revokedTokens,
    };
  }

  // ---------------------------------------------------------------------------
  // Status & Inspection
  // ---------------------------------------------------------------------------

  /**
   * Get the current auth status.
   */
  public getStatus(): AuthStatus {
    const now = Date.now();
    const refreshWindowMs = this.proactiveRefreshSec * 1000;

    const activeSessions = Array.from(this.sessions.entries())
      .filter(([, s]) => s.isActive && s.expiresAt > now)
      .map(([providerId, session]) => ({
        providerId,
        userId: session.userInfo?.sub ?? 'unknown',
        expiresAt: session.expiresAt,
        scopes: session.scopes,
        isExpiringSoon: session.expiresAt < now + refreshWindowMs,
      }));

    return {
      isAuthenticated: activeSessions.length > 0,
      sessions: activeSessions,
      providers: Array.from(this.providers.values()).map((p) => ({
        id: p.id,
        name: p.name,
        ssoEnabled: p.ssoEnabled ?? false,
        ssoDomain: p.ssoDomain,
      })),
    };
  }

  /**
   * Get session for a provider.
   */
  public getSession(providerId: string): OAuthSession | null {
    return this.sessions.get(providerId) ?? null;
  }

  /**
   * Get all active sessions.
   */
  public getActiveSessions(): OAuthSession[] {
    const now = Date.now();
    return Array.from(this.sessions.values())
      .filter((s) => s.isActive && s.expiresAt > now);
  }

  /**
   * Get provider configuration.
   */
  public getProviderConfig(providerId: string): OAuthProviderConfig | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Get all configured provider IDs.
   */
  public getProviderIds(): string[] {
    return Array.from(this.providers.keys());
  }

  // ---------------------------------------------------------------------------
  // Callback Server
  // ---------------------------------------------------------------------------

  /**
   * Start a temporary HTTP server to receive the OAuth callback.
   * Returns the server instance — call server.close() when done.
   *
   * This is useful for CLI flows where we need to listen for the redirect.
   */
  public async startCallbackServer(
    port?: number,
  ): Promise<{ server: http.Server; redirectUri: string }> {
    const actualPort = port ?? this.redirectPort ?? 0; // 0 = random available port

    return new Promise((resolve, reject) => {
      const server = http.createServer();

      server.on('error', (err) => {
        reject(new Error(`Failed to start callback server: ${err instanceof Error ? err.message : String(err)}`));
      });

      server.listen(actualPort, () => {
        const address = server.address();
        const listeningPort = address && typeof address === 'object' ? address.port : actualPort;
        const redirectUri = `http://127.0.0.1:${listeningPort}/callback`;
        resolve({ server, redirectUri });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // OIDC Discovery
  // ---------------------------------------------------------------------------

  /**
   * Fetch OIDC provider metadata from a discovery endpoint.
   * Standard endpoint: /.well-known/openid-configuration
   */
  public async discoverProvider(
    issuerUrl: string,
    clientId: string,
    clientSecret?: string,
    scopes?: string,
  ): Promise<OAuthProviderConfig> {
    const discoveryUrl = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;

    const response = await fetch(discoveryUrl);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed (${response.status}): ${await response.text()}`);
    }

    const metadata = await response.json() as Record<string, unknown>;

    const config: OAuthProviderConfig = {
      id: new URL(issuerUrl).hostname.replace(/\./g, '-'),
      name: (metadata.name as string) ?? new URL(issuerUrl).hostname,
      grantType: 'authorization_code_pkce',
      clientId,
      clientSecret,
      authorizationEndpoint: metadata.authorization_endpoint as string,
      tokenEndpoint: metadata.token_endpoint as string,
      userinfoEndpoint: metadata.userinfo_endpoint as string | undefined,
      revocationEndpoint: metadata.revocation_endpoint as string | undefined,
      jwksUri: metadata.jwks_uri as string | undefined,
      scopes: scopes ?? (metadata.scopes_supported as string[] ?? ['openid', 'profile', 'email']).join(' '),
      pkceRequired: (metadata.code_challenge_methods_supported as string[] ?? []).includes('S256'),
      proactiveRefreshSec: DEFAULT_PROACTIVE_REFRESH_SEC,
      useDiscovery: true,
      discoveryUrl,
      ssoEnabled: true,
    };

    log.info({ issuer: issuerUrl, id: config.id }, 'OIDC provider discovered');
    return config;
  }

  // ---------------------------------------------------------------------------
  // Event System
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to auth events.
   */
  public onEvent(listener: (event: AuthEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /**
   * Emit an auth event.
   */
  private emit(event: AuthEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err }, 'Auth event listener error');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Clean up all refresh timers and flow states.
   * Call this on application shutdown.
   */
  public dispose(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.flows.clear();
    log.info('OAuthManager disposed');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the default redirect URI based on the callback server.
   */
  private getDefaultRedirectUri(): string {
    if (this.redirectPort) {
      return `http://127.0.0.1:${this.redirectPort}/callback`;
    }
    return 'http://localhost:8401/callback';
  }
}

// ---------------------------------------------------------------------------
// Pre-configured Provider Templates
// ---------------------------------------------------------------------------

/**
 * Pre-configured OAuth providers for common services.
 * These are templates — fill in clientId/clientSecret before use.
 */
export const OAuthProviders = {
  /** GitHub OAuth App configuration template. */
  github: (clientId: string, clientSecret?: string): OAuthProviderConfig => ({
    id: 'github',
    name: 'GitHub',
    grantType: 'authorization_code_pkce',
    clientId,
    clientSecret,
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    userinfoEndpoint: 'https://api.github.com/user',
    scopes: 'read:user user:email repo',
    pkceRequired: true,
    proactiveRefreshSec: 300,
  }),

  /** Google OAuth configuration template. */
  google: (clientId: string, clientSecret?: string): OAuthProviderConfig => ({
    id: 'google',
    name: 'Google',
    grantType: 'authorization_code_pkce',
    clientId,
    clientSecret,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    scopes: 'openid email profile',
    pkceRequired: true,
    proactiveRefreshSec: 300,
    useDiscovery: true,
    discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
    ssoEnabled: true,
  }),

  /** Azure AD / Microsoft identity configuration template. */
  azureAd: (clientId: string, clientSecret: string, tenantId: string): OAuthProviderConfig => ({
    id: 'azure-ad',
    name: 'Azure AD',
    grantType: 'authorization_code_pkce',
    clientId,
    clientSecret,
    authorizationEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    userinfoEndpoint: 'https://graph.microsoft.com/oidc/userinfo',
    scopes: 'openid email profile User.Read',
    pkceRequired: true,
    proactiveRefreshSec: 300,
    ssoEnabled: true,
    ssoDomain: tenantId,
  }),

  /** Generic OIDC provider — auto-discover from issuer URL. */
  oidc: async (
    issuerUrl: string,
    clientId: string,
    clientSecret?: string,
    scopes?: string,
  ): Promise<OAuthProviderConfig> => {
    const manager = new OAuthManager({ providers: [] });
    return manager.discoverProvider(issuerUrl, clientId, clientSecret, scopes);
  },
} as const;