/**
 * @file stream-early-break.test.ts
 * @description Brain.stream() generator-unwind bookkeeping on the F97 IR facade
 * (`streamTransportForBrain` → { textStream, usage, finishReason, traceId }):
 * a consumer breaking out of the chunk loop must still credit the model
 * (recordSuccess) and bill from facade.usage; error and full-consumption paths
 * keep their existing semantics. Facade promises RESOLVE (never reject) by
 * contract, so no path may leak an unhandled rejection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const streamTransportMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/llm/brain-bridge.js', () => ({
  callTransportForBrain: vi.fn(),
  streamTransportForBrain: streamTransportMock,
}));

import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

const MODEL = 'xai/test-model';

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

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheCreationInputTokens: 0 };
const PARTIAL_USAGE = { inputTokens: 30, outputTokens: 2, totalTokens: 32, cachedInputTokens: 0, cacheCreationInputTokens: 0 };

/** Build an IR facade as streamTransportForBrain resolves it. */
function facade(opts: {
  textStream: AsyncIterable<string>;
  usage?: Promise<typeof USAGE | undefined>;
  finishReason?: Promise<'stop' | 'tool-calls' | 'length' | 'error' | undefined>;
}) {
  return {
    textStream: opts.textStream,
    usage: opts.usage ?? Promise.resolve(USAGE),
    finishReason: opts.finishReason ?? Promise.resolve('stop' as const),
    traceId: 'trace-stream-facade',
  };
}

async function setupBrain(streamFacade: object) {
  streamTransportMock.mockResolvedValue(streamFacade);
  const brain = new Brain(null);
  await (brain as any).providersReady;
  const prof = profile(MODEL);
  // First attempt gets the profile; a retry would find the pool exhausted.
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValueOnce(prof).mockReturnValue(null);
  const recordError = vi.spyOn((brain as any).failover, 'recordError');
  const recordSuccess = vi.spyOn((brain as any).failover, 'recordSuccess').mockImplementation(() => {});
  const billSpy = vi
    .spyOn(brain as unknown as { _recordBillingUsage: (...a: unknown[]) => void }, '_recordBillingUsage')
    .mockImplementation(() => {});
  return { brain, recordError, recordSuccess, billSpy };
}

describe('Brain.stream() early-break bookkeeping (IR facade)', () => {
  beforeEach(() => {
    streamTransportMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    streamTransportMock.mockReset();
  });

  it('BREAK-1: consumer break records success and bills from facade.usage — no unhandled rejection', async () => {
    const { brain, recordError, recordSuccess, billSpy } = await setupBrain(facade({
      textStream: (async function* () { yield 'a'; yield 'b'; yield 'c'; })(),
      // The real facade settles usage with the LAST-KNOWN partial snapshot
      // when the consumer walks away — never undefined, never rejecting.
      usage: Promise.resolve(PARTIAL_USAGE),
      finishReason: Promise.resolve(undefined),
    }));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const chunks: string[] = [];
      for await (const chunk of brain.stream(REQUEST)) {
        chunks.push(chunk);
        break;
      }
      expect(chunks).toEqual(['a']);

      // Billing is fire-and-forget from the finally — flush the microtasks.
      await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      expect(recordSuccess).toHaveBeenCalledTimes(1);
      expect(recordSuccess).toHaveBeenCalledWith(MODEL);
      expect(recordError).not.toHaveBeenCalled();
      // Billed from facade.usage (the partial snapshot), not zeros/undefined.
      expect(billSpy).toHaveBeenCalledTimes(1);
      const usage = billSpy.mock.calls[0]![1] as { promptTokens: number; completionTokens: number } | undefined;
      expect(usage?.promptTokens).toBe(30);
      expect(usage?.completionTokens).toBe(2);
      expect(billSpy.mock.calls[0]![0]).toBe(MODEL);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('BREAK-2: full consumption keeps the normal completion path (single success record, terminal usage billed)', async () => {
    const { brain, recordError, recordSuccess, billSpy } = await setupBrain(facade({
      textStream: (async function* () { yield 'x'; yield 'y'; })(),
      usage: Promise.resolve(USAGE),
    }));

    const chunks: string[] = [];
    for await (const chunk of brain.stream(REQUEST)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['x', 'y']);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordSuccess).toHaveBeenCalledWith(MODEL);
    expect(recordError).not.toHaveBeenCalled();
    expect(billSpy).toHaveBeenCalledTimes(1);
    const usage = billSpy.mock.calls[0]![1] as { promptTokens: number; completionTokens: number } | undefined;
    expect(usage?.promptTokens).toBe(10);
    expect(usage?.completionTokens).toBe(5);
  });

  it('BREAK-3: a mid-stream throw from textStream records the error and never credits the model', async () => {
    const { brain, recordError, recordSuccess } = await setupBrain(facade({
      textStream: (async function* () {
        yield 'partial';
        throw Object.assign(new Error('status 429'), { status: 429, statusCode: 429 });
      })(),
    }));

    const consume = async () => {
      const chunks: string[] = [];
      for await (const chunk of brain.stream(REQUEST)) {
        chunks.push(chunk);
      }
      return chunks;
    };

    // The retry attempt finds the pool exhausted (getNextProfile → null).
    await expect(consume()).rejects.toThrow('exhausted');

    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(MODEL, 'rate_limit', { retryAfterMs: undefined });
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it('BREAK-4: usage resolving UNDEFINED after full delivery still records success, never an error', async () => {
    const { brain, recordError, recordSuccess } = await setupBrain(facade({
      textStream: (async function* () { yield 'x'; })(),
      usage: Promise.resolve(undefined),
    }));

    const chunks: string[] = [];
    for await (const chunk of brain.stream(REQUEST)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['x']);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordSuccess).toHaveBeenCalledWith(MODEL);
    expect(recordError).not.toHaveBeenCalled();
  });

  it('BREAK-5: terminal error thrown from textStream BEFORE any chunk (IR equivalent of the old onError-only failure) fails over with the real status, never crediting the model', async () => {
    // F97: the transport surfaces a pre/mid-stream provider failure as a THROW
    // from the facade's textStream — there is no onError side channel anymore.
    const { brain, recordError, recordSuccess } = await setupBrain(facade({
      textStream: (async function* () {
        throw Object.assign(new Error('Invalid bearer token'), { statusCode: 401 });
        // eslint-disable-next-line no-unreachable
        yield '';
      })(),
    }));

    const consume = async () => { for await (const _chunk of brain.stream(REQUEST)) { /* drain */ } };
    await expect(consume()).rejects.toThrow('exhausted');

    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith(MODEL, 'auth', { retryAfterMs: undefined });
    expect(recordSuccess).not.toHaveBeenCalled();
  });
});
