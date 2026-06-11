/**
 * @file consensus-error-attribution.test.ts
 * @description Per-model error attribution in the Phase-1 consensus path:
 * failures are recorded against the failing participant with the real error
 * category, and the all-failed fallback no longer blanket-records 'format'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

function profile(id: string): ModelProfile {
  return {
    id,
    provider: id.slice(0, id.indexOf('/')),
    modelId: id.slice(id.indexOf('/') + 1),
    priority: 0,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    disabled: false,
  };
}

function httpError(status: number, responseHeaders?: Record<string, string>): Error {
  // Both `status` and `statusCode` set, matching SDK APICallError shape and
  // exercising the primary branch of Brain.extractErrorDetails.
  return Object.assign(new Error(`status ${status}`), {
    status,
    statusCode: status,
    ...(responseHeaders ? { responseHeaders } : {}),
  });
}

function okResponse(model: string) {
  return {
    content: `response-from-${model}`,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCost: 0 },
    model,
    finishReason: 'stop' as const,
  };
}

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };
const GOOD = 'ollama/good-model:cloud';
const BAD = 'xai/bad-model:cloud';

function setupBrain(behaviors: Record<string, () => Promise<unknown>>) {
  const brain = new Brain(null);
  const profiles = Object.keys(behaviors).map(profile);
  (brain as any).failover.getCloudProfiles = vi.fn().mockReturnValue(profiles);
  // Phase 2 must never run against real failover state in these tests.
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValue(null);
  (brain as any)._callSingleModel = vi.fn(async (p: ModelProfile) => behaviors[p.id]!());
  const recordError = vi.spyOn((brain as any).failover, 'recordError');
  const recordSuccess = vi.spyOn((brain as any).failover, 'recordSuccess').mockImplementation(() => {});
  return { brain, recordError, recordSuccess };
}

describe('Consensus per-model error attribution', () => {
  const ENV = [
    'SUDO_BRAIN_CONSENSUS_DISABLE',
    'SUDO_SMART_ROUTE_DISABLE',
    'SUDO_CONSENSUS_EARLY_EXIT_DISABLE',
    'SUDO_CONSENSUS_MIN_AGREEMENT',
    'SUDO_CONSENSUS_MIN_RESPONDERS',
    'SUDO_CONSENSUS_TIMEOUT_MS',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it('ATTR-1: a failing participant is recorded with its real category; the winner still succeeds', async () => {
    const { brain, recordError, recordSuccess } = setupBrain({
      [GOOD]: async () => okResponse(GOOD),
      [BAD]: async () => { throw httpError(429, { 'retry-after': '7' }); },
    });

    const res = await brain.call(REQUEST);

    expect(res.model).toBe(GOOD);
    expect(recordSuccess).toHaveBeenCalledWith(GOOD);
    expect(recordError).toHaveBeenCalledTimes(1);
    // Retry-After: 7 must propagate as a 7000ms cooldown hint.
    expect(recordError).toHaveBeenCalledWith(BAD, 'rate_limit', { retryAfterMs: 7000 });
  });

  it('ATTR-2: all participants failing → one real-category record each, no blanket format pass', async () => {
    const { brain, recordError } = setupBrain({
      [GOOD]: async () => { throw httpError(402); },
      [BAD]: async () => { throw httpError(429); },
    });
    // setupBrain stubs getNextProfile → null, so Phase 2 exhausts and call() throws.

    await expect(brain.call(REQUEST)).rejects.toThrow();

    expect(recordError).toHaveBeenCalledTimes(2);
    expect(recordError).toHaveBeenCalledWith(GOOD, 'billing', { retryAfterMs: undefined });
    expect(recordError).toHaveBeenCalledWith(BAD, 'rate_limit', { retryAfterMs: undefined });
    const formatCalls = recordError.mock.calls.filter((c) => c[1] === 'format');
    expect(formatCalls).toHaveLength(0);
  });

  it('ATTR-3: no participant failures → no error records at all', async () => {
    const { brain, recordError } = setupBrain({
      [GOOD]: async () => okResponse(GOOD),
      [BAD]: async () => okResponse(BAD),
    });

    await brain.call(REQUEST);

    expect(recordError).not.toHaveBeenCalled();
  });

  it('ATTR-4: early-exit path — the swallowing .catch still leaves the failure recorded', async () => {
    const { brain, recordError, recordSuccess } = setupBrain({
      [GOOD]: async () => okResponse(GOOD),
      [BAD]: async () => { throw httpError(429); },
    });

    // A positive minAgreement routes consensus through the early-exit path,
    // whose per-model `.catch(() => {})` swallows the rethrow from the caller.
    const res = await brain.call({ ...REQUEST, consensusMinAgreement: 0.1 } as any);

    expect(res.model).toBe(GOOD);
    expect(recordSuccess).toHaveBeenCalledWith(GOOD);
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(BAD, 'rate_limit', { retryAfterMs: undefined });
  });
});
