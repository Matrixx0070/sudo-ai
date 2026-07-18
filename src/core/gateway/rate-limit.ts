/**
 * gateway/rate-limit.ts — GW-8
 *
 * One small in-memory sliding-window limiter, shared by the WS/RPC preauth
 * flood control and by webhook signature-auth flood control (webhook-routes.ts).
 *
 * A limiter tracks per-key event timestamps inside a rolling window. When the
 * count in-window exceeds `limit`, the key enters a lockout for `lockoutMs`
 * during which every check is denied (regardless of new events). Pure + clock-
 * injectable so tests drive it deterministically.
 *
 * No frame bodies, tokens, or secrets are ever stored — keys only (an IP or a
 * hook id). This module never logs.
 */

/** Tunables for a single limiter instance. */
export interface SlidingWindowOptions {
  /** Max events allowed within `windowMs` before lockout. */
  limit: number;
  /** Rolling window width in ms. */
  windowMs: number;
  /** Lockout duration once the limit is exceeded (0 = no lockout, just deny the excess). */
  lockoutMs: number;
  /** Max distinct keys retained (LRU-ish cap; oldest-touched evicted). Default 10_000. */
  maxKeys?: number;
}

/** Outcome of recording an attempt. */
export interface LimiterVerdict {
  /** True when this attempt is within budget (not locked, not over limit). */
  allowed: boolean;
  /** When denied, ms until the caller may retry (window drain or lockout end). */
  retryAfterMs: number;
}

interface KeyState {
  /** Event timestamps within the current window (pruned lazily). */
  hits: number[];
  /** Epoch ms until which the key is locked out; 0 = not locked. */
  lockedUntil: number;
  /** Last touch, for eviction. */
  touched: number;
}

/**
 * A reusable sliding-window rate limiter with optional lockout.
 *
 * Usage: call `record(key)` on every attempt; act on `verdict.allowed`.
 * `isLocked(key)` peeks without recording. `reset(key)` clears on success
 * (e.g. a valid auth), so honest clients never accumulate toward lockout.
 */
export class SlidingWindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly states = new Map<string, KeyState>();

  constructor(opts: SlidingWindowOptions, now: () => number = Date.now) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.lockoutMs = opts.lockoutMs;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = now;
  }

  /** Peek: is this key currently locked out? Does not record an attempt. */
  isLocked(key: string): boolean {
    const s = this.states.get(key);
    if (!s) return false;
    return s.lockedUntil > this.now();
  }

  /** Record one attempt and return whether it is within budget. */
  record(key: string): LimiterVerdict {
    const t = this.now();
    let s = this.states.get(key);
    if (!s) {
      s = { hits: [], lockedUntil: 0, touched: t };
      this.states.set(key, s);
      this.evictIfNeeded();
    }
    s.touched = t;

    // Locked out → deny without extending the lockout.
    if (s.lockedUntil > t) {
      return { allowed: false, retryAfterMs: s.lockedUntil - t };
    }
    if (s.lockedUntil !== 0) s.lockedUntil = 0; // lockout elapsed

    // Prune events older than the window.
    const cutoff = t - this.windowMs;
    s.hits = s.hits.filter((h) => h > cutoff);
    s.hits.push(t);

    if (s.hits.length > this.limit) {
      if (this.lockoutMs > 0) {
        s.lockedUntil = t + this.lockoutMs;
        return { allowed: false, retryAfterMs: this.lockoutMs };
      }
      // No lockout: deny the excess; retry when the oldest event drains.
      const oldest = s.hits[0] ?? t;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.windowMs - t) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Clear a key's window + lockout (call on a verified-good attempt). */
  reset(key: string): void {
    this.states.delete(key);
  }

  /** Test/introspection helper. */
  size(): number {
    return this.states.size;
  }

  private evictIfNeeded(): void {
    if (this.states.size <= this.maxKeys) return;
    // Evict the least-recently-touched key.
    let oldestKey: string | undefined;
    let oldestT = Infinity;
    for (const [k, s] of this.states) {
      if (s.touched < oldestT) { oldestT = s.touched; oldestKey = k; }
    }
    if (oldestKey !== undefined) this.states.delete(oldestKey);
  }
}
