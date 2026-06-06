/**
 * @file auth/oauth-types.ts
 * @description OAuth 2.0 / SSO type definitions for SUDO-AI.
 *
 * Supports:
 * - Authorization Code flow with PKCE (for CLI/SPA apps)
 * - Client Credentials flow (for server-to-server)
 * - OpenID Connect (for enterprise SSO)
 * - Token refresh with proactive refresh before expiry
 * - Multi-provider OAuth configuration
 *
 * Competitive intelligence: Claude Code supports OAuth via claude.ai,
 * Bedrock, Vertex, XAA (enterprise SSO). This module closes the gap.
 */

// ---------------------------------------------------------------------------
// OAuth Provider Configuration
// ---------------------------------------------------------------------------

/** Supported OAuth grant types. */
export type OAuthGrantType =
  | 'authorization_code'   // Standard auth code flow
  | 'authorization_code_pkce'  // Auth code + PKCE (recommended for CLI)
  | 'client_credentials'   // Server-to-server
  | 'refresh_token';      // Token refresh

/** Supported OAuth response types. */
export type OAuthResponseType = 'code' | 'token';

/** Token endpoint authentication method. */
export type TokenAuthMethod =
  | 'client_secret_basic'    // Authorization header with client_id:client_secret
  | 'client_secret_post'     // In request body
  | 'client_secret_jwt'      // JWT assertion with client secret
  | 'private_key_jwt';       // JWT assertion with private key

/** Provider metadata for OpenID Connect discovery. */
export interface OIDCProviderMetadata {
  /** Issuer URL (e.g., 'https://accounts.google.com'). */
  issuer: string;
  /** Authorization endpoint. */
  authorization_endpoint: string;
  /** Token endpoint. */
  token_endpoint: string;
  /** User info endpoint. */
  userinfo_endpoint?: string;
  /** JWKS URI for token verification. */
  jwks_uri?: string;
  /** Registration endpoint. */
  registration_endpoint?: string;
  /** Supported scopes. */
  scopes_supported?: string[];
  /** Supported response types. */
  response_types_supported?: OAuthResponseType[];
  /** Supported grant types. */
  grant_types_supported?: OAuthGrantType[];
  /** Supported token auth methods. */
  token_endpoint_auth_methods_supported?: TokenAuthMethod[];
  /** Whether the provider supports PKCE. */
  code_challenge_methods_supported?: ('S256' | 'plain')[];
  /** Whether the provider supports refresh tokens. */
  refresh_token_supported?: boolean;
}

/** Configuration for an OAuth provider. */
export interface OAuthProviderConfig {
  /** Unique provider identifier (e.g., 'google', 'github', 'azure-ad'). */
  id: string;
  /** Human-readable provider name. */
  name: string;
  /** OAuth grant type. */
  grantType: OAuthGrantType;
  /** Client ID registered with the provider. */
  clientId: string;
  /** Client secret (not needed for PKCE flow). */
  clientSecret?: string;
  /** Authorization endpoint URL. */
  authorizationEndpoint: string;
  /** Token endpoint URL. */
  tokenEndpoint: string;
  /** User info endpoint URL. */
  userinfoEndpoint?: string;
  /** Token revocation endpoint URL. */
  revocationEndpoint?: string;
  /** JWKS URI for ID token verification. */
  jwksUri?: string;
  /** Scopes to request (space-separated). */
  scopes: string;
  /** Redirect URI (auto-detected if not provided). */
  redirectUri?: string;
  /** Token endpoint auth method. */
  tokenAuthMethod?: TokenAuthMethod;
  /** Whether PKCE is required (default: true for authorization_code). */
  pkceRequired?: boolean;
  /** Custom OAuth parameters to include in auth request. */
  extraAuthParams?: Record<string, string>;
  /** Custom headers for token request. */
  extraTokenHeaders?: Record<string, string>;
  /** Proactive refresh window in seconds (default: 300 = 5 minutes). */
  proactiveRefreshSec?: number;
  /** Token refresh retry count (default: 2). */
  refreshRetryCount?: number;
  /** Whether to use OIDC discovery endpoint. */
  useDiscovery?: boolean;
  /** Discovery URL (if useDiscovery is true). */
  discoveryUrl?: string;
  /** Whether this provider supports SSO. */
  ssoEnabled?: boolean;
  /** SSO domain restriction (e.g., 'company.com'). */
  ssoDomain?: string;
}

// ---------------------------------------------------------------------------
// OAuth Token State
// ---------------------------------------------------------------------------

/** OAuth token response from provider. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  /** Some providers return an expires_at timestamp directly. */
  expires_at?: number;
}

/** Stored OAuth session with token metadata. */
export interface OAuthSession {
  /** Unique session identifier. */
  id: string;
  /** Provider ID this session belongs to. */
  providerId: string;
  /** Access token (encrypted at rest). */
  accessToken: string;
  /** Refresh token (encrypted at rest, if provided). */
  refreshToken?: string;
  /** ID token (OIDC, if provided). */
  idToken?: string;
  /** Token type (usually 'Bearer'). */
  tokenType: string;
  /** Scopes granted. */
  scopes: string[];
  /** When the access token expires (Unix ms). */
  expiresAt: number;
  /** When the session was created. */
  createdAt: number;
  /** When the session was last refreshed. */
  lastRefreshedAt?: number;
  /** User info from OIDC provider. */
  userInfo?: OAuthUserInfo;
  /** PKCE verifier used during authorization (ephemeral). */
  pkceVerifier?: string;
  /** PKCE challenge used during authorization (ephemeral). */
  pkceChallenge?: string;
  /** State parameter for CSRF protection (ephemeral). */
  state?: string;
  /** Whether this session is currently active. */
  isActive: boolean;
}

/** User information from OIDC provider. */
export interface OAuthUserInfo {
  /** Subject identifier (unique per provider). */
  sub: string;
  /** User email. */
  email?: string;
  /** Email verified status. */
  email_verified?: boolean;
  /** Display name. */
  name?: string;
  /** Given name. */
  given_name?: string;
  /** Family name. */
  family_name?: string;
  /** Profile picture URL. */
  picture?: string;
  /** User's organization. */
  organization?: string;
  /** User's roles/groups. */
  roles?: string[];
  /** Custom claims from the provider. */
  customClaims?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OAuth Flow State
// ---------------------------------------------------------------------------

/** State for an in-progress OAuth authorization flow. */
export interface OAuthFlowState {
  /** Unique flow identifier. */
  id: string;
  /** Provider ID. */
  providerId: string;
  /** PKCE code verifier (generated for PKCE flow). */
  codeVerifier: string;
  /** PKCE code challenge (derived from verifier). */
  codeChallenge: string;
  /** CSRF state parameter. */
  state: string;
  /** Authorization URL to redirect user to. */
  authorizationUrl: string;
  /** When this flow was created. */
  createdAt: number;
  /** When this flow expires (default: 10 minutes). */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Auth Events
// ---------------------------------------------------------------------------

/** Events emitted by the auth system. */
export type AuthEvent =
  | { type: 'login'; providerId: string; userId: string; method: string }
  | { type: 'logout'; providerId: string; userId: string }
  | { type: 'refresh'; providerId: string; userId: string; success: boolean }
  | { type: 'token_expired'; providerId: string; userId: string }
  | { type: 'error'; providerId: string; error: string; code?: string };

// ---------------------------------------------------------------------------
// Auth Configuration
// ---------------------------------------------------------------------------

/** Top-level auth configuration. */
export interface AuthConfig {
  /** Enabled OAuth providers. */
  providers: OAuthProviderConfig[];
  /** Default provider ID for login. */
  defaultProvider?: string;
  /** Whether to auto-refresh tokens. */
  autoRefresh?: boolean;
  /** Proactive refresh window in seconds. */
  proactiveRefreshSec?: number;
  /** Vault namespace for storing tokens. */
  vaultNamespace?: string;
  /** HTTP port for OAuth redirect listener (default: auto-select). */
  redirectPort?: number;
  /** Timeout for OAuth flow completion (ms, default: 120000). */
  flowTimeoutMs?: number;
}

/** Result of a login operation. */
export interface LoginResult {
  success: boolean;
  providerId: string;
  userId?: string;
  accessToken?: string;
  error?: string;
  /** OAuth session that was created (if successful). */
  session?: OAuthSession;
}

/** Result of a logout operation. */
export interface LogoutResult {
  success: boolean;
  providerId: string;
  revokedTokens: number;
  error?: string;
}

/** Status of the auth system. */
export interface AuthStatus {
  /** Whether at least one session is active. */
  isAuthenticated: boolean;
  /** Active sessions by provider. */
  sessions: Array<{
    providerId: string;
    userId: string;
    expiresAt: number;
    scopes: string[];
    isExpiringSoon: boolean;
  }>;
  /** Available (configured) providers. */
  providers: Array<{
    id: string;
    name: string;
    ssoEnabled: boolean;
    ssoDomain?: string;
  }>;
}