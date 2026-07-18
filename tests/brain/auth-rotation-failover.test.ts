/**
 * @file tests/brain/auth-rotation-failover.test.ts
 * @description A4 (F97 rework) — API key rotation inside _callSingleModel before
 * model failover, ported onto the IR-transport seam. The wire hop is
 * `callTransportForBrain` (mocked here); rotation passes each numbered env key
 * as `opts.apiKeyOverride`.
 *
 *  1. ROT-1: rotates to the 2nd key on a 429 and succeeds (2nd call carries
 *     the 2nd key's apiKeyOverride).
 *  2. ROT-2: a single key (no numbered keys) → exactly one call, NO
 *     apiKeyOverride passed.
 *  3. ROT-3: a non-key error (timeout) is NOT rotated — propagates for model
 *     failover after one call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const callTransportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/brain-bridge.js', () => ({
  callTransportForBrain: callTransportMock,
  streamTransportForBrain: vi.fn(),
}));

import { Brain } from '../../src/core/brain/brain.js';
import { AuthProfileRotation } from '../../src/core/brain/auth-profile-rotation.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

function xaiProfile(id = 'xai/grok-test'): ModelProfile {
  return {
    id,
    provider: 'xai',
    modelId: id.slice(id.indexOf('/') + 1),
    priority: 0,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    disabled: false,
  };
}

/** Error shape Brain.extractErrorDetails + failover.categorizeError classify
 * from `statusCode` (429 → rate_limit, 408 → timeout). Same construction as
 * the pre-F97 suite. */
function httpError(statusCode: number): Error {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

/** Successful BrainTransportCall as the bridge returns it. */
function okCall() {
  return {
    result: {
      text: 'the answer is 42',
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
      toolCalls: [],
      reasoning: undefined,
      reasoningText: undefined,
      providerMetadata: undefined,
    },
    traceId: 'trace-rot-1',
  };
}

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('Brain A4: API key rotation before model failover (IR seam)', () => {
  const KEYS = ['XAI_API_KEY_1', 'XAI_API_KEY_2', 'XAI_API_KEY', 'SUDO_AUTH_ROTATION_DISABLE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    AuthProfileRotation.resetInstance();
    callTransportMock.mockReset();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    AuthProfileRotation.resetInstance();
  });

  it('ROT-1: rotates to the 2nd key on a 429 and succeeds — 2nd call carries the 2nd apiKeyOverride', async () => {
    process.env['XAI_API_KEY_1'] = 'sk-key-one';
    process.env['XAI_API_KEY_2'] = 'sk-key-two';
    callTransportMock
      .mockRejectedValueOnce(httpError(429)) // key-1 → rate limited
      .mockResolvedValueOnce(okCall()); // key-2 → ok

    const brain = new Brain(null);
    const res = await (brain as any)._callSingleModel(xaiProfile(), REQUEST, 'sys', 0.5, 1000);

    expect(callTransportMock).toHaveBeenCalledTimes(2);
    // Each rotated attempt passes the rotated key as apiKeyOverride.
    expect(callTransportMock.mock.calls[0]![2]).toEqual({ apiKeyOverride: 'sk-key-one' });
    expect(callTransportMock.mock.calls[1]![2]).toEqual({ apiKeyOverride: 'sk-key-two' });
    // Both calls target the SAME model — rotation happens before model failover.
    expect(callTransportMock.mock.calls[0]![1]).toBe('xai/grok-test');
    expect(callTransportMock.mock.calls[1]![1]).toBe('xai/grok-test');
    expect(res.model).toBe('xai/grok-test');
    expect(res.content).toBe('the answer is 42');
    const status = AuthProfileRotation.getInstance().getStatus('xai');
    expect(status.find((s) => s.keyId === 'xai-key-1')?.state).toBe('rate_limited');
  });

  it('ROT-2: single key (no numbered keys) → no rotation, one call, NO apiKeyOverride', async () => {
    process.env['XAI_API_KEY'] = 'sk-single';
    callTransportMock.mockResolvedValueOnce(okCall());

    const brain = new Brain(null);
    await (brain as any).providersReady;
    const res = await (brain as any)._callSingleModel(xaiProfile(), REQUEST, 'sys', 0.5, 1000);

    expect(callTransportMock).toHaveBeenCalledTimes(1);
    // Plain transport call: no CallIROptions passed at all (transport resolves
    // the provider's own credential).
    expect(callTransportMock.mock.calls[0]!.length).toBe(2);
    expect(callTransportMock.mock.calls[0]![2]).toBeUndefined();
    expect(res.model).toBe('xai/grok-test');
  });

  it('ROT-3: non-key error (timeout) is not rotated — propagates for model failover', async () => {
    process.env['XAI_API_KEY_1'] = 'sk-key-one';
    process.env['XAI_API_KEY_2'] = 'sk-key-two';
    callTransportMock.mockRejectedValue(httpError(408)); // timeout — not key-specific

    const brain = new Brain(null);
    await expect(
      (brain as any)._callSingleModel(xaiProfile(), REQUEST, 'sys', 0.5, 1000),
    ).rejects.toThrow('status 408');

    // Only the first key is attempted; the error propagates without burning key-2.
    expect(callTransportMock).toHaveBeenCalledTimes(1);
  });
});
