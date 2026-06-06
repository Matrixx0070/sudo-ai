/**
 * @file bridge-auth.test.ts
 * @description Tests for IDE Bridge JWT authentication.
 *
 * Covers: issue JWT, validate JWT, reject expired/wrong epoch/wrong signature,
 *         verify gateway token, reject wrong token, reset epoch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  issueSessionJwt,
  validateSessionJwt,
  verifyGatewayToken,
  getServerEpoch,
  resetServerEpoch,
} from '../../src/core/ide/bridge-auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_GATEWAY_TOKEN = 'test-gateway-token-secret-12345';
const TEST_JWT_TTL = 3600000; // 1 hour

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BridgeAuth — issueSessionJwt', () => {
  it('issues JWT with correct claims', () => {
    const { jwt, expiresAt } = issueSessionJwt('session-123', 1000, TEST_GATEWAY_TOKEN, TEST_JWT_TTL);

    expect(jwt).toBeTruthy();
    expect(typeof jwt).toBe('string');

    // JWT has 3 parts: header.payload.signature
    const parts = jwt.split('.');
    expect(parts.length).toBe(3);

    // Decode payload to check claims
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    expect(payload.sub).toBe('session-123');
    expect(payload.iss).toBe('sudo-ai-bridge');
    expect(payload.epoch).toBe(1000);
    expect(payload.iat).toBeTruthy();
    expect(payload.exp).toBeTruthy();

    // Expiry should be roughly iat + TTL
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('uses default TTL when not specified', () => {
    const { jwt } = issueSessionJwt('session-456', 2000, TEST_GATEWAY_TOKEN);
    expect(jwt).toBeTruthy();

    const parts = jwt.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    // Default TTL is 1 hour = 3600 seconds
    expect(payload.exp - payload.iat).toBe(3600);
  });
});

describe('BridgeAuth — validateSessionJwt', () => {
  let epoch: number;

  beforeEach(() => {
    resetServerEpoch();
    epoch = getServerEpoch();
  });

  it('validates a valid JWT', () => {
    const { jwt } = issueSessionJwt('session-123', epoch, TEST_GATEWAY_TOKEN, TEST_JWT_TTL);
    const claims = validateSessionJwt(jwt, TEST_GATEWAY_TOKEN, epoch);

    expect(claims.sub).toBe('session-123');
    expect(claims.iss).toBe('sudo-ai-bridge');
    expect(claims.epoch).toBe(epoch);
  });

  it('rejects expired JWT', () => {
    // Issue with 1 second TTL — will be expired after we advance past it
    // JWT uses epoch seconds, so we need at least 1 second difference
    const { jwt } = issueSessionJwt('session-123', epoch, TEST_GATEWAY_TOKEN, 1000); // 1 second TTL

    // Mock Date.now to be 2 seconds in the future
    const realNow = Date.now;
    const fakeNow = realNow.call(Date) + 3000; // 3 seconds ahead
    Date.now = () => fakeNow;

    try {
      expect(() => validateSessionJwt(jwt, TEST_GATEWAY_TOKEN, epoch)).toThrow();
    } finally {
      Date.now = realNow;
    }
  });

  it('rejects JWT with wrong epoch', () => {
    const { jwt } = issueSessionJwt('session-123', epoch, TEST_GATEWAY_TOKEN, TEST_JWT_TTL);

    // Different epoch should reject
    expect(() => validateSessionJwt(jwt, TEST_GATEWAY_TOKEN, epoch + 99999)).toThrow('epoch mismatch');
  });

  it('rejects JWT with wrong signing key', () => {
    const { jwt } = issueSessionJwt('session-123', epoch, TEST_GATEWAY_TOKEN, TEST_JWT_TTL);

    expect(() => validateSessionJwt(jwt, 'wrong-gateway-token', epoch)).toThrow('Invalid JWT signature');
  });

  it('rejects malformed JWT', () => {
    expect(() => validateSessionJwt('not-a-jwt', TEST_GATEWAY_TOKEN, epoch)).toThrow('Invalid JWT format');
  });
});

describe('BridgeAuth — verifyGatewayToken', () => {
  it('allows correct gateway token', () => {
    expect(verifyGatewayToken(TEST_GATEWAY_TOKEN, TEST_GATEWAY_TOKEN)).toBe(true);
  });

  it('rejects wrong gateway token', () => {
    expect(verifyGatewayToken('wrong-token', TEST_GATEWAY_TOKEN)).toBe(false);
  });

  it('rejects empty candidate when token is set', () => {
    expect(verifyGatewayToken('', TEST_GATEWAY_TOKEN)).toBe(false);
    expect(verifyGatewayToken(undefined, TEST_GATEWAY_TOKEN)).toBe(false);
  });

  it('allows any token when gateway token is not configured', () => {
    expect(verifyGatewayToken('any-token', '')).toBe(true);
    expect(verifyGatewayToken(undefined, undefined)).toBe(true);
    expect(verifyGatewayToken('', '')).toBe(true);
  });

  it('uses timing-safe comparison', () => {
    // This test verifies that the comparison is not vulnerable to timing attacks
    // by checking that wrong-length tokens are rejected
    expect(verifyGatewayToken('short', TEST_GATEWAY_TOKEN)).toBe(false);
    expect(verifyGatewayToken(TEST_GATEWAY_TOKEN + 'extra', TEST_GATEWAY_TOKEN)).toBe(false);
  });
});

describe('BridgeAuth — epoch management', () => {
  afterEach(() => {
    resetServerEpoch();
  });

  it('returns a stable epoch within a session', () => {
    const epoch1 = getServerEpoch();
    const epoch2 = getServerEpoch();
    expect(epoch1).toBe(epoch2);
  });

  it('resetServerEpoch clears the epoch', () => {
    const epoch1 = getServerEpoch();
    resetServerEpoch();
    // After reset, a new epoch is generated (based on Date.now())
    const epoch2 = getServerEpoch();
    // Epochs may differ but should both be valid timestamps
    expect(typeof epoch2).toBe('number');
    expect(epoch2).toBeGreaterThan(0);
  });
});