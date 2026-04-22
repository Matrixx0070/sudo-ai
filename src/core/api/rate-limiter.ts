/**
 * In-memory, per-IP sliding-window rate limiter.
 *
 * Maintains a Map of RateLimitEntry objects keyed by client IP.
 * Each entry tracks how many requests have been made within the current
 * 60-second window. Expired windows are cleaned up on every check.
 */

import { createLogger } from '../shared/logger.js';
import type { RateLimitEntry } from './types.js';

const log = createLogger('api:rate-limiter');

/** Default: 60 requests per 60-second window. */
const DEFAULT_MAX_REQUESTS = 60;
const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly maxRequests: number;

  constructor(maxRequests = DEFAULT_MAX_REQUESTS) {
    if (maxRequests < 1) {
      throw new RangeError('RateLimiter: maxRequests must be >= 1');
    }
    this.maxRequests = maxRequests;
  }

  /**
   * Check whether `ip` is within the rate limit.
   *
   * @param ip - Client IP address string.
   * @returns `true` if the request is allowed, `false` if the limit is exceeded.
   */
  check(ip: string): boolean {
    if (!ip || typeof ip !== 'string') {
      // Unknown IP — allow but log.
      log.warn('RateLimiter.check called with empty IP — allowing');
      return true;
    }

    const now = Date.now();
    const entry = this.store.get(ip);

    if (!entry || now >= entry.resetAt) {
      // New window.
      this.store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }

    entry.count += 1;
    if (entry.count > this.maxRequests) {
      log.warn({ ip, count: entry.count, maxRequests: this.maxRequests }, 'Rate limit exceeded');
      return false;
    }

    return true;
  }

  /**
   * Return the number of seconds until the rate-limit window resets for `ip`.
   * Returns 0 if the IP has no entry or the window has already expired.
   */
  retryAfterSeconds(ip: string): number {
    const entry = this.store.get(ip);
    if (!entry) return 0;
    const remaining = Math.ceil((entry.resetAt - Date.now()) / 1000);
    return Math.max(0, remaining);
  }

  /** Remove all expired entries. Call periodically to avoid memory growth. */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [ip, entry] of this.store) {
      if (now >= entry.resetAt) {
        this.store.delete(ip);
        removed++;
      }
    }
    if (removed > 0) {
      log.debug({ removed }, 'Rate limiter entries cleaned up');
    }
  }
}
