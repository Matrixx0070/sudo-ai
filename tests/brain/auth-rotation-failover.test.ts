/**
 * @file tests/brain/auth-rotation-failover.test.ts
 * @description A4 — API key rotation inside _callSingleModel before model failover.
 *
 *  1. ROT-1: rotates to the 2nd key on a 429 and succeeds.
 *  2. ROT-2: a single key (no numbered keys) → no rotation, one call.
 *  3. ROT-3: a non-key error (timeout) is NOT rotated — propagates for model failover.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock only generateText from the AI SDK; keep everything else real so provider
// handles still build via @ai-sdk/xai.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});

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

function httpError(statusCode: number): Error {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

function okResult() {
  return {
    text: 'the answer is 42',
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, inputTokens: 10, outputTokens: 5 },
    finishReason: 'stop' as const,
  };
}

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('Brain A4: API key rotation before model failover', () => {
  const KEYS = ['XAI_API_KEY_1', 'XAI_API_KEY_2', 'XAI_API_KEY', 'SUDO_AUTH_ROTATION_DISABLE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    AuthProfileRotation.resetInstance();
    generateTextMock.mockReset();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    AuthProfileRotation.resetInstance();
  });

  it('ROT-1: rotates to the 2nd key on a 429 and succeeds', async () => {
    process.env['XAI_API_KEY_1'] = 'sk-key-one';
    process.env['XAI_API_KEY_2'] = 'sk-key-two';
    generateTextMock
      .mockRejectedValueOnce(httpError(429)) // key-1 → rate limited
      .mockResolvedValueOnce(okResult()); // key-2 → ok

    const brain = new Brain(null);
    const res = await (brain as any)._callSingleModel(xaiProfile(), REQUEST, 'sys', 0.5, 1000);

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(res.model).toBe('xai/grok-test');
    const status = AuthProfileRotation.getInstance().getStatus('xai');
    expect(status.find((s) => s.keyId === 'xai-key-1')?.state).toBe('rate_limited');
  });

  it('ROT-2: single key (no numbered keys) → no rotation, one call', async () => {
    process.env['XAI_API_KEY'] = 'sk-single';
    generateTextMock.mockResolvedValueOnce(okResult());

    const brain = new Brain(null);
    // The single-key path uses getModel(), which reads the env-key provider cache
    // built by initProviders(); call() awaits this before _callSingleModel runs.
    await (brain as any).providersReady;
    const res = await (brain as any)._callSingleModel(xaiProfile(), REQUEST, 'sys', 0.5, 1000);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(res.model).toBe('xai/grok-test');
  });

  it('ROT-3: non-key error (timeout) is not rotated — propagates for model failover', async () => {
    process.env['XAI_API_KEY_1'] = 'sk-key-one';
    process.env['XAI_API_KEY_2'] = 'sk-key-two';
    generateTextMock.mockRejectedValue(httpError(408)); // timeout — not key-specific

    const brain = new Brain(null);
    await expect(
      (brain as any)._callSingleModel(xaiProfile(), REQUEST, 'sys', 0.5, 1000),
    ).rejects.toThrow();

    // Only the first key is attempted; the error propagates without burning key-2.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});
