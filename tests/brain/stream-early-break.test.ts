/**
 * @file stream-early-break.test.ts
 * @description Brain.stream() generator-unwind bookkeeping: a consumer breaking
 * out of the chunk loop must still credit the model (recordSuccess) and must
 * not leave the abandoned `result.usage` promise to reject unhandled; error
 * and full-consumption paths keep their existing semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText: streamTextMock };
});

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
const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15, inputTokens: 10, outputTokens: 5 };

async function setupBrain(streamResult: object) {
  streamTextMock.mockReturnValue(streamResult);
  const brain = new Brain(null);
  await (brain as any).providersReady;
  const prof = profile(MODEL);
  // First attempt gets the profile; a retry would find the pool exhausted.
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValueOnce(prof).mockReturnValue(null);
  const recordError = vi.spyOn((brain as any).failover, 'recordError');
  const recordSuccess = vi.spyOn((brain as any).failover, 'recordSuccess').mockImplementation(() => {});
  return { brain, recordError, recordSuccess };
}

describe('Brain.stream() early-break bookkeeping', () => {
  const savedKey = process.env['XAI_API_KEY'];

  beforeEach(() => {
    process.env['XAI_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env['XAI_API_KEY'];
    else process.env['XAI_API_KEY'] = savedKey;
    vi.restoreAllMocks();
    streamTextMock.mockReset();
  });

  it('BREAK-1: consumer break records success and swallows the abandoned usage rejection', async () => {
    // Rejected only AFTER the consumer breaks — as a cancelled stream would,
    // and so the rejection cannot race the handler attachment in `finally`.
    let rejectUsage!: (err: Error) => void;
    const usage = new Promise((_resolve, reject) => { rejectUsage = reject; });
    const { brain, recordError, recordSuccess } = await setupBrain({
      textStream: (async function* () { yield 'a'; yield 'b'; yield 'c'; })(),
      usage,
    });

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

      rejectUsage(new Error('stream aborted'));
      // Let the rejection surface (unhandledRejection fires on a later tick).
      await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      expect(recordSuccess).toHaveBeenCalledTimes(1);
      expect(recordSuccess).toHaveBeenCalledWith(MODEL);
      expect(recordError).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // Regression guard — the normal path is unchanged by this fix.
  it('BREAK-2: full consumption keeps the normal completion path (single success record)', async () => {
    const { brain, recordError, recordSuccess } = await setupBrain({
      textStream: (async function* () { yield 'x'; yield 'y'; })(),
      usage: Promise.resolve(USAGE),
    });

    const chunks: string[] = [];
    for await (const chunk of brain.stream(REQUEST)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['x', 'y']);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordSuccess).toHaveBeenCalledWith(MODEL);
    expect(recordError).not.toHaveBeenCalled();
  });

  it('BREAK-3: a mid-stream provider error still records the error and never credits the model', async () => {
    const { brain, recordError, recordSuccess } = await setupBrain({
      textStream: (async function* () {
        yield 'partial';
        throw Object.assign(new Error('status 429'), { status: 429, statusCode: 429 });
      })(),
      usage: Promise.resolve(USAGE),
    });

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

  it('BREAK-4: a usage rejection after full delivery still records success, never an error', async () => {
    // Rejected as the stream finishes — right before the normal path awaits it.
    let rejectUsage!: (err: Error) => void;
    const usage = new Promise((_resolve, reject) => { rejectUsage = reject; });
    const { brain, recordError, recordSuccess } = await setupBrain({
      textStream: (async function* () {
        yield 'x';
        rejectUsage(new Error('usage fetch failed'));
      })(),
      usage,
    });

    const chunks: string[] = [];
    for await (const chunk of brain.stream(REQUEST)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['x']);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordSuccess).toHaveBeenCalledWith(MODEL);
    expect(recordError).not.toHaveBeenCalled();
  });
});
