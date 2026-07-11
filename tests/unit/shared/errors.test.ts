/**
 * @file errors.test.ts
 * @description Unit coverage for the SudoError hierarchy and the categorizeError
 * HTTP-status categoriser in src/core/shared/errors.ts.
 *
 * The hierarchy is relied on for `instanceof` routing across channels and tools,
 * and `categorizeError` drives the LLM failover/backoff system's retry decisions,
 * so the prototype chain, code prefixes and every status branch are pinned down.
 *
 * Coverage:
 * - SudoError base class (message, code, details, prototype chain, rethrow)
 * - All subclasses (LLMError, ToolError, ChannelError, ConfigError, MemoryError,
 *   PipelineError, BrowserError, SystemError, KnowledgeError, BusinessError)
 * - categorizeError: every HTTP status branch + body disambiguation + edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  SudoError,
  LLMError,
  ToolError,
  ChannelError,
  ConfigError,
  MemoryError,
  PipelineError,
  BrowserError,
  SystemError,
  KnowledgeError,
  BusinessError,
  categorizeError,
} from '../../../src/core/shared/errors.js';

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

describe('SudoError', () => {
  it('should set message, code, and details', () => {
    const err = new SudoError('something broke', 'test_code', { foo: 42 });
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('test_code');
    expect(err.details).toEqual({ foo: 42 });
  });

  it('should allow undefined details', () => {
    const err = new SudoError('no details', 'test_code');
    expect(err.details).toBeUndefined();
  });

  it('should be an instance of Error', () => {
    const err = new SudoError('msg', 'code');
    expect(err).toBeInstanceOf(Error);
  });

  it('should have name SudoError', () => {
    const err = new SudoError('msg', 'code');
    expect(err.name).toBe('SudoError');
  });

  it('should preserve prototype chain after rethrow', () => {
    const original = new SudoError('orig', 'code');
    let caught: unknown;
    try {
      throw original;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SudoError);
    expect((caught as SudoError).code).toBe('code');
  });
});

describe('LLMError', () => {
  it('should accept llm_-prefixed code', () => {
    const err = new LLMError('rate limited', 'llm_rate_limit');
    expect(err.code).toBe('llm_rate_limit');
    expect(err.name).toBe('LLMError');
  });

  it('should be instance of SudoError', () => {
    const err = new LLMError('fail', 'llm_timeout');
    expect(err).toBeInstanceOf(SudoError);
    expect(err).toBeInstanceOf(LLMError);
  });

  it('should carry details', () => {
    const err = new LLMError('fail', 'llm_timeout', { provider: 'openai' });
    expect(err.details).toEqual({ provider: 'openai' });
  });
});

describe('ToolError', () => {
  it('should accept tool_-prefixed code', () => {
    const err = new ToolError('exec failed', 'tool_exec_error');
    expect(err.code).toBe('tool_exec_error');
    expect(err.name).toBe('ToolError');
  });

  it('should be instance of SudoError', () => {
    const err = new ToolError('fail', 'tool_misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('ChannelError', () => {
  it('should accept channel_-prefixed code', () => {
    const err = new ChannelError('telegram down', 'channel_telegram_error');
    expect(err.code).toBe('channel_telegram_error');
    expect(err.name).toBe('ChannelError');
  });

  it('should be instance of SudoError', () => {
    const err = new ChannelError('fail', 'channel_misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('ConfigError', () => {
  it('should accept config_-prefixed code', () => {
    const err = new ConfigError('bad config', 'config_invalid_json');
    expect(err.code).toBe('config_invalid_json');
    expect(err.name).toBe('ConfigError');
  });

  it('should be instance of SudoError', () => {
    const err = new ConfigError('fail', 'config_misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('MemoryError', () => {
  it('should accept memory_-prefixed code', () => {
    const err = new MemoryError('db locked', 'memory_db_locked');
    expect(err.code).toBe('memory_db_locked');
    expect(err.name).toBe('MemoryError');
  });

  it('should be instance of SudoError', () => {
    const err = new MemoryError('fail', 'memory_misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('PipelineError', () => {
  it('should accept pipeline_-prefixed code', () => {
    const err = new PipelineError('step failed', 'pipeline_step_error');
    expect(err.code).toBe('pipeline_step_error');
    expect(err.name).toBe('PipelineError');
  });

  it('should be instance of SudoError', () => {
    const err = new PipelineError('fail', 'pipeline_misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('BrowserError', () => {
  it('should prefix code with browser_', () => {
    const err = new BrowserError('page not found', 'page_not_found');
    expect(err.code).toBe('browser_page_not_found');
    expect(err.name).toBe('BrowserError');
  });

  it('should be instance of SudoError', () => {
    const err = new BrowserError('fail', 'misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('SystemError', () => {
  it('should prefix code with system_', () => {
    const err = new SystemError('command failed', 'exec_failed');
    expect(err.code).toBe('system_exec_failed');
    expect(err.name).toBe('SystemError');
  });

  it('should be instance of SudoError', () => {
    const err = new SystemError('fail', 'misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('KnowledgeError', () => {
  it('should prefix code with knowledge_', () => {
    const err = new KnowledgeError('not found', 'not_found');
    expect(err.code).toBe('knowledge_not_found');
    expect(err.name).toBe('KnowledgeError');
  });

  it('should be instance of SudoError', () => {
    const err = new KnowledgeError('fail', 'misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

describe('BusinessError', () => {
  it('should prefix code with business_', () => {
    const err = new BusinessError('api error', 'api_error');
    expect(err.code).toBe('business_api_error');
    expect(err.name).toBe('BusinessError');
  });

  it('should be instance of SudoError', () => {
    const err = new BusinessError('fail', 'misc');
    expect(err).toBeInstanceOf(SudoError);
  });
});

// ---------------------------------------------------------------------------
// categorizeError
// ---------------------------------------------------------------------------

describe('categorizeError', () => {
  // --- Direct status code mappings ---

  it('should map 402 to billing', () => {
    expect(categorizeError(402)).toBe('billing');
  });

  it('should map 429 to rate_limit by default', () => {
    expect(categorizeError(429)).toBe('rate_limit');
  });

  it('should map 429 with "insufficient_quota" body to billing', () => {
    expect(categorizeError(429, '{"error": "insufficient_quota"}')).toBe('billing');
  });

  it('should map 429 with "insufficient quota" (space) body to billing', () => {
    expect(categorizeError(429, 'insufficient quota reached')).toBe('billing');
  });

  it('should map 429 with "exceeded quota" body to billing', () => {
    expect(categorizeError(429, 'You exceeded your quota')).toBe('billing');
  });

  it('should map 429 with unrelated body to rate_limit', () => {
    expect(categorizeError(429, 'too many requests')).toBe('rate_limit');
  });

  it('should map 503 to overloaded', () => {
    expect(categorizeError(503)).toBe('overloaded');
  });

  it('should map 401 to auth', () => {
    expect(categorizeError(401)).toBe('auth');
  });

  it('should map 403 to auth_permanent', () => {
    expect(categorizeError(403)).toBe('auth_permanent');
  });

  // A quota/billing failure on an auth status must fail OVER (billing), not park
  // the profile on a re-auth cooldown (401) or permanently disable it (403).
  it('should map 401 with a billing/quota body to billing, not auth', () => {
    expect(categorizeError(401, 'Key limit exceeded')).toBe('billing');
    expect(categorizeError(401, '{"error":"insufficient credits"}')).toBe('billing');
  });

  it('should map 403 with a billing/quota body to billing, not auth_permanent', () => {
    expect(categorizeError(403, 'Your account is out of credit')).toBe('billing');
    expect(categorizeError(403, 'negative balance — payment required')).toBe('billing');
  });

  it('should still map a plain 401/403 (no billing signature) to auth/auth_permanent', () => {
    expect(categorizeError(401, 'invalid bearer token')).toBe('auth');
    expect(categorizeError(403, 'permission denied for this model')).toBe('auth_permanent');
  });

  it('should map 401/403 with a CJK insufficient-balance body to billing', () => {
    expect(categorizeError(401, '余额不足')).toBe('billing');
    expect(categorizeError(403, '账户额度不足')).toBe('billing');
  });

  // A Cloudflare/proxy HTML challenge is transient infra, not a real auth denial.
  // Left as auth_permanent (403) it would PERMANENTLY DISABLE the profile.
  it('should map a 403 Cloudflare/HTML challenge body to overloaded, not auth_permanent', () => {
    expect(categorizeError(403, '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>')).toBe('overloaded');
    expect(categorizeError(403, 'error 1020 ... cf-ray: 8ab...')).toBe('overloaded');
    expect(categorizeError(403, '<html><body>Checking your browser before accessing</body></html>')).toBe('overloaded');
  });

  it('should map a 401 HTML/proxy block body to overloaded, not auth', () => {
    expect(categorizeError(401, '<html><head><title>502 Bad Gateway</title></head></html>')).toBe('overloaded');
  });

  it('should STILL map a real JSON permission_error 403 to auth_permanent (not HTML)', () => {
    expect(categorizeError(403, '{"type":"permission_error","message":"access denied for this model"}')).toBe('auth_permanent');
  });

  it('should STILL map a real invalid-token 401 (no HTML) to auth', () => {
    expect(categorizeError(401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toBe('auth');
  });

  // Context overflow: distinct from format so the loop compacts instead of
  // blindly re-sending the oversized prompt to every profile.
  it('should map a 400 "prompt is too long" body to context_overflow', () => {
    expect(categorizeError(400, 'prompt is too long: 210000 tokens > 200000 maximum')).toBe('context_overflow');
    expect(categorizeError(400, 'This model maximum context length is 200000 tokens')).toBe('context_overflow');
  });

  // Anthropic OAuth reports exhausted subscription usage as a plain 400
  // invalid_request_error; as 'format' the failover loop hammers the dead
  // account on short cooldowns instead of parking it on a billing cooldown.
  it('should map a 400 Anthropic "out of extra usage" body to billing, not format', () => {
    expect(
      categorizeError(
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CcvTECydYyxtnrCfb5Tza"}',
      ),
    ).toBe('billing');
  });

  it('should map "usage limit reached/exceeded" bodies to billing on 400 and 429', () => {
    expect(categorizeError(400, 'usage limit reached for this billing cycle')).toBe('billing');
    expect(categorizeError(429, 'Usage limit exceeded')).toBe('billing');
  });

  it('should map a 413 overflow body to context_overflow but a TPM 413 to rate_limit', () => {
    expect(categorizeError(413, 'input length and max_tokens exceed context limit')).toBe('context_overflow');
    expect(categorizeError(413, 'rate limit: tokens per minute exceeded')).toBe('rate_limit');
  });

  it('should NOT treat a plain 400 or a TPM-token rate limit as context_overflow', () => {
    expect(categorizeError(400, 'invalid request: bad field')).toBe('format');
    expect(categorizeError(429, 'too many tokens per min for your tier')).toBe('rate_limit');
  });

  it('should map 408 to timeout', () => {
    expect(categorizeError(408)).toBe('timeout');
  });

  it('should map 404 to model_not_found', () => {
    expect(categorizeError(404)).toBe('model_not_found');
  });

  it('should map 410 to session_expired', () => {
    expect(categorizeError(410)).toBe('session_expired');
  });

  // --- 400 body disambiguation ---

  it('should map 400 with "session expired" body to session_expired', () => {
    expect(categorizeError(400, 'The session expired')).toBe('session_expired');
  });

  it('should map 400 with "session_expired" body to session_expired', () => {
    expect(categorizeError(400, 'session_expired error')).toBe('session_expired');
  });

  it('should map 400 with "model not found" body to model_not_found', () => {
    expect(categorizeError(400, 'model not found')).toBe('model_not_found');
  });

  it('should map 400 with "model_not_found" body to model_not_found', () => {
    expect(categorizeError(400, 'model_not_found')).toBe('model_not_found');
  });

  it('should map 400 with unrelated body to format', () => {
    expect(categorizeError(400, 'bad request')).toBe('format');
  });

  it('should map 400 with no body to format', () => {
    expect(categorizeError(400)).toBe('format');
  });

  // --- 5xx other than 503 ---

  it('should map 500 to overloaded', () => {
    expect(categorizeError(500)).toBe('overloaded');
  });

  it('should map 502 to overloaded', () => {
    expect(categorizeError(502)).toBe('overloaded');
  });

  it('should map 504 to overloaded', () => {
    expect(categorizeError(504)).toBe('overloaded');
  });

  it('should map 599 to overloaded', () => {
    expect(categorizeError(599)).toBe('overloaded');
  });

  // --- Edge cases ---

  it('should map unknown 4xx to format', () => {
    expect(categorizeError(418)).toBe('format'); // I'm a teapot
  });

  it('should map unknown 2xx to format', () => {
    expect(categorizeError(200)).toBe('format');
  });

  it('should map unknown 3xx to format', () => {
    expect(categorizeError(301)).toBe('format');
  });

  it('should return format for non-number status', () => {
    expect(categorizeError('500' as unknown as number)).toBe('format');
  });

  it('should return format for NaN status', () => {
    expect(categorizeError(Number.NaN)).toBe('format');
  });

  it('should return format for undefined status', () => {
    expect(categorizeError(undefined as unknown as number)).toBe('format');
  });

  it('should handle empty string body on 429 as rate_limit', () => {
    expect(categorizeError(429, '')).toBe('rate_limit');
  });

  it('should handle empty string body on 400 as format', () => {
    expect(categorizeError(400, '')).toBe('format');
  });

  it('should be case-insensitive for "insufficient_quota" detection', () => {
    expect(categorizeError(429, 'INSUFFICIENT_QUOTA')).toBe('billing');
  });

  it('should be case-insensitive for "exceeded quota" detection', () => {
    expect(categorizeError(429, 'EXCEEDED QUOTA')).toBe('billing');
  });

  it('should be case-insensitive for "session expired" detection', () => {
    expect(categorizeError(400, 'SESSION EXPIRED')).toBe('session_expired');
  });

  it('should be case-insensitive for "model not found" detection', () => {
    expect(categorizeError(400, 'MODEL NOT FOUND')).toBe('model_not_found');
  });
});
