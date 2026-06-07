/**
 * @file tools/mcp-oauth.ts
 * @description OAuth 2.1 PKCE client for MCP server authentication.
 *
 * Implements RFC 7636 PKCE (Proof Key for Code Exchange) for secure
 * authorization code flow without client secrets.
 */

import { randomBytes, createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('tools:mcp-oauth');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  /** Authorization server issuer URL */
  issuer: string;
  /** Client identifier */
  clientId: string;
  /** Redirect URI for authorization callback */
  redirectUri: string;
  /** Optional client secret (PKCE doesn't require it, but some servers do) */
  clientSecret?: string;
  /** Optional scope to request */
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface AuthorizationUrls {
  authorizationUrl: string;
  codeVerifier: string;
  state: string;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** Generate a cryptographically secure random code verifier (43-128 chars) */
function generateCodeVerifier(): string {
  const bytes = randomBytes(32);
  return bytes
    .toString('base64url')
    .slice(0, 128);
}

/** Generate SHA256 code challenge from verifier */
export function generateCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier).digest('base64url');
  return hash;
}

/** Generate a random state parameter for CSRF protection */
function generateState(): string {
  return randomBytes(16).toString('base64url');
}

// ---------------------------------------------------------------------------
// OAuthClient
// ---------------------------------------------------------------------------

export class OAuthClient {
  private config: OAuthConfig;
  private tokenCache: TokenResponse | null = null;
  /** Epoch ms when the cached token was issued; used to compute expiry. */
  private tokenIssuedAt: number | null = null;
  private pendingRefresh: Promise<TokenResponse> | null = null;

  constructor(config: OAuthConfig) {
    if (!config.issuer || !config.clientId || !config.redirectUri) {
      throw new Error('OAuthClient: issuer, clientId, and redirectUri are required');
    }
    this.config = config;
  }

  /**
   * Generate authorization URL with PKCE parameters.
   * Store the codeVerifier and state for later verification.
   */
  generateAuthorizationUrl(): AuthorizationUrls {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    if (this.config.scope) {
      params.set('scope', this.config.scope);
    }

    // Discover authorization endpoint from issuer
    const authEndpoint = `${this.config.issuer}/oauth/authorize`;
    const authorizationUrl = `${authEndpoint}?${params.toString()}`;

    log.debug(
      { clientId: this.config.clientId, state },
      'Generated OAuth authorization URL',
    );

    return { authorizationUrl, codeVerifier, state };
  }

  /**
   * Exchange authorization code for tokens.
   * @param code - The authorization code from the callback
   * @param codeVerifier - The original code verifier
   * @param state - The state parameter to verify
   * @param expectedState - The expected state value for CSRF protection
   */
  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    state: string,
    expectedState: string,
  ): Promise<TokenResponse> {
    if (state !== expectedState) {
      throw new Error('OAuthClient: state mismatch - possible CSRF attack');
    }

    const tokenEndpoint = `${this.config.issuer}/oauth/token`;

    log.debug({ clientId: this.config.clientId }, 'Exchanging authorization code for token');

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: codeVerifier,
        ...(this.config.clientSecret && { client_secret: this.config.clientSecret }),
      }).toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown');
      log.error(
        { status: response.status, body: errorBody },
        'OAuth token exchange failed',
      );
      throw new Error(`OAuth token exchange failed: HTTP ${response.status}`);
    }

    const data = await response.json() as TokenResponse;

    if (!data.access_token) {
      throw new Error('OAuthClient: no access_token in response');
    }

    this.tokenCache = {
      ...data,
      expires_in: data.expires_in
        ? Math.max(0, data.expires_in - 60) // Refresh 60s early
        : undefined,
    };
    this.tokenIssuedAt = Date.now();

    log.info(
      { clientId: this.config.clientId, expiresIn: data.expires_in },
      'OAuth token obtained successfully',
    );

    return data;
  }

  /**
   * Refresh an expired access token.
   * @param refreshToken - The refresh token from the original response
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    // Deduplicate concurrent refresh attempts
    if (this.pendingRefresh) {
      return this.pendingRefresh;
    }

    this.pendingRefresh = this._doRefresh(refreshToken);

    try {
      const result = await this.pendingRefresh;
      return result;
    } finally {
      this.pendingRefresh = null;
    }
  }

  private async _doRefresh(refreshToken: string): Promise<TokenResponse> {
    const tokenEndpoint = `${this.config.issuer}/oauth/token`;

    log.debug({ clientId: this.config.clientId }, 'Refreshing OAuth token');

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(this.config.clientSecret && { client_secret: this.config.clientSecret }),
      }).toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown');
      log.error(
        { status: response.status, body: errorBody },
        'OAuth token refresh failed',
      );
      throw new Error(`OAuth token refresh failed: HTTP ${response.status}`);
    }

    const data = await response.json() as TokenResponse;

    if (!data.access_token) {
      throw new Error('OAuthClient: no access_token in refresh response');
    }

    this.tokenCache = {
      ...data,
      expires_in: data.expires_in
        ? Math.max(0, data.expires_in - 60)
        : undefined,
    };
    this.tokenIssuedAt = Date.now();

    log.info(
      { clientId: this.config.clientId, expiresIn: data.expires_in },
      'OAuth token refreshed successfully',
    );

    return data;
  }

  /**
   * Get a valid access token, refreshing if necessary.
   * @param forceRefresh - Force a token refresh even if not expired
   */
  async getAccessToken(forceRefresh = false): Promise<string | null> {
    // Check kill-switch
    if (process.env['SUDO_MCP_OAUTH_DISABLE'] === '1') {
      log.debug('OAuth disabled via SUDO_MCP_OAUTH_DISABLE');
      return null;
    }

    if (!this.tokenCache) {
      // No cached token - caller needs to go through authorization flow
      return null;
    }

    // Only refresh when explicitly forced or the cached token is expired.
    // Refreshing a still-valid token wastes a network round-trip and, with
    // one-time-use (rotated) refresh tokens, would invalidate the stored
    // refresh_token and break subsequent calls.
    if ((forceRefresh || this.isTokenExpired()) && this.tokenCache.refresh_token) {
      try {
        const refreshed = await this.refreshToken(this.tokenCache.refresh_token);
        return refreshed.access_token;
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Token refresh failed');
        this.tokenCache = null;
        this.tokenIssuedAt = null;
        return null;
      }
    }

    return this.tokenCache.access_token;
  }

  /** Check if we have a valid (non-expired) access token */
  hasValidToken(): boolean {
    return this.tokenCache !== null && !this.isTokenExpired();
  }

  /** Check if the cached token is expired */
  isTokenExpired(): boolean {
    if (!this.tokenCache) return true;
    // If no expires_in, assume token is valid until refresh fails
    if (!this.tokenCache.expires_in || this.tokenIssuedAt === null) return false;
    const expiresAtMs = this.tokenIssuedAt + this.tokenCache.expires_in * 1000;
    return Date.now() >= expiresAtMs;
  }

  /** Clear the token cache (logout) */
  clearCache(): void {
    this.tokenCache = null;
    this.tokenIssuedAt = null;
    log.debug({ clientId: this.config.clientId }, 'OAuth token cache cleared');
  }

  /** Get current token info (for debugging/admin) */
  getTokenInfo(): { hasToken: boolean; expiresIn?: number; scope?: string } | null {
    if (!this.tokenCache) return null;
    return {
      hasToken: true,
      expiresIn: this.tokenCache.expires_in,
      scope: this.tokenCache.scope,
    };
  }
}

/**
 * Create an OAuth client from a discovery document.
 * @param issuerUrl - The OAuth issuer URL (e.g., https://auth.example.com)
 * @param clientId - Client identifier
 * @param redirectUri - Redirect URI for callbacks
 */
export async function createOAuthClientFromDiscovery(
  issuerUrl: string,
  clientId: string,
  redirectUri: string,
): Promise<OAuthClient> {
  const discoveryUrl = `${issuerUrl}/.well-known/oauth-authorization-server`;

  log.debug({ issuerUrl }, 'Fetching OAuth discovery document');

  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`OAuth discovery failed: HTTP ${response.status}`);
  }

  const config = await response.json() as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    code_challenge_methods_supported?: string[];
  };

  // Verify PKCE support
  const pkceMethods = config.code_challenge_methods_supported || [];
  if (!pkceMethods.includes('S256')) {
    log.warn(
      { issuer: config.issuer, methods: pkceMethods },
      'OAuth server may not support PKCE S256',
    );
  }

  return new OAuthClient({
    issuer: config.issuer || issuerUrl,
    clientId,
    redirectUri,
  });
}
