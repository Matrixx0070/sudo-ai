/**
 * Unified gateway authentication + operator scopes (Slice A of the gateway
 * unification).
 *
 * Today every HTTP/WS surface hand-rolls its own `isAuthorised(req, tokenBuf)`
 * timing-safe bearer check against its own env var (GATEWAY_TOKEN in http-api /
 * admin-routes, WEB_CHAT_TOKEN in canvas-routes, GATEWAY_SECRET in ws-server, …)
 * and every one of them is OPEN when its secret is unset. This module collapses
 * that into one credential→scope resolver with an OpenClaw-style fail-closed rule
 * so an exposed (proxied / non-loopback) daemon with no secret is no longer open.
 *
 * Kill-switch: SUDO_GATEWAY_UNIFIED_AUTH=0 restores the exact legacy per-surface
 * semantics (open when the surface's secret is unset), for instant rollback.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { resolveEnvSecretBuffer } from '../secrets/secret-ref.js';

// ---------------------------------------------------------------------------
// Scopes (closed set — admin implies all)
// ---------------------------------------------------------------------------

export type OperatorScope =
  | 'operator.read'
  | 'operator.write'
  | 'operator.admin'
  | 'operator.chat';

export const ALL_OPERATOR_SCOPES: readonly OperatorScope[] = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.chat',
];

/** The credential a principal authenticated with (for logging/audit). */
export type GatewayCredential =
  | 'gateway-token'
  | 'gateway-secret'
  | 'web-chat-token'
  | 'loopback'
  | 'none';

export interface GatewayPrincipal {
  /** True when the request is authorised. */
  ok: boolean;
  /** Which credential authenticated (or 'none' when denied). */
  credential: GatewayCredential;
  /** Granted operator scopes. */
  scopes: OperatorScope[];
  /** True for full operator credentials (gateway token/secret, loopback). */
  isOwner: boolean;
  /** Human-readable decision reason (never contains secret material). */
  reason: string;
}

/** operator.admin satisfies every scope; otherwise exact membership. */
export function hasScope(
  principal: Pick<GatewayPrincipal, 'scopes'>,
  scope: OperatorScope,
): boolean {
  return principal.scopes.includes('operator.admin') || principal.scopes.includes(scope);
}

// Scope sets per credential.
const GATEWAY_TOKEN_SCOPES: OperatorScope[] = ['operator.admin'];
const GATEWAY_SECRET_SCOPES: OperatorScope[] = ['operator.admin'];
const WEB_CHAT_SCOPES: OperatorScope[] = ['operator.read', 'operator.chat'];
const LOOPBACK_SCOPES: OperatorScope[] = ['operator.admin'];

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

/** Unified auth is ON unless SUDO_GATEWAY_UNIFIED_AUTH=0. */
export function unifiedAuthEnabled(): boolean {
  return process.env['SUDO_GATEWAY_UNIFIED_AUTH'] !== '0';
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function envSecret(name: string): Buffer | null {
  // SecretRef seam: honours `<NAME>_REF` (a JSON SecretRef) when SUDO_SECRETS_REF
  // is on; otherwise identical to reading process.env[name]. See secrets/secret-ref.ts.
  return resolveEnvSecretBuffer(name);
}

function bearerOf(req: IncomingMessage): Buffer {
  const h = req.headers['authorization'];
  const s = typeof h === 'string' ? h.trim() : '';
  const m = /^Bearer\s+(.+)$/i.exec(s);
  return Buffer.from(m ? (m[1] ?? '') : '', 'utf8');
}

function timingMatch(candidate: Buffer, secret: Buffer): boolean {
  return candidate.length === secret.length && timingSafeEqual(candidate, secret);
}

/** IPv4/IPv6 loopback, tolerating the ::ffff: IPv4-mapped prefix. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || a === 'localhost' || a.startsWith('127.');
}

const FORWARD_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
] as const;

/** True when any proxy/forwarding header is present. */
export function hasForwardedHeaders(req: IncomingMessage): boolean {
  return FORWARD_HEADERS.some((h) => req.headers[h] !== undefined);
}

/**
 * OpenClaw-parity "local direct" rule: loopback remote address AND no forwarded
 * headers. A forwarded header makes loopback untrustworthy (the socket is the
 * proxy, not the real client), so it can never grant local trust.
 */
export function isLocalDirectRequest(req: IncomingMessage): boolean {
  if (hasForwardedHeaders(req)) return false;
  return isLoopbackAddress(req.socket?.remoteAddress);
}

// ---------------------------------------------------------------------------
// Authenticate
// ---------------------------------------------------------------------------

export interface AuthenticateOptions {
  /**
   * Which credentials this surface accepts, in priority order. Defaults to the
   * operator token plus the loopback dev convenience. Most surfaces also include
   * 'gateway-token' so one operator secret can authenticate everywhere while the
   * surface-specific token (web-chat/gateway-secret) keeps working.
   */
  accept?: GatewayCredential[];
  /**
   * Env var that drives LEGACY (kill-switch) behaviour for this surface — the
   * secret it used before unification (default GATEWAY_TOKEN). In legacy mode the
   * surface is open when this env is unset, matching the old per-surface code.
   */
  legacySecretEnv?: string;
  /**
   * Explicit secret for the 'gateway-token' credential — for dependency-injected
   * surfaces whose register() receives a pre-computed token buffer. undefined =
   * read env GATEWAY_TOKEN; null = no secret configured; Buffer = use it.
   */
  secretOverride?: Buffer | null;
  /** Which credential secretOverride applies to (default 'gateway-token'). */
  secretOverrideCredential?: GatewayCredential;
}

const DENY = (reason: string): GatewayPrincipal => ({
  ok: false,
  credential: 'none',
  scopes: [],
  isOwner: false,
  reason,
});

/**
 * Authenticate an HTTP/WS-upgrade request and resolve its operator scopes.
 *
 * Unified mode (default):
 *   1. presented bearer matches a configured, accepted credential → authorised
 *      with that credential's scopes;
 *   2. an accepted credential is configured but the bearer did not match → deny;
 *   3. no accepted credential is configured →
 *        - local-direct (loopback, no forwarded headers) → authorised (dev);
 *        - otherwise (proxied / non-loopback) → DENY (closes the open hole).
 *
 * Legacy mode (SUDO_GATEWAY_UNIFIED_AUTH=0): only the surface's legacy secret
 * (legacySecretEnv) is considered and the surface is open when it is unset.
 */
function authenticateCore(
  bearer: Buffer,
  req: IncomingMessage,
  accept: GatewayCredential[],
  legacySecretEnv: string,
  secretOverride: Buffer | null | undefined,
  secretOverrideCredential: GatewayCredential,
): GatewayPrincipal {
  // An injected secret (DI surfaces) overrides the env lookup for its credential.
  const resolveSecret = (cred: GatewayCredential, envName: string): Buffer | null =>
    secretOverride !== undefined && secretOverrideCredential === cred ? secretOverride : envSecret(envName);
  const gwTok = resolveSecret('gateway-token', 'GATEWAY_TOKEN');
  const gwSecret = resolveSecret('gateway-secret', 'GATEWAY_SECRET');
  const webTok = resolveSecret('web-chat-token', 'WEB_CHAT_TOKEN');
  if (!unifiedAuthEnabled()) {
    const tok = secretOverride !== undefined ? secretOverride : envSecret(legacySecretEnv);
    if (tok === null) {
      return {
        ok: true,
        credential: 'none',
        scopes: GATEWAY_TOKEN_SCOPES,
        isOwner: true,
        reason: `legacy-open (no ${legacySecretEnv})`,
      };
    }
    return timingMatch(bearer, tok)
      ? {
          ok: true,
          credential: 'gateway-token',
          scopes: GATEWAY_TOKEN_SCOPES,
          isOwner: true,
          reason: 'legacy-token',
        }
      : DENY('legacy-token-mismatch');
  }

  if (accept.includes('gateway-token')) {
    if (gwTok && timingMatch(bearer, gwTok)) {
      return { ok: true, credential: 'gateway-token', scopes: GATEWAY_TOKEN_SCOPES, isOwner: true, reason: 'gateway-token' };
    }
  }
  if (accept.includes('gateway-secret')) {
    const s = gwSecret;
    if (s && timingMatch(bearer, s)) {
      return { ok: true, credential: 'gateway-secret', scopes: GATEWAY_SECRET_SCOPES, isOwner: true, reason: 'gateway-secret' };
    }
  }
  if (accept.includes('web-chat-token')) {
    const s = webTok;
    if (s && timingMatch(bearer, s)) {
      return { ok: true, credential: 'web-chat-token', scopes: WEB_CHAT_SCOPES, isOwner: false, reason: 'web-chat-token' };
    }
  }

  const anyConfigured =
    (accept.includes('gateway-token') && gwTok !== null) ||
    (accept.includes('gateway-secret') && gwSecret !== null) ||
    (accept.includes('web-chat-token') && webTok !== null);

  if (anyConfigured) {
    return DENY('bearer-required');
  }

  if (accept.includes('loopback') && isLocalDirectRequest(req)) {
    return {
      ok: true,
      credential: 'loopback',
      scopes: LOOPBACK_SCOPES,
      isOwner: true,
      reason: 'loopback-direct (no secret configured)',
    };
  }

  return DENY('no-secret-and-not-local');
}

/** Authenticate using the Authorization: Bearer header. */
export function authenticateHttp(req: IncomingMessage, opts: AuthenticateOptions = {}): GatewayPrincipal {
  return authenticateCore(
    bearerOf(req),
    req,
    opts.accept ?? ['gateway-token', 'loopback'],
    opts.legacySecretEnv ?? 'GATEWAY_TOKEN',
    opts.secretOverride,
    opts.secretOverrideCredential ?? 'gateway-token',
  );
}

/** Authenticate using a token supplied out-of-band (e.g. a WS ?token= query param). */
export function authenticateToken(
  token: string | null | undefined,
  req: IncomingMessage,
  opts: AuthenticateOptions = {},
): GatewayPrincipal {
  return authenticateCore(
    Buffer.from(token ?? '', 'utf8'),
    req,
    opts.accept ?? ['gateway-token', 'loopback'],
    opts.legacySecretEnv ?? 'GATEWAY_TOKEN',
    opts.secretOverride,
    opts.secretOverrideCredential ?? 'gateway-token',
  );
}
