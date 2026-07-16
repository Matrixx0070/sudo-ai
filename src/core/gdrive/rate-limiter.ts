/**
 * @file gdrive/rate-limiter.ts
 * @description Token-bucket rate limiter with two priority lanes.
 *
 * One shared limiter fronts every Drive/Sheets call (prime directive 8).
 * Sustained rate + burst are configurable; the interactive lane always drains
 * before the background lane so bulk sync yields to anything user-adjacent.
 *
 * Deterministic-time design: `now()` is injectable so tests advance a fake
 * clock instead of sleeping.
 */

import type { GdriveLane } from './types.js';

interface Waiter {
  resolve: () => void;
}

export interface TokenBucketOptions {
  requestsPerSecond: number;
  burst: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable timer. Defaults to setTimeout (unref'd). */
  schedule?: (fn: () => void, ms: number) => void;
}

export class TokenBucketLimiter {
  private readonly rps: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  private tokens: number;
  private lastRefill: number;
  private readonly queues: Record<GdriveLane, Waiter[]> = { interactive: [], background: [] };
  private timerArmed = false;

  constructor(opts: TokenBucketOptions) {
    this.rps = Math.max(0.1, opts.requestsPerSecond);
    this.burst = Math.max(1, opts.burst);
    this.now = opts.now ?? Date.now;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // Never keep the process alive just for queued background sync.
        (t as { unref?: () => void }).unref?.();
      });
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  /** Tokens currently available (after refill accrual). Exposed for tests/telemetry. */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  get queueDepth(): { interactive: number; background: number } {
    return {
      interactive: this.queues.interactive.length,
      background: this.queues.background.length,
    };
  }

  /** Resolves when a token has been consumed for this request. */
  acquire(lane: GdriveLane = 'background'): Promise<void> {
    this.refill();
    if (this.tokens >= 1 && this.queues.interactive.length === 0 && this.queues.background.length === 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queues[lane].push({ resolve });
      this.armTimer();
    });
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.lastRefill);
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rps);
      this.lastRefill = t;
    }
  }

  /** Drain as many waiters as tokens allow — interactive lane strictly first. */
  private drain(): void {
    this.timerArmed = false;
    this.refill();
    while (this.tokens >= 1) {
      const next = this.queues.interactive.shift() ?? this.queues.background.shift();
      if (!next) return;
      this.tokens -= 1;
      next.resolve();
    }
    if (this.queues.interactive.length > 0 || this.queues.background.length > 0) {
      this.armTimer();
    }
  }

  private armTimer(): void {
    if (this.timerArmed) return;
    this.timerArmed = true;
    const deficitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.rps) * 1000));
    this.schedule(() => this.drain(), deficitMs);
  }

  /** Test hook: force a drain pass after advancing an injected clock. */
  _drainNow(): void {
    this.drain();
  }
}
