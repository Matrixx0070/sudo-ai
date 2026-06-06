/**
 * @file bridge-auth.ts
 * @description JWT issuance and validation for the IDE Bridge protocol.
 *
 * Uses HMAC-SHA256 with a key derived from GATEWAY_TOKEN + '/bridge-jwt-key'
 * for per-session JWT authentication. Initial WebSocket upgrade is authenticated
 * via GATEWAY_TOKEN query parameter (timing-safe comparison).
 *
 * @module ide-bridge-auth
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('ide:bridge-auth');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default JWT TTL: 1 hour. */
const DEFAULT_JWT_TTL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// JWT Claims
// ---------------------------------------------------------------------------

interface BridgeJwtClaims {
  /** Subject — session ID. */
  sub: string;
  /** Issuer. */
  iss: string;
  /** Issued at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  /** Server epoch at time of issue. */
  epoch: number;
}

// ---------------------------------------------------------------------------
// Key Derivation
// ---------------------------------------------------------------------------

/**
 * Derive an HMAC-SHA256 signing key from the gateway token.
 * The key is `GATEWAY_TOKEN + '/bridge-jwt-key'` hashed with SHA-256.
 * This ensures the JWT key is deterministic across restarts but not
 * directly equal to the gateway token.
 */
function deriveSigningKey(gatewayToken: string): Buffer {
  return crypto.createHash('sha256')
    .update(gatewayToken + '/bridge-jwt-key')
    .digest();
}

// ---------------------------------------------------------------------------
// JWT Issuance
// ---------------------------------------------------------------------------

/**
 * Issue a per-session JWT for the IDE bridge.
 *
 * @param sessionId - The session ID to embed as the subject.
 * @param epoch - The server's current epoch counter.
 * @param gatewayToken - The gateway token used to derive the signing key.
 * @param ttlMs - Token time-to-live in milliseconds.
 * @returns The encoded JWT string and expiry timestamp.
 */
export function issueSessionJwt(
  sessionId: string,
  epoch: number,
  gatewayToken: string,
  ttlMs: number = DEFAULT_JWT_TTL_MS,
): { jwt: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(ttlMs / 1000);
  const expiresAt = exp * 1000; // epoch ms

  const claims: BridgeJwtClaims = {
    sub: sessionId,
    iss: 'sudo-ai-bridge',
    iat: now,
    exp,
    epoch,
  };

  // Encode header and payload
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;

  // Sign with HMAC-SHA256
  const key = deriveSigningKey(gatewayToken);
  const signature = crypto.createHmac('sha256', key).update(signingInput).digest('base64url');

  const jwt = `${signingInput}.${signature}`;
  log.debug({ sessionId, epoch, exp }, 'Issued bridge JWT');

  return { jwt, expiresAt };
}

// ---------------------------------------------------------------------------
// JWT Validation
// ---------------------------------------------------------------------------

/**
 * Validate a bridge JWT.
 *
 * @param token - The JWT string to validate.
 * @param gatewayToken - The gateway token used to derive the signing key.
 * @param currentEpoch - The server's current epoch counter.
 * @returns The parsed claims if valid.
 * @throws Error on invalid signature, expired token, or epoch mismatch.
 */
export function validateSessionJwt(
  token: string,
  gatewayToken: string,
  currentEpoch: number,
): BridgeJwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [header, payload, signature] = parts;

  // Verify signature
  const key = deriveSigningKey(gatewayToken);
  const signingInput = `${header}.${payload}`;
  const expectedSignature = crypto.createHmac('sha256', key)
    .update(signingInput)
    .digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    throw new Error('Invalid JWT signature');
  }

  // Decode payload
  let claims: BridgeJwtClaims;
  try {
    const payloadJson = Buffer.from(payload, 'base64url').toString('utf-8');
    claims = JSON.parse(payloadJson);
  } catch {
    throw new Error('Invalid JWT payload');
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) {
    throw new Error('JWT expired');
  }

  // Check epoch (reject stale JWTs from before a server restart)
  if (claims.epoch !== currentEpoch) {
    throw new Error(`JWT epoch mismatch: token epoch ${claims.epoch}, server epoch ${currentEpoch}`);
  }

  log.debug({ sub: claims.sub, epoch: claims.epoch }, 'Validated bridge JWT');

  return claims;
}

// ---------------------------------------------------------------------------
// Gateway Token Verification
// ---------------------------------------------------------------------------

/**
 * Verify a gateway token against the configured GATEWAY_TOKEN env var.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * If GATEWAY_TOKEN is not configured (empty/undefined), all requests are authorized.
 *
 * @param candidate - The token to verify (from query param or header).
 * @param gatewayToken - The expected gateway token. If empty, auth is open.
 * @returns True if the token is valid or auth is open.
 */
export function verifyGatewayToken(candidate: string | undefined, gatewayToken: string | undefined): boolean {
  // No gateway token configured → open access
  if (!gatewayToken || gatewayToken.length === 0) {
    return true;
  }

  // No candidate provided → reject
  if (!candidate || candidate.length === 0) {
    return false;
  }

  // Timing-safe comparison
  const candidateBuf = Buffer.from(candidate, 'utf8');
  const expectedBuf = Buffer.from(gatewayToken, 'utf8');

  return candidateBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// Epoch Management
// ---------------------------------------------------------------------------

/** Server epoch — increments on each server restart. */
let _serverEpoch = 0;
let _epochInitialized = false;

/**
 * Get the current server epoch. Initializes to `Date.now()` on first call.
 * The epoch is used to invalidate JWTs from previous server lifetimes.
 */
export function getServerEpoch(): number {
  if (!_epochInitialized) {
    _serverEpoch = Date.now();
    _epochInitialized = true;
  }
  return _serverEpoch;
}

/**
 * Reset the server epoch (for testing only).
 */
export function resetServerEpoch(): void {
  _serverEpoch = 0;
  _epochInitialized = false;
}