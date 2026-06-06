/**
 * Tests for StalledStreamProtection system.
 *
 * Covers:
 * - StalledStreamError construction and properties
 * - StalledStreamDetector: normal streams pass through
 * - StalledStreamDetector: stalls are detected after threshold
 * - StalledStreamDetector: stream_stalled event emission
 * - StalledStreamDetector: unsubscribe from events
 * - StalledStreamProtection: retries on stall and recovers
 * - StalledStreamProtection: emits stream_recovered event
 * - StalledStreamProtection: exhausts retries and throws
 * - StalledStreamProtection: emits stream_failed event
 * - StalledStreamProtection: non-stall errors propagate immediately
 * - StalledStreamProtection: emits stream_stalled for each retry
 * - StalledStreamProtection: custom configuration and defaults
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  StalledStreamError,
  StalledStreamDetector,
  StalledStreamProtection,
  DEFAULT_STALL_THRESHOLD_MS,
  MAX_RETRIES,
  RETRY_BACKOFF_MS,
  StalledStreamEvent,
} from '../../src/core/brain/stalled-stream-protection.js';

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** Create an async iterable that yields items with real delays. */
async function* delayedStream<T>(
  items: T[],
  delaysMs: number[],
): AsyncIterable<T> {
  for (let i = 0; i < items.length; i++) {
    if (delaysMs[i] !== undefined && delaysMs[i] > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    }
    yield items[i];
  }
}

/** An async iterable that yields some chunks then hangs forever. */
function hangingStream<T>(...chunks: T[]): AsyncIterable<T> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] } as IteratorResult<T>;
          }
          // Hang forever — never resolves.
          return new Promise<IteratorResult<T>>(() => {});
        },
        async return() {
          return { done: true, value: undefined } as IteratorResult<T>;
        },
      };
    },
  };
}

/** Collect all values from an async iterable. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iter) {
    result.push(item);
  }
  return result;
}

/** Collect values, catching errors. Returns [values, error]. */
async function collectWithCatch<T>(
  iter: AsyncIterable<T>,
): Promise<[T[], Error | null]> {
  const result: T[] = [];
  let error: Error | null = null;
  try {
    for await (const item of iter) {
      result.push(item);
    }
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }
  return [result, error];
}

// ---------------------------------------------------------------------------
// Tests — use real timers with short thresholds to avoid fake-timer pitfalls
// ---------------------------------------------------------------------------

describe('StalledStreamError', () => {
  it('should set name, message, stalledAfterMs, and attempt', () => {
    const err = new StalledStreamError(30_000, 2);
    expect(err.name).toBe('StalledStreamError');
    expect(err.message).toContain('30000');
    expect(err.message).toContain('attempt 2');
    expect(err.stalledAfterMs).toBe(30_000);
    expect(err.attempt).toBe(2);
  });

  it('should be an instance of Error', () => {
    const err = new StalledStreamError(5_000, 0);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StalledStreamError);
  });
});

describe('StalledStreamDetector', () => {
  it('should pass through a normal stream without stalling', async () => {
    const detector = new StalledStreamDetector();

    // Stream that yields every 50ms — well within 2s threshold.
    const source = delayedStream(['a', 'b', 'c'], [50, 50, 50]);
    const monitored = detector.monitorStream(source, 2_000);
    const result = await collect(monitored);
    expect(result).toEqual(['a', 'b', 'c']);
  }, 10_000);

  it('should detect a stall when no chunk arrives within threshold', async () => {
    const detector = new StalledStreamDetector();

    const source = hangingStream('first');
    const monitored = detector.monitorStream(source, 500);
    const [values, error] = await collectWithCatch(monitored);

    expect(values).toEqual(['first']);
    expect(error).toBeInstanceOf(StalledStreamError);
  }, 10_000);

  it('should emit stream_stalled event when a stall is detected', async () => {
    const detector = new StalledStreamDetector();
    const events: StalledStreamEvent[] = [];
    detector.onEvent((e) => events.push(e));

    const source = hangingStream('chunk1');
    const monitored = detector.monitorStream(source, 500, 1);
    const [, error] = await collectWithCatch(monitored);

    expect(error).toBeInstanceOf(StalledStreamError);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('stream_stalled');
    expect(events[0].attempt).toBe(1);
    expect(events[0].stalledAfterMs).toBeGreaterThanOrEqual(500);
  }, 10_000);

  it('should unsubscribe from events when the returned function is called', async () => {
    const detector = new StalledStreamDetector();
    const events: StalledStreamEvent[] = [];
    const unsub = detector.onEvent((e) => events.push(e));

    // Unsubscribe before the stall fires.
    unsub();

    const source = hangingStream('x');
    const monitored = detector.monitorStream(source, 500);
    await collectWithCatch(monitored);

    // No events because we unsubscribed before the stall.
    expect(events).toHaveLength(0);
  }, 10_000);
});

describe('StalledStreamProtection', () => {
  it('should complete a healthy stream on the first attempt', async () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 2_000,
    });
    const events: StalledStreamEvent[] = [];
    protection.onEvent((e) => events.push(e));

    let callCount = 0;
    const streamFactory = () => {
      callCount++;
      return delayedStream(['hello', 'world'], [50, 50]);
    };

    const result = await collect(protection.callWithProtection(streamFactory));

    expect(result).toEqual(['hello', 'world']);
    expect(callCount).toBe(1);
    // No stall-related events on a healthy stream.
    expect(events).toHaveLength(0);
  }, 10_000);

  it('should retry on stall and recover when factory produces a healthy stream', async () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 500,
      maxRetries: 3,
      retryBackoffMs: [100, 200, 300],
    });

    let callCount = 0;
    const streamFactory = (): AsyncIterable<string> => {
      callCount++;
      if (callCount === 1) {
        // First call: stall after one chunk.
        return hangingStream('partial');
      }
      // Second call: healthy stream.
      return delayedStream(['recovered-1', 'recovered-2'], [50, 50]);
    };

    const [values, error] = await collectWithCatch(
      protection.callWithProtection(streamFactory),
    );

    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(error).toBeNull();
    expect(values).toContain('partial');
    expect(values.some((v) => v.startsWith('recovered'))).toBe(true);
  }, 30_000);

  it('should emit stream_recovered event on successful retry', async () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 500,
      maxRetries: 3,
      retryBackoffMs: [100, 200, 300],
    });

    const events: StalledStreamEvent[] = [];
    protection.onEvent((e) => events.push(e));

    let callCount = 0;
    const streamFactory = (): AsyncIterable<string> => {
      callCount++;
      if (callCount <= 1) {
        return hangingStream('x');
      }
      return delayedStream(['ok'], [10]);
    };

    const [, error] = await collectWithCatch(
      protection.callWithProtection(streamFactory),
    );

    expect(error).toBeNull();
    expect(events.some((e) => e.type === 'stream_recovered')).toBe(true);
  }, 30_000);

  it('should exhaust retries and throw StalledStreamError', async () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 300,
      maxRetries: 2,
      retryBackoffMs: [100, 100],
    });

    const alwaysStalledFactory = () => hangingStream('x');

    const [, error] = await collectWithCatch(
      protection.callWithProtection(alwaysStalledFactory),
    );

    expect(error).toBeInstanceOf(StalledStreamError);
  }, 30_000);

  it('should emit stream_failed event when all retries are exhausted', async () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 300,
      maxRetries: 2,
      retryBackoffMs: [100, 100],
    });

    const events: StalledStreamEvent[] = [];
    protection.onEvent((e) => events.push(e));

    const alwaysStalledFactory = () => hangingStream('chunk');

    await collectWithCatch(protection.callWithProtection(alwaysStalledFactory));

    expect(events.some((e) => e.type === 'stream_failed')).toBe(true);
  }, 30_000);

  it('should propagate non-stall errors immediately without retry', async () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 2_000,
    });

    const events: StalledStreamEvent[] = [];
    protection.onEvent((e) => events.push(e));

    let callCount = 0;
    const errorFactory = (): AsyncIterable<string> => {
      callCount++;
      return {
        [Symbol.asyncIterator]() {
          let yielded = false;
          return {
            async next() {
              if (!yielded) {
                yielded = true;
                return { done: false, value: 'first' } as IteratorResult<string>;
              }
              throw new Error('API authentication failed');
            },
          };
        },
      };
    };

    const [values, error] = await collectWithCatch(
      protection.callWithProtection(errorFactory),
    );

    expect(error).not.toBeInstanceOf(StalledStreamError);
    expect(error?.message).toBe('API authentication failed');
    expect(callCount).toBe(1);
    expect(events).toHaveLength(0);
  }, 10_000);

  it('should emit stream_stalled events for each retry attempt', async () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 300,
      maxRetries: 3,
      retryBackoffMs: [100, 100, 100],
    });

    const events: StalledStreamEvent[] = [];
    protection.onEvent((e) => events.push(e));

    const alwaysStalledFactory = () => hangingStream('x');

    await collectWithCatch(protection.callWithProtection(alwaysStalledFactory));

    const stalledEvents = events.filter((e) => e.type === 'stream_stalled');
    // One stall event per retry attempt (0, 1, 2).
    expect(stalledEvents.map((e) => e.attempt).sort()).toEqual([0, 1, 2]);
  }, 30_000);

  it('should use correct default constants', () => {
    expect(MAX_RETRIES).toBe(3);
    expect(RETRY_BACKOFF_MS).toEqual([1_000, 3_000, 5_000]);
    expect(DEFAULT_STALL_THRESHOLD_MS).toBe(30_000);
  });

  it('should allow custom configuration via constructor', () => {
    const protection = new StalledStreamProtection({
      stallThresholdMs: 10_000,
      maxRetries: 5,
      retryBackoffMs: [500, 1_000, 1_500, 2_000, 2_500],
    });

    expect(protection.stallThresholdMs).toBe(10_000);
    expect(protection.maxRetries).toBe(5);
    expect(protection.retryBackoffMs).toEqual([500, 1_000, 1_500, 2_000, 2_500]);
  });

  it('should expose the internal detector via getDetector', () => {
    const protection = new StalledStreamProtection();
    const detector = protection.getDetector();
    expect(detector).toBeInstanceOf(StalledStreamDetector);
  });
});