/**
 * P0 #8 — AETHER_AUDIT_10 fixes for Brain.extractErrorDetails / _extractRetryAfter
 * / _headerValue (brain.ts failover diagnostics).
 *
 * Covers the five confirmed-real findings:
 *  10-01 auth-signature scan runs even when a node carries a non-500 status
 *  10-02 body pairs with the numeric-status node, not an unrelated one
 *  10-03 _extractRetryAfter walks `.cause`
 *  10-04 _headerValue handles array-valued headers
 *  10-06 depth-limit traversal doesn't crash (deep chains truncated cleanly)
 * (10-05 was a false positive — call sites use `typeof === 'number' && > ms`.)
 */

import { describe, it, expect } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';

// Private statics — accessed via cast, same pattern as consensus-error-attribution.test.ts.
const extract = (err: unknown) =>
  (Brain as unknown as { extractErrorDetails(e: unknown): { status: number; body: string | undefined; retryAfterMs: number | undefined } })
    .extractErrorDetails(err);

describe('extractErrorDetails — AETHER_AUDIT_10', () => {
  it('10-01: upgrades to 401 on auth text even when a node has a non-500 status', () => {
    // Outer wrapper carries a misleading 400; the buried cause names the real auth failure.
    const err = { statusCode: 400, message: 'bad request', cause: { message: 'authentication_error: invalid x-api-key' } };
    expect(extract(err).status).toBe(401);
  });

  it('10-01: upgrades to 403 only on the structured permission_error shape with no trustworthy status', () => {
    const err = { message: '{"type":"error","error":{"type":"permission_error","message":"no"}}' };
    expect(extract(err).status).toBe(403);
  });

  it('HIGH (verifier): a concrete 429 whose text merely mentions permission_error is NOT permanently disabled', () => {
    // 403 → auth_permanent → PERMANENT profile disable. An incidental substring
    // in echoed content must never trigger that on a real, recoverable 429.
    const err = { statusCode: 429, message: 'rate limited; a permission_error was seen upstream' };
    expect(extract(err).status).toBe(429);
  });

  it('does not upgrade to 403 when a trustworthy concrete status is present, even with the structured shape', () => {
    const err = { statusCode: 429, cause: { message: '{"type":"permission_error"}' } };
    expect(extract(err).status).toBe(429);
  });

  it('10-01: leaves a normal concrete status untouched when no auth text present', () => {
    const err = { statusCode: 429, message: 'rate limited' };
    expect(extract(err).status).toBe(429);
  });

  it('10-02: body pairs with the numeric-status node, not an unrelated earlier node', () => {
    // cause has body text but no status; top has 401 with no body of its own.
    const err = { statusCode: 401, cause: { message: 'Internal error from a different layer' } };
    const out = extract(err);
    expect(out.status).toBe(401);
    // Must NOT mislabel the 401 with the unrelated "Internal error" body.
    expect(out.body).toBeUndefined();
  });

  it('10-02: a numeric-status node WITH a body keeps its own body', () => {
    const err = { statusCode: 403, responseBody: 'permission denied for resource X' };
    expect(extract(err).body).toBe('permission denied for resource X');
  });

  it('signature-only auth (no numeric status) still surfaces the matched text as body', () => {
    const err = { message: 'oauth token expired' };
    const out = extract(err);
    expect(out.status).toBe(401);
    expect(out.body).toContain('oauth token expired');
  });

  it('10-03: Retry-After on a nested .cause is honored', () => {
    const err = { statusCode: 429, cause: { responseHeaders: { 'retry-after': '30' } } };
    expect(extract(err).retryAfterMs).toBe(30_000);
  });

  it('10-04: array-valued Retry-After header is read (first entry)', () => {
    const err = { statusCode: 429, responseHeaders: { 'Retry-After': ['12', '99'] } };
    expect(extract(err).retryAfterMs).toBe(12_000);
  });

  it('10-06: a chain deeper than the limit is truncated without throwing', () => {
    // Build a 10-deep cause chain; deepest carries a 401 that is beyond depth 6.
    let deep: Record<string, unknown> = { statusCode: 401, message: 'authentication_error' };
    for (let i = 0; i < 10; i++) deep = { message: `layer ${i}`, cause: deep };
    expect(() => extract(deep)).not.toThrow();
    // The buried 401 is past the depth limit → falls back to the generic 500,
    // which is the documented (logged) behavior, not a crash.
    expect(extract(deep).status).toBe(500);
  });

  it('handles cyclic .cause chains without infinite recursion', () => {
    const a: Record<string, unknown> = { message: 'a' };
    const b: Record<string, unknown> = { message: 'b', cause: a };
    a['cause'] = b; // cycle
    expect(() => extract(a)).not.toThrow();
  });
});
