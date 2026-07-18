/**
 * Context overflow must short-circuit the failover loop, not burn every profile.
 *
 * An oversized prompt is rejected identically by every same-family model, so
 * retrying it MAX_FAILOVER_ATTEMPTS times is pure waste. Brain's failover loop
 * throws llm_context_overflow on the first overflow so the agent loop can
 * compact and retry instead.
 *
 * F97 rework: the wire hop is the IR transport (`callTransportForBrain`),
 * mocked here to throw the same overflow-shaped error the provider returns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const callTransportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/brain-bridge.js', () => ({
  callTransportForBrain: callTransportMock,
  streamTransportForBrain: vi.fn(),
}));

import { Brain } from '../../src/core/brain/brain.js';
import { LLMError } from '../../src/core/shared/errors.js';

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };

/** Same status/body shape the pre-F97 suite used — extractErrorDetails reads
 * statusCode/responseBody; categorizeError(400, body) → context_overflow. */
function overflowError(): Error {
  return Object.assign(new Error('prompt is too long: 210000 tokens > 200000 maximum'), {
    statusCode: 400,
    responseBody: 'prompt is too long: 210000 tokens > 200000 maximum',
  });
}

describe('Brain context-overflow short-circuit (IR seam)', () => {
  beforeEach(() => { callTransportMock.mockReset(); });
  afterEach(() => { callTransportMock.mockReset(); });

  it('throws llm_context_overflow immediately, not after every failover attempt', async () => {
    callTransportMock.mockRejectedValue(overflowError());
    const brain = new Brain(null);
    await (brain as unknown as { providersReady: Promise<void> }).providersReady;

    let caught: unknown;
    try {
      await brain.call(REQUEST);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LLMError);
    expect((caught as LLMError).code).toBe('llm_context_overflow');
    // Observed token count is surfaced for compaction sizing.
    expect((caught as LLMError).details?.['observedTokens']).toBe(210000);
    // Short-circuited: a small, bounded number of transport attempts (a
    // consensus pre-probe + one sequential attempt that throws), NOT the full
    // MAX_FAILOVER_ATTEMPTS (10).
    expect(callTransportMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
