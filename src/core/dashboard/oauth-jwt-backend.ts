/**
 * @file src/core/dashboard/oauth-jwt-backend.ts
 * @description OAuth/JWT `AuthBackend` implementations — slice 4 of gap #28b.
 *
 * Hermes parity: `plugins/dashboard_auth/{nous,self_hosted}/` accept a Bearer
 * JWT in `Authorization: Bearer <token>` and verify it against a configured
 * issuer + audience + signing key. This module implements the same contract
 * using `node:crypto` (no new deps) so the dashboard can sit behind an
 * existing OIDC provider — Nous's identity service for `nous`, or any
 * generic IdP (Keycloak, Auth0, Authentik, ...) for `self-hosted`.
 *
 * **What is verified (RFC 7519 §4.1):**
 *   - Header alg matches `expectedAlg` (HS256 or RS256). No `alg: none` ever.
 *   - Signature verifies against the configured key.
 *   - `iss` matches `expectedIssuer` exactly when configured.
 *   - `aud` includes `expectedAudience` (string or array) when configured.
 *   - `exp` > now − clockSkewSec (default 60s).
 *   - `nbf` ≤ now + clockSkewSec when present.
 *   - `sub` is present and a non-empty string.
 *   - Optional `requiredScope` is present in the space-separated `scope` claim
 *     OR the `scp` array claim (matches Auth0/Okta + IdentityServer shapes).
 *
 * **What is NOT in this slice:**
 *   - JWKS-URL auto-fetch + rotation: operator pins a static PEM (RS256) or
 *     HS256 shared secret via env. Adding JWKS-fetch is a follow-up that
 *     needs a fetch/cache layer and is independently testable.
 *   - OAuth code/authorization-code flow: this backend consumes Bearer JWTs
 *     ONLY. Issuance happens upstream (any standard IdP) — the dashboard
 *     never sees user credentials.
 *
 * **Audit/principal:** successful auth returns `principal =
 * "dashboard:oauth:<sub>"`. `actorFor` in dashboard-routes.ts wraps that with
 * the remote IP so the audit chain records who did what.
 *
 * **`?token=` fallback is INTENTIONALLY DISABLED** — JWTs are bearer tokens
 * with non-trivial lifetimes; surfacing them in URLs leaks into access logs,
 * referrers, browser history. Bearer-header only.
 */

import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import type { AuthBackend, AuthResult } from './dashboard-types.js';

/**
 * Supported algorithms in this slice. The header `alg` claim is strict-
 * checked against this value; we explicitly reject `none` and any algorithm
 * we did not opt into (defends against algorithm-confusion attacks like
 * the well-known HS256/RS256 mix where a public key gets used as an HMAC
 * secret).
 */
export type JwtAlg = 'HS256' | 'RS256';

/** Decoded JWT segments after base64url decoding (still strings). */
interface DecodedJwtParts {
  headerJson: string;
  payloadJson: string;
  signingInput: string;
  signature: Buffer;
}

/** Parsed JWT header — only the fields we read. */
interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

/** Parsed JWT payload — only the standard claims we read. */
interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  scope?: string;
  scp?: string[];
  // Free-form passthrough — extra IdP-specific claims are tolerated.
  [k: string]: unknown;
}

/** Configuration for `createOAuthJwtBackend`. */
export interface OAuthJwtBackendOptions {
  /** Stable backend name surfaced in audit + logs (e.g. `oauth-nous`). */
  name: string;
  /** Signing algorithm. The token's header alg MUST match exactly. */
  algorithm: JwtAlg;
  /** HS256 shared secret. Required when `algorithm === 'HS256'`. */
  hmacSecret?: string;
  /**
   * RS256 verification key (PEM). Required when `algorithm === 'RS256'`.
   * Accepted as a PEM string — caller is expected to read the file at
   * startup and pass the contents (operator-supplied file paths handled
   * in cli.ts wiring).
   */
  publicKeyPem?: string;
  /**
   * Expected `iss` claim. When set, the token's `iss` must match exactly.
   * Strongly recommended — without it, a leaked-and-replayed token from
   * any IdP that signs with the same key could authenticate.
   */
  expectedIssuer?: string;
  /**
   * Expected `aud` claim. When set, the token's `aud` (string OR array)
   * must contain this value. Strongly recommended — same reason as iss.
   */
  expectedAudience?: string;
  /**
   * Optional scope/role check. When set, the token must declare this
   * value in either `scope` (space-separated string, OAuth 2.0 §3.3) or
   * `scp` (array claim, IdentityServer/Auth0 convention).
   */
  requiredScope?: string;
  /**
   * Allowed clock-skew window (seconds) for `exp` / `nbf` checks. Default 60s.
   * NTP drift, container clock jitter, signer/verifier mismatch — small skew
   * is normal; a token that just expired one second ago is still accepted.
   */
  clockSkewSec?: number;
  /**
   * Allow `iat` (issued-at) sanity check. When `true`, tokens with
   * `iat > now + clockSkewSec` are rejected (clock-skew + future-dated).
   * Defaults to `true` because future-dated tokens are a strong sign of
   * a misconfigured IdP or a forged token.
   */
  rejectFutureIat?: boolean;
  /**
   * Optional principal-prefix override. Defaults to `'dashboard:oauth'`.
   * Nous/self-hosted presets pass `'dashboard:oauth-nous'` /
   * `'dashboard:oauth-self-hosted'` so audit lines disambiguate IdPs.
   */
  principalPrefix?: string;
  /**
   * Time source for tests. Defaults to `() => Math.floor(Date.now() / 1000)`.
   * Tests inject a fixed clock so exp/nbf assertions are deterministic.
   */
  now?: () => number;
}

/**
 * Hermes `nous` parity preset — JWT-verifying backend pre-configured for
 * Nous Research's identity service. The operator still must supply a
 * signing key (RS256 PEM via `SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM` or
 * HS256 secret via `SUDO_DASHBOARD_OAUTH_HMAC_SECRET`) because Nous's
 * public key is not bundled with sudo-ai and any default would be
 * wrong-or-stale a month after release. Defaults: RS256, issuer
 * `https://auth.nousresearch.com`, audience `sudo-ai-dashboard`.
 */
export function createNousAuthBackend(opts: Partial<OAuthJwtBackendOptions> & {
  publicKeyPem?: string;
  hmacSecret?: string;
}): AuthBackend {
  return createOAuthJwtBackend({
    name: 'oauth-nous',
    algorithm: opts.algorithm ?? 'RS256',
    expectedIssuer: opts.expectedIssuer ?? 'https://auth.nousresearch.com',
    expectedAudience: opts.expectedAudience ?? 'sudo-ai-dashboard',
    principalPrefix: 'dashboard:oauth-nous',
    ...opts,
  });
}

/**
 * Hermes `self_hosted` parity preset — same JWT-verifying core, but the
 * operator MUST supply issuer + audience explicitly (no defaults), because
 * a self-hosted IdP can be anywhere and there is no sensible fallback.
 * Refuses construction with `Error` if `expectedIssuer` is missing, because
 * an OAuth backend without issuer validation accepts any token signed by
 * the configured key — a known footgun.
 */
export function createSelfHostedAuthBackend(opts: Partial<OAuthJwtBackendOptions> & {
  expectedIssuer: string; // hard-required to prevent the no-iss footgun
}): AuthBackend {
  if (typeof opts.expectedIssuer !== 'string' || opts.expectedIssuer.length === 0) {
    throw new Error('createSelfHostedAuthBackend: expectedIssuer is required');
  }
  return createOAuthJwtBackend({
    name: 'oauth-self-hosted',
    algorithm: opts.algorithm ?? 'RS256',
    principalPrefix: 'dashboard:oauth-self-hosted',
    ...opts,
  });
}

/**
 * Construct a JWT-verifying `AuthBackend`. Both Nous and self-hosted
 * presets reduce to this factory.
 *
 * Validates the option shape eagerly so a misconfigured backend fails at
 * boot rather than at first request (operators see the error in logs
 * immediately instead of a stream of 401s).
 */
export function createOAuthJwtBackend(opts: OAuthJwtBackendOptions): AuthBackend {
  if (opts.algorithm === 'HS256') {
    if (typeof opts.hmacSecret !== 'string' || opts.hmacSecret.length === 0) {
      throw new Error('createOAuthJwtBackend: HS256 requires non-empty hmacSecret');
    }
  } else if (opts.algorithm === 'RS256') {
    if (typeof opts.publicKeyPem !== 'string' || opts.publicKeyPem.length === 0) {
      throw new Error('createOAuthJwtBackend: RS256 requires non-empty publicKeyPem');
    }
  } else {
    throw new Error(`createOAuthJwtBackend: unsupported algorithm "${String(opts.algorithm)}"`);
  }

  // Pre-construct the public key once so the per-request cost is just a
  // `crypto.verify` call. `createPublicKey` accepts PEM directly.
  let publicKey: KeyObject | undefined;
  if (opts.algorithm === 'RS256') {
    try {
      publicKey = createPublicKey(opts.publicKeyPem!);
    } catch (err: unknown) {
      throw new Error(
        `createOAuthJwtBackend: failed to parse RS256 public key — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const clockSkewSec = opts.clockSkewSec ?? 60;
  const rejectFutureIat = opts.rejectFutureIat ?? true;
  const principalPrefix = opts.principalPrefix ?? 'dashboard:oauth';

  return {
    name: opts.name,
    async authenticate(req, _opts): Promise<AuthResult> {
      // ?token= fallback is intentionally disabled — see file-header comment.
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) {
        return { ok: false, reason: 'missing_bearer_token' };
      }
      const token = auth.slice(7).trim();
      if (token.length === 0) return { ok: false, reason: 'empty_bearer_token' };

      // Parse + verify in a single try so any throw (malformed base64,
      // bad JSON, broken signature) collapses to a single denial — the
      // route dispatcher logs the reason at debug level.
      let parts: DecodedJwtParts;
      let header: JwtHeader;
      let payload: JwtPayload;
      try {
        parts = decodeJwt(token);
        header = JSON.parse(parts.headerJson) as JwtHeader;
        payload = JSON.parse(parts.payloadJson) as JwtPayload;
      } catch {
        return { ok: false, reason: 'malformed_jwt' };
      }

      // Strict alg check — defends against alg-confusion (HS256 forged
      // with an RS256 public key as the HMAC secret) and `alg: none`.
      if (header.alg !== opts.algorithm) {
        return { ok: false, reason: 'alg_mismatch' };
      }

      // Verify signature.
      let sigOk: boolean;
      try {
        if (opts.algorithm === 'HS256') {
          sigOk = verifyHs256(parts.signingInput, parts.signature, opts.hmacSecret!);
        } else {
          sigOk = verifyRs256(parts.signingInput, parts.signature, publicKey!);
        }
      } catch {
        return { ok: false, reason: 'signature_error' };
      }
      if (!sigOk) return { ok: false, reason: 'bad_signature' };

      // Claim checks.
      const nowSec = now();

      if (opts.expectedIssuer !== undefined && payload.iss !== opts.expectedIssuer) {
        return { ok: false, reason: 'iss_mismatch' };
      }

      if (opts.expectedAudience !== undefined) {
        const aud = payload.aud;
        const audMatch = Array.isArray(aud)
          ? aud.includes(opts.expectedAudience)
          : aud === opts.expectedAudience;
        if (!audMatch) return { ok: false, reason: 'aud_mismatch' };
      }

      if (typeof payload.exp !== 'number') {
        // RFC 7519 §4.1.4 makes `exp` optional, but for an admin surface
        // we require it — non-expiring tokens for a panel that can restart
        // the daemon is a known footgun.
        return { ok: false, reason: 'exp_missing' };
      }
      if (nowSec > payload.exp + clockSkewSec) {
        return { ok: false, reason: 'expired' };
      }

      if (typeof payload.nbf === 'number' && nowSec + clockSkewSec < payload.nbf) {
        return { ok: false, reason: 'not_yet_valid' };
      }

      if (rejectFutureIat && typeof payload.iat === 'number' && payload.iat > nowSec + clockSkewSec) {
        return { ok: false, reason: 'iat_in_future' };
      }

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        return { ok: false, reason: 'sub_missing' };
      }

      if (opts.requiredScope !== undefined) {
        const scopeStr = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : [];
        const scpArr = Array.isArray(payload.scp) ? payload.scp : [];
        const hasScope = scopeStr.includes(opts.requiredScope) || scpArr.includes(opts.requiredScope);
        if (!hasScope) return { ok: false, reason: 'scope_missing' };
      }

      return { ok: true, principal: `${principalPrefix}:${payload.sub}` };
    },
  };
}

/**
 * Split + decode a JWT into header/payload/signature segments. Throws on
 * malformed input — callers catch.
 *
 * NOTE: this does NOT verify the signature; that happens in the caller so
 * the alg field can be inspected first (header is needed before we know
 * which verifier to run).
 */
function decodeJwt(token: string): DecodedJwtParts {
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error('jwt_not_three_segments');
  const [h, p, s] = segments;
  if (h.length === 0 || p.length === 0 || s.length === 0) {
    throw new Error('jwt_empty_segment');
  }
  const headerJson = base64UrlDecodeUtf8(h);
  const payloadJson = base64UrlDecodeUtf8(p);
  const signature = base64UrlDecodeBuf(s);
  return { headerJson, payloadJson, signingInput: `${h}.${p}`, signature };
}

function base64UrlDecodeUtf8(s: string): string {
  return base64UrlDecodeBuf(s).toString('utf8');
}

function base64UrlDecodeBuf(s: string): Buffer {
  // base64url → base64, then pad to a multiple of 4.
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + '='.repeat(padLen), 'base64');
}

function verifyHs256(signingInput: string, signature: Buffer, secret: string): boolean {
  const mac = createHmac('sha256', secret).update(signingInput).digest();
  return timingSafeEqualBuf(mac, signature);
}

function verifyRs256(signingInput: string, signature: Buffer, publicKey: KeyObject): boolean {
  // `crypto.verify(algorithm, data, key, signature)` — RSASSA-PKCS1-v1_5
  // is what JWT RS256 specifies (NOT RSASSA-PSS).
  return verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), publicKey, signature);
}

/**
 * Constant-time buffer compare. `crypto.timingSafeEqual` throws on length
 * mismatch (its docs explicitly say so), and an attacker could otherwise
 * use a wrong-length signature to distinguish "couldn't even compare" from
 * "compared and didn't match" via timing. Wrap to make length mismatch
 * just return false in constant time.
 */
function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
