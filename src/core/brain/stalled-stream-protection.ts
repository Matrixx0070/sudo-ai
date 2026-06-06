/**
 * Stalled Stream Protection system.
 *
 * Detects when a streaming model API response stops producing tokens within
 * a configurable threshold, terminates the stalled stream, and retries with
 * progressive backoff. Mirrors the Grok Build CLI's stalled-stream guard.
 *
 * Components:
 * - StalledStreamError   — typed error thrown on stall detection
 * - StalledStreamDetector — monitors an AsyncIterable for chunk liveness
 * - StalledStreamProtection — wraps API calls with detection + retry logic
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:stalled-stream');

// ---------------------------------------------------------------------------
// StalledStreamError
// ---------------------------------------------------------------------------

/**
 * Thrown when a monitored stream does not produce a chunk within the
 * configured stall threshold.
 */
export class StalledStreamError extends Error {
  /** Milliseconds since the last chunk was received when the stall was detected. */
  public readonly stalledAfterMs: number;
  /** How many retry attempts have already been made for this call. */
  public readonly attempt: number;

  constructor(stalledAfterMs: number, attempt: number) {
    super(
      `Stream stalled: no data received for ${stalledAfterMs}ms (attempt ${attempt})`,
    );
    this.name = 'StalledStreamError';
    this.stalledAfterMs = stalledAfterMs;
    this.attempt = attempt;
  }
}

// ---------------------------------------------------------------------------
// Telemetry event types
// ---------------------------------------------------------------------------

export type StalledStreamEventType =
  | 'stream_stalled'
  | 'stream_recovered'
  | 'stream_failed';

export interface StalledStreamEvent {
  type: StalledStreamEventType;
  attempt: number;
  stalledAfterMs?: number;
  timestamp: number;
}

export type StalledStreamEventListener = (event: StalledStreamEvent) => void;

// ---------------------------------------------------------------------------
// Timer abstraction — allows tests to inject a fake clock
// ---------------------------------------------------------------------------

export interface StallTimer {
  /** Return the current time in ms since epoch. */
  now(): number;
  /** Sleep for the given number of milliseconds. */
  sleep(ms: number): Promise<void>;
  /**
   * Schedule a callback to fire after `delayMs`. Returns a cancel function.
   * This is the core primitive used for stall detection — a timeout that
   * rejects if the stream doesn't produce the next chunk in time.
   */
  setTimeout(callback: () => void, delayMs: number): () => void;
}

/** Production timer using the real `setTimeout`. */
export class RealStallTimer implements StallTimer {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setTimeout(callback: () => void, delayMs: number): () => void {
    const handle = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(handle);
  }
}

// ---------------------------------------------------------------------------
// StalledStreamDetector
// ---------------------------------------------------------------------------

/**
 * Watches an AsyncIterable for liveness. If no chunk arrives within
 * `stallThresholdMs` after the previous chunk (or the start of the stream),
 * a `StalledStreamError` is thrown and the stream iteration aborts.
 *
 * Uses Promise.race to actively interrupt a pending iterator.next() call
 * when the stall timeout fires, rather than passively polling.
 *
 * Usage:
 *   const monitored = detector.monitorStream(apiStream, 30_000);
 *   for await (const chunk of monitored) { ... }
 */
export class StalledStreamDetector {
  private readonly listeners: Set<StalledStreamEventListener> = new Set();
  private readonly timer: StallTimer;

  constructor(timer?: StallTimer) {
    this.timer = timer ?? new RealStallTimer();
  }

  /**
   * Subscribe to telemetry events.
   * Returns an unsubscribe function.
   */
  onEvent(listener: StalledStreamEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: StalledStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err }, 'StalledStreamDetector event listener threw');
      }
    }
  }

  /**
   * Wrap an AsyncIterable so that iteration aborts with `StalledStreamError`
   * if no chunk arrives within `stallThresholdMs` (default 30 000 ms).
   *
   * The returned async iterable re-yields every chunk from the source, so
   * callers consume it identically to the original stream.
   *
   * @param stream           — Source async iterable (e.g. model API stream).
   * @param stallThresholdMs — Max ms allowed between consecutive chunks.
   * @param attempt          — Current retry attempt number (for telemetry).
   */
  async *monitorStream<T>(
    stream: AsyncIterable<T>,
    stallThresholdMs: number = 30_000,
    attempt: number = 0,
  ): AsyncIterable<T> {
    const iterator: AsyncIterator<T> =
      Symbol.asyncIterator in stream
        ? stream[Symbol.asyncIterator]()
        : (stream as AsyncIterable<T>)[Symbol.asyncIterator]();

    let stallError: StalledStreamError | null = null;

    try {
      while (true) {
        // Mutable container for the cancel function, populated by the
        // promise executor below. Cannot reference the promise variable
        // inside its own executor (TDZ), so we use a wrapper object.
        const cancelHolder: { cancel?: () => void } = {};

        // Create a stall timeout promise that rejects if no chunk arrives
        // within stallThresholdMs.
        const stallPromise = new Promise<never>((_resolve, reject) => {
          cancelHolder.cancel = this.timer.setTimeout(() => {
            const elapsed = stallThresholdMs;
            stallError = new StalledStreamError(elapsed, attempt);
            this.emit({
              type: 'stream_stalled',
              attempt,
              stalledAfterMs: elapsed,
              timestamp: this.timer.now(),
            });
            log.warn(
              { stallThresholdMs, attempt },
              'Stream stall detected — aborting iteration',
            );
            reject(stallError);
          }, stallThresholdMs);
        });

        // Race the next iterator result against the stall timeout.
        const result = await Promise.race([
          iterator.next(),
          stallPromise,
        ]);

        // If we get here, the iterator won the race. Cancel the stall timer.
        cancelHolder.cancel?.();

        if ((result as IteratorResult<T>).done) {
          break;
        }

        yield (result as IteratorResult<T>).value;
      }
    } finally {
      // Attempt to clean up the source iterator.
      try {
        if (typeof iterator.return === 'function') {
          await iterator.return();
        }
      } catch {
        // Swallow — the source may already be closed.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// StalledStreamProtection
// ---------------------------------------------------------------------------

/** Default stall threshold: 30 seconds. */
export const DEFAULT_STALL_THRESHOLD_MS = 30_000;

/** Maximum retry attempts for a stalled stream. */
export const MAX_RETRIES = 3;

/** Progressive backoff delays (ms) between retries. */
export const RETRY_BACKOFF_MS = [1_000, 3_000, 5_000] as const;

/**
 * Wraps a model API call factory with stall detection and automatic retry.
 *
 * Instead of calling the model API directly, callers provide a *factory*
 * function that returns a fresh AsyncIterable each time.  This allows
 * `callWithProtection` to re-invoke the factory on each retry attempt.
 *
 * Usage:
 *   const protection = new StalledStreamProtection();
 *   const result = await protection.callWithProtection(
 *     () => modelApi.chatStream({ prompt }),
 *   );
 */
export class StalledStreamProtection {
  public readonly stallThresholdMs: number;
  public readonly maxRetries: number;
  public readonly retryBackoffMs: readonly number[];

  private readonly detector: StalledStreamDetector;
  private readonly listeners: Set<StalledStreamEventListener> = new Set();
  private readonly timer: StallTimer;

  constructor(options?: {
    stallThresholdMs?: number;
    maxRetries?: number;
    retryBackoffMs?: number[];
    timer?: StallTimer;
  }) {
    this.stallThresholdMs =
      options?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.maxRetries = options?.maxRetries ?? MAX_RETRIES;
    this.retryBackoffMs = options?.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.timer = options?.timer ?? new RealStallTimer();

    this.detector = new StalledStreamDetector(this.timer);

    // Bridge detector events to our own listeners.
    this.detector.onEvent((event) => this.emit(event));
  }

  // -------------------------------------------------------------------------
  // Event bus
  // -------------------------------------------------------------------------

  /**
   * Subscribe to telemetry events (stream_stalled, stream_recovered, stream_failed).
   * Returns an unsubscribe function.
   */
  onEvent(listener: StalledStreamEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: StalledStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err }, 'StalledStreamProtection event listener threw');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Protected call
  // -------------------------------------------------------------------------

  /**
   * Execute a streaming API call with stall detection and automatic retry.
   *
   * @param streamFactory — A function that returns a fresh AsyncIterable for
   *                        each attempt. Must be re-invocable for retries.
   * @returns An AsyncIterable that yields the combined output of the
   *          (possibly retried) stream.
   *
   * If all retry attempts are exhausted, a final `stream_failed` event is
   * emitted and the last `StalledStreamError` is thrown.
   */
  async *callWithProtection<T>(
    streamFactory: () => AsyncIterable<T>,
  ): AsyncIterable<T> {
    let lastError: StalledStreamError | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const source = streamFactory();
        const monitored = this.detector.monitorStream<T>(
          source,
          this.stallThresholdMs,
          attempt,
        );

        for await (const chunk of monitored) {
          yield chunk;
        }

        // If we got here the stream completed without stalling.
        if (attempt > 0) {
          this.emit({
            type: 'stream_recovered',
            attempt,
            timestamp: this.timer.now(),
          });
          log.info({ attempt }, 'Stream recovered after retry');
        }

        return; // Stream completed successfully.
      } catch (err) {
        if (err instanceof StalledStreamError) {
          lastError = err;
          log.warn(
            { attempt, maxRetries: this.maxRetries, stalledAfterMs: err.stalledAfterMs },
            'Stream stalled — will retry',
          );

          // Back off before next attempt (skip on last attempt).
          if (attempt < this.maxRetries - 1) {
            const backoffIdx = Math.min(attempt, this.retryBackoffMs.length - 1);
            const backoffMs = this.retryBackoffMs[backoffIdx];
            log.debug({ backoffMs, nextAttempt: attempt + 1 }, 'Backing off before retry');
            await this.timer.sleep(backoffMs);
          }

          continue;
        }

        // Non-stall errors propagate immediately.
        throw err;
      }
    }

    // All retries exhausted.
    this.emit({
      type: 'stream_failed',
      attempt: this.maxRetries,
      timestamp: this.timer.now(),
    });
    log.error(
      { maxRetries: this.maxRetries },
      'Stream failed — all retry attempts exhausted',
    );

    throw lastError ?? new StalledStreamError(this.stallThresholdMs, this.maxRetries);
  }

  // -------------------------------------------------------------------------
  // Expose underlying detector (for advanced use-cases / testing)
  // -------------------------------------------------------------------------

  /** The internal StalledStreamDetector used by this protection instance. */
  getDetector(): StalledStreamDetector {
    return this.detector;
  }
}