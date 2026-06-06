/**
 * @file auth/index.ts
 * @description Authentication module — credential pooling + OAuth 2.0 / SSO.
 *
 * Exports:
 * - CredentialPool: Multi-key credential rotation
 * - OAuthManager: OAuth 2.0 / OIDC / SSO authentication
 * - All auth types
 *
 * Usage:
 * ```ts
 * import { CredentialPool, OAuthManager, OAuthProviders } from '../core/auth/index.js';
 *
 * // Credential pooling (API keys)
 * const pool = CredentialPool.getInstance();
 * pool.loadFromEnv('openai');
 * const cred = pool.selectCredential('openai');
 *
 * // OAuth 2.0 (user authentication)
 * const oauth = new OAuthManager({
 *   providers: [OAuthProviders.github(process.env.GITHUB_CLIENT_ID!)],
 *   autoRefresh: true,
 * });
 * oauth.injectVault(vault);
 * const { url, codeVerifier, state } = await oauth.startLogin('github');
 * ```
 */

// Credential Pool (existing)
export { CredentialPool, credentialPool } from './credential-pool.js';
export type {
  CredentialEntry,
  CredentialPoolConfig,
  SelectionStrategy,
  PoolStatus,
  AddCredentialRequest,
  SetStrategyRequest,
} from './credential-pool-types.js';

// OAuth 2.0 / SSO (new)
export { OAuthManager, OAuthProviders } from './oauth.js';
export {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  parseJwtPayload,
  extractUserInfo,
} from './oauth.js';
export type {
  OAuthGrantType,
  OAuthResponseType,
  TokenAuthMethod,
  OIDCProviderMetadata,
  OAuthProviderConfig,
  OAuthTokenResponse,
  OAuthSession,
  OAuthUserInfo,
  OAuthFlowState,
  AuthEvent,
  AuthConfig,
  LoginResult,
  LogoutResult,
  AuthStatus,
  VaultSetOptions,
} from './oauth-types.js';