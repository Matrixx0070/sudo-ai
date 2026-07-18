/**
 * @file tests/brain/brain-ir-seam.test.ts
 * @description F97 cutover pin — the IR transport is the ONLY wire path out of
 * Brain. The LLM_IR_CALLERS ramp flag and the legacy ai-SDK fallback are GONE.
 *
 * Pinned here:
 * - every source (e.g. 'chat', no env flag set) goes through
 *   `callTransportForBrain` exactly ONCE per attempt;
 * - a transport throw invokes NO legacy path (nothing else is called) and
 *   surfaces through brain's failover loop — the NEXT profile is attempted via
 *   the transport, and exhaustion throws brain's terminal LLMError;
 * - LLM_IR_CALLERS set or unset makes NO difference.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const callTransportMock = vi.hoisted(() => vi.fn());
const streamTransportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/brain-bridge.js', () => ({
  callTransportForBrain: callTransportMock,
  streamTransportForBrain: streamTransportMock,
}));

import { Brain } from '../../src/core/brain/brain.js';
import { LLMError } from '../../src/core/shared/errors.js';
import { AuthProfileRotation } from '../../src/core/brain/auth-profile-rotation.js';

const PRIMARY = 'xai/grok-4-fast-non-reasoning';
const FALLBACK = 'openai/gpt-test-fallback';
const BRAIN_CONFIG = {
  models: {
    primary: [
      { id: PRIMARY, maxOutputTokens: 8192 },
      { id: FALLBACK, maxOutputTokens: 8192 },
    ],
  },
};

const ENV_KEYS = [
  'LLM_IR_CALLERS',
  'SUDO_BRAIN_CONSENSUS_DISABLE',
  'SUDO_SMART_ROUTE_DISABLE',
  'SUDO_FAILOVER_BACKOFF_DISABLE',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function okCall(text = 'hello from the transport') {
  return {
    result: {
      text,
      finishReason: 'stop' as const,
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      toolCalls: [],
      reasoning: undefined,
      reasoningText: undefined,
      providerMetadata: undefined,
    },
    traceId: 'trace-ir-seam',
  };
}

/** 429-shaped: extractErrorDetails reads statusCode, categorizeError → rate_limit. */
function httpError(statusCode: number): Error {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

async function newBrain(): Promise<Brain> {
  const brain = new Brain(BRAIN_CONFIG);
  await (brain as unknown as { providersReady: Promise<void> }).providersReady;
  return brain;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1'; // deterministic sequential failover
  process.env['SUDO_SMART_ROUTE_DISABLE'] = '1'; // pin profile order (no cheap-route)
  process.env['SUDO_FAILOVER_BACKOFF_DISABLE'] = '1'; // no real sleeps between attempts
  AuthProfileRotation.resetInstance();
  callTransportMock.mockReset();
  streamTransportMock.mockReset();
});

afterEach(() => {
  AuthProfileRotation.resetInstance();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('Brain.call — IR transport is the only wire path (F97)', () => {
  it('source "chat", NO env flag → exactly one callTransportForBrain per attempt', async () => {
    callTransportMock.mockResolvedValue(okCall());
    const brain = await newBrain();
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'chat' });

    expect(callTransportMock).toHaveBeenCalledTimes(1);
    expect(callTransportMock.mock.calls[0]![1]).toBe(PRIMARY);
    // The request object carries the raw messages + resolved system/source.
    const req = callTransportMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(req['source']).toBe('chat');
    expect(Array.isArray(req['messages'])).toBe(true);
    expect(typeof req['system']).toBe('string');
    expect(res.content).toBe('hello from the transport');
    expect(res.model).toBe(PRIMARY);
    expect(streamTransportMock).not.toHaveBeenCalled();
  });

  it('transport throw → NO legacy path; failover advances to the next profile (also via the transport)', async () => {
    callTransportMock
      .mockRejectedValueOnce(httpError(429)) // primary profile fails
      .mockResolvedValueOnce(okCall('served by fallback profile'));
    const brain = await newBrain();
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'chat' });

    // Two attempts, BOTH through the transport — nothing else exists to call.
    expect(callTransportMock).toHaveBeenCalledTimes(2);
    expect(callTransportMock.mock.calls[0]![1]).toBe(PRIMARY);
    expect(callTransportMock.mock.calls[1]![1]).toBe(FALLBACK);
    expect(res.model).toBe(FALLBACK);
    expect(res.content).toBe('served by fallback profile');
    expect(streamTransportMock).not.toHaveBeenCalled();
  });

  it('every profile failing through the transport → terminal LLMError from the failover loop', async () => {
    callTransportMock.mockRejectedValue(httpError(429));
    const brain = await newBrain();

    let caught: unknown;
    try {
      await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'chat' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LLMError);
    // Small pool → cooldowns empty it before MAX_FAILOVER_ATTEMPTS; either
    // terminal code is the failover loop's own (never a legacy-path artifact).
    expect(['llm_all_attempts_failed', 'llm_all_profiles_exhausted']).toContain((caught as LLMError).code);
    // Both configured profiles were attempted via the transport, nothing else.
    expect(callTransportMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const modelsTried = callTransportMock.mock.calls.map((c) => c[1]);
    expect(modelsTried).toContain(PRIMARY);
    expect(modelsTried).toContain(FALLBACK);
    expect(streamTransportMock).not.toHaveBeenCalled();
  });

  it('LLM_IR_CALLERS makes NO difference: unset, "*", and a non-matching list behave identically', async () => {
    for (const flag of [undefined, '*', 'health,consciousness']) {
      callTransportMock.mockReset();
      callTransportMock.mockResolvedValue(okCall());
      if (flag === undefined) delete process.env['LLM_IR_CALLERS'];
      else process.env['LLM_IR_CALLERS'] = flag;

      const brain = await newBrain();
      const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], source: 'agent' });
      expect(callTransportMock, `flag=${String(flag)}`).toHaveBeenCalledTimes(1);
      expect(res.content, `flag=${String(flag)}`).toBe('hello from the transport');
    }
  });
});
