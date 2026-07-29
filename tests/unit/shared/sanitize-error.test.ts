/**
 * sanitizeUserFacingError — raw provider errors must never reach a chat user
 * verbatim. Maps LLMError codes, Cloudflare/HTML pages, provider JSON, and errno
 * strings to safe copy; passes short plain messages through.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { sanitizeUserFacingError } from '../../../src/core/shared/sanitize-error.js';
import { LLMError } from '../../../src/core/shared/errors.js';

afterEach(() => { delete process.env['SUDO_ERROR_SANITIZE']; });

describe('sanitizeUserFacingError', () => {
  it('maps known LLMError codes to friendly copy', () => {
    expect(sanitizeUserFacingError(new LLMError('x', 'llm_context_overflow'))).toMatch(/too long/i);
    expect(sanitizeUserFacingError(new LLMError('x', 'llm_idle_circuit_open'))).toMatch(/temporarily unresponsive/i);
    expect(sanitizeUserFacingError(new LLMError('x', 'llm_all_attempts_failed'))).toMatch(/temporarily unavailable/i);
  });

  it('never leaks a raw Cloudflare/HTML page', () => {
    const out = sanitizeUserFacingError(new Error('<!DOCTYPE html><html><title>Attention Required! | Cloudflare</title>'));
    expect(out).toMatch(/gateway error/i);
    expect(out).not.toMatch(/<html|cloudflare/i);
  });

  it('never leaks raw provider JSON — surfaces only the message field', () => {
    const out = sanitizeUserFacingError(new Error('{"type":"invalid_request_error","message":"prompt is too long"}'));
    expect(out).toContain('prompt is too long');
    expect(out).not.toContain('invalid_request_error');
    expect(out).not.toContain('{');
  });

  it('gives generic copy for provider JSON with no message field', () => {
    const out = sanitizeUserFacingError(new Error('{"type":"overloaded_error"}'));
    expect(out).toMatch(/failed/i);
    expect(out).not.toContain('overloaded_error');
  });

  it('maps transport errno codes to a network message', () => {
    expect(sanitizeUserFacingError(new Error('connect ECONNREFUSED 10.0.0.1:443'))).toMatch(/network error/i);
    expect(sanitizeUserFacingError(new Error('getaddrinfo ENOTFOUND api.anthropic.com'))).toMatch(/network error/i);
  });

  it('passes a short plain message through, generic-izes an overlong one', () => {
    expect(sanitizeUserFacingError(new Error('Rate limit reached'))).toBe('Rate limit reached');
    expect(sanitizeUserFacingError(new Error('z'.repeat(5000)))).toMatch(/unexpected error/i);
  });

  it('kill-switch=0 returns the raw truncated message', () => {
    process.env['SUDO_ERROR_SANITIZE'] = '0';
    expect(sanitizeUserFacingError(new Error('{"type":"x","message":"raw leak"}'), 50)).toContain('raw leak');
  });

  it('is safe on non-Error input', () => {
    expect(typeof sanitizeUserFacingError('plain string')).toBe('string');
    expect(typeof sanitizeUserFacingError(null)).toBe('string');
  });
});

/**
 * 2026-07-29: three of four brain profiles were down for hours — an Anthropic
 * ORGANISATION-level OAuth block (403 → auth_permanent → permanently disabled)
 * plus 429 quota walls on google and openai — and every failure told the user
 * "The AI providers are all temporarily unavailable. Please try again shortly."
 * None of it was temporary and retrying could never fix it. The message has to
 * distinguish "wait" from "go fix your config".
 */
describe('sanitizeUserFacingError — exhausted chain tells the truth', () => {
  const exhausted = (details: Record<string, unknown>): LLMError =>
    new LLMError('All model profiles are exhausted or in cooldown', 'llm_all_profiles_exhausted', details);

  it('permanently disabled profiles are NOT described as temporary', () => {
    const msg = sanitizeUserFacingError(exhausted({ disabledCount: 3, coolingCount: 0, profileCount: 4, soonestRetryMs: 0 }));
    expect(msg).not.toMatch(/temporar/i);
    expect(msg).not.toMatch(/try again shortly/i);
    expect(msg).toMatch(/3 of 4/);
    expect(msg).toMatch(/configuration fix/i);
  });

  it('says "Every" when the whole chain is permanently disabled', () => {
    const msg = sanitizeUserFacingError(exhausted({ disabledCount: 4, profileCount: 4 }));
    expect(msg).toMatch(/Every configured providers are permanently disabled/i);
  });

  it('rate-limited chains stay "wait", with the actual wait', () => {
    const msg = sanitizeUserFacingError(exhausted({ disabledCount: 0, coolingCount: 2, profileCount: 3, soonestRetryMs: 45_000 }));
    expect(msg).toMatch(/rate-limited/i);
    expect(msg).toMatch(/45s/);
  });

  it('a permanent failure outranks a cooldown — config beats waiting', () => {
    const msg = sanitizeUserFacingError(exhausted({ disabledCount: 1, coolingCount: 2, profileCount: 3, soonestRetryMs: 5_000 }));
    expect(msg).toMatch(/permanently disabled/i);
    expect(msg).not.toMatch(/rate-limited/i);
  });

  it('falls back to the legacy copy when no chain detail is attached', () => {
    expect(sanitizeUserFacingError(exhausted({}))).toMatch(/temporarily unavailable/i);
  });
});
