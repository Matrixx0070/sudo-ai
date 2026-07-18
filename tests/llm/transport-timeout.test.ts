/**
 * @file tests/llm/transport-timeout.test.ts
 * @description F97: the buffered callIR path carries an overall per-attempt
 * deadline (CallIROptions.timeoutMs / SUDO_LLM_CALL_TIMEOUT_MS, default 10
 * min) replacing the legacy provider layer's headers/body-idle guards. A
 * stalled provider aborts and classifies as 'timeout' so brain's failover
 * advances instead of hanging the turn forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callIR } from '../../src/llm/transport.js';
import { LLMPolicyError } from '../../src/llm/errors.js';
import { __resetPolicyState } from '../../src/llm/policy.js';
import { __resetGatewayCallLog } from '../../src/llm/logging.js';
import type { IRRequest } from '../../shared-types/ir/v1.js';

function baseIR(partial: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'xai/grok-4-fast-non-reasoning',
    caller: 'test',
    purpose: 'transport-timeout-unit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 'trace-timeout-1',
    max_tokens: 16,
  };
}

/** fetch that never responds until its signal aborts (a stalled provider). */
const hangingFetch = ((_url: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
  })) as unknown as typeof fetch;

describe('callIR buffered-path deadline (F97)', () => {
  beforeEach(() => {
    __resetPolicyState();
    __resetGatewayCallLog();
    process.env['XAI_API_KEY'] = 'xai-test-key';
  });
  afterEach(() => {
    delete process.env['XAI_API_KEY'];
    delete process.env['SUDO_LLM_CALL_TIMEOUT_MS'];
    vi.useRealTimers();
  });

  it('a stalled provider aborts at timeoutMs and classifies as timeout', async () => {
    const err = await callIR(baseIR(), {
      fetchImpl: hangingFetch,
      noRetry: true,
      timeoutMs: 50,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('timeout');
    expect(String((err as Error).message)).toContain('exceeded 50ms');
  });

  it('SUDO_LLM_CALL_TIMEOUT_MS env sets the default deadline', async () => {
    process.env['SUDO_LLM_CALL_TIMEOUT_MS'] = '40';
    const err = await callIR(baseIR({ trace_id: 'trace-timeout-2' }), {
      fetchImpl: hangingFetch,
      noRetry: true,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LLMPolicyError);
    expect((err as LLMPolicyError).class).toBe('timeout');
  });

  it('a fast response is untouched by the deadline', async () => {
    const wire = {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    };
    const fastFetch = (async () =>
      new Response(JSON.stringify(wire), { status: 200 })) as unknown as typeof fetch;
    const res = await callIR(baseIR({ trace_id: 'trace-timeout-3' }), {
      fetchImpl: fastFetch,
      noRetry: true,
      timeoutMs: 5_000,
    });
    expect(res.stop_reason).toBe('end_turn');
  });
});
