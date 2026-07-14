/**
 * gw-refactor Phase 4: LLM error taxonomy. Every one of the 11 LLMErrorClass
 * values must be reachable through the public classifiers, including the
 * "provider lies" 200-but-garbage case and content-filter refusals.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHttpError,
  classifyThrown,
  classifyOpenAIResponse,
  classifyAnthropicResponse,
  isContentFilterBody,
  isRetryable,
  LLMPolicyError,
  type LLMErrorClass,
} from '../../src/llm/errors.js';
import { LLMError } from '../../src/core/shared/errors.js';
import type { IRResponse } from '../../shared-types/ir/v1.js';

const usage = { in: 0, out: 0, cached_in: 0 };

function ir(partial: Partial<IRResponse>): IRResponse {
  return { blocks: [], stop_reason: 'end_turn', usage, trace_id: 't', ...partial };
}

describe('classifyHttpError', () => {
  it('429 → rate_limited', () => {
    expect(classifyHttpError(429)).toBe('rate_limited');
  });

  it('429 with quota body → billing (reuses isBillingBody via categorizeError)', () => {
    expect(classifyHttpError(429, 'You exceeded your current quota')).toBe('billing');
  });

  it('503 → overloaded, other 5xx → overloaded', () => {
    expect(classifyHttpError(503)).toBe('overloaded');
    expect(classifyHttpError(500)).toBe('overloaded');
    expect(classifyHttpError(529)).toBe('overloaded');
  });

  it('403 with Cloudflare HTML body → overloaded (transient block sniffer reused)', () => {
    expect(classifyHttpError(403, '<!DOCTYPE html><html>Just a moment...</html>')).toBe('overloaded');
  });

  it('408 → timeout', () => {
    expect(classifyHttpError(408)).toBe('timeout');
  });

  it('400 overflow body → context_exceeded (isContextOverflowBody reused)', () => {
    expect(classifyHttpError(400, 'prompt is too long: 210000 tokens > 200000 maximum')).toBe(
      'context_exceeded',
    );
  });

  it('402 → billing; 400 with billing body → billing', () => {
    expect(classifyHttpError(402)).toBe('billing');
    expect(classifyHttpError(400, "You're out of extra usage")).toBe('billing');
  });

  it('401 → auth and 403 (auth_permanent) → auth', () => {
    expect(classifyHttpError(401)).toBe('auth');
    expect(classifyHttpError(403, '{"error":{"type":"permission_error"}}')).toBe('auth');
  });

  it('400 plain / 404 / 410 → invalid_request', () => {
    expect(classifyHttpError(400, 'invalid_request_error: bad field')).toBe('invalid_request');
    expect(classifyHttpError(404)).toBe('invalid_request');
    expect(classifyHttpError(410)).toBe('invalid_request');
  });

  it('content-policy refusal body → content_filter (wins over status mapping)', () => {
    expect(classifyHttpError(400, 'Your request was rejected by our content policy')).toBe(
      'content_filter',
    );
    expect(classifyHttpError(403, 'blocked by the safety filter')).toBe('content_filter');
    expect(classifyHttpError(400, 'input flagged by content moderation')).toBe('content_filter');
  });
});

describe('isContentFilterBody', () => {
  it('does not fire on ordinary format errors', () => {
    expect(isContentFilterBody('invalid_request_error: messages[0].role is required')).toBe(false);
    expect(isContentFilterBody('prompt is too long: 1000 tokens > 900')).toBe(false);
  });
});

describe('classifyOpenAIResponse / classifyAnthropicResponse (provider lies on 200)', () => {
  it('extra.provider_bug → provider_bug', () => {
    const res = ir({ stop_reason: 'error', extra: { provider_bug: true } });
    expect(classifyOpenAIResponse(res)).toBe('provider_bug');
    expect(classifyAnthropicResponse(res)).toBe('provider_bug');
  });

  it('OpenAI extra.reason content_filter → content_filter', () => {
    const res = ir({ stop_reason: 'error', extra: { reason: 'content_filter' } });
    expect(classifyOpenAIResponse(res)).toBe('content_filter');
  });

  it('Anthropic extra.reason refusal → content_filter', () => {
    const res = ir({ stop_reason: 'error', extra: { reason: 'refusal' } });
    expect(classifyAnthropicResponse(res)).toBe('content_filter');
  });

  it('stop_reason error without markers → unknown; healthy response → null', () => {
    expect(classifyOpenAIResponse(ir({ stop_reason: 'error' }))).toBe('unknown');
    expect(
      classifyOpenAIResponse(ir({ blocks: [{ type: 'text', text: 'hi' }] })),
    ).toBeNull();
    expect(classifyAnthropicResponse(ir({ stop_reason: 'tool_use' }))).toBeNull();
  });
});

describe('classifyThrown', () => {
  it('TypeError fetch failed → network', () => {
    expect(classifyThrown(new TypeError('fetch failed'))).toBe('network');
  });

  it('syscall-flavored network errors → network', () => {
    expect(classifyThrown(new Error('read ECONNRESET'))).toBe('network');
    expect(classifyThrown(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe('network');
    const wrapped = new TypeError('fetch failed');
    (wrapped as TypeError & { cause?: unknown }).cause = new Error('connect ECONNREFUSED 1.2.3.4:443');
    expect(classifyThrown(wrapped)).toBe('network');
  });

  it('AbortError / TimeoutError / ETIMEDOUT → timeout', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(classifyThrown(abort)).toBe('timeout');
    const to = new Error('The operation timed out');
    to.name = 'TimeoutError';
    expect(classifyThrown(to)).toBe('timeout');
    expect(classifyThrown(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('timeout');
  });

  it('LLMError llm_context_overflow → context_exceeded; other llm_* → unknown', () => {
    expect(classifyThrown(new LLMError('too big', 'llm_context_overflow'))).toBe('context_exceeded');
    expect(classifyThrown(new LLMError('nope', 'llm_unknown_provider'))).toBe('unknown');
  });

  it('errors carrying a .status classify via classifyHttpError', () => {
    const err = new Error('[llm-client] embed failed: 429 rate limit') as Error & { status: number };
    err.status = 429;
    expect(classifyThrown(err)).toBe('rate_limited');
  });

  it('LLMPolicyError → its own class', () => {
    expect(classifyThrown(new LLMPolicyError('skip', { class: 'billing', skipped: true }))).toBe(
      'billing',
    );
  });

  it('anything else → unknown', () => {
    expect(classifyThrown(new Error('what even'))).toBe('unknown');
    expect(classifyThrown('a string')).toBe('unknown');
    expect(classifyThrown(undefined)).toBe('unknown');
  });
});

describe('isRetryable / LLMPolicyError', () => {
  it('exactly rate_limited|overloaded|timeout|network are retryable', () => {
    const all: LLMErrorClass[] = [
      'rate_limited', 'overloaded', 'timeout', 'context_exceeded', 'billing', 'auth',
      'content_filter', 'invalid_request', 'provider_bug', 'network', 'unknown',
    ];
    const retryable = all.filter(isRetryable);
    expect(retryable.sort()).toEqual(['network', 'overloaded', 'rate_limited', 'timeout']);
  });

  it('LLMPolicyError derives retryable from class and carries route/status/skipped', () => {
    const e = new LLMPolicyError('x', { class: 'overloaded', route: 'gw:chat', status: 503 });
    expect(e.retryable).toBe(true);
    expect(e.skipped).toBe(false);
    expect(e.route).toBe('gw:chat');
    expect(e.status).toBe(503);
    const skip = new LLMPolicyError('y', { class: 'billing', retryable: false, skipped: true });
    expect(skip.retryable).toBe(false);
    expect(skip.skipped).toBe(true);
    expect(skip).toBeInstanceOf(LLMPolicyError);
    expect(skip).toBeInstanceOf(Error);
  });
});
