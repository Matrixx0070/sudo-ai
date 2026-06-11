/**
 * @file auth/index.ts
 * @description Authentication module — OAuth 2.0 / SSO.
 *
 * Exports:
 * - OAuthManager: OAuth 2.0 / OIDC / SSO authentication
 * - All auth types
 *
 * Usage:
 * ```ts
 * import { OAuthManager, OAuthProviders } from '../core/auth/index.js';
 *
 * const oauth = new OAuthManager({
 *   providers: [OAuthProviders.github('<your-github-oauth-client-id>')],
 *   autoRefresh: true,
 * });
 * oauth.injectVault(vault);
 * const { url, codeVerifier, state } = await oauth.startLogin('github');
 * ```
 */

// OAuth 2.0 / SSO
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
} from './oauth-types.js';
export type { VaultSetOptions } from '../security/vault.js';