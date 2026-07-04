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
