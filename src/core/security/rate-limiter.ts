/**
 * @file security/rate-limiter.ts
 * @description Sliding-window rate limiter for SecurityGuard.
 * Extracted to keep security/index.ts under 300 lines.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('security:rate-limit');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const LIMITS = {
  messagesPerMinute: 10,
  toolCallsPerMinute: 30,
  shellCommandsPerMinute: 5,
  browserNavigationsPerMinute: 10,
} as const;

export type CounterKey = keyof typeof LIMITS;
export type BucketKey = 'messages' | 'toolCalls' | 'shellCommands' | 'browserNavigations';

const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

interface WindowBucket {
  timestamps: number[];
}

type UserWindows = {
  messages: WindowBucket;
  toolCalls: WindowBucket;
  shellCommands: WindowBucket;
  browserNavigations: WindowBucket;
};

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly windows = new Map<string, UserWindows>();
  private readonly ownerIds: Set<string>;

  constructor(ownerIds: Set<string>) {
    this.ownerIds = ownerIds;
  }

  check(userId: string, counterKey: CounterKey = 'messagesPerMinute'): RateLimitResult {
    if (!userId || typeof userId !== 'string') {
      return { allowed: true };
    }
    // Owners are exempt from rate limiting.
    if (this.ownerIds.has(userId)) {
      return { allowed: true };
    }

    const now = Date.now();
    const limit = LIMITS[counterKey];
    const userWindows = this._getUserWindows(userId);
    const bucket = userWindows[this._counterKeyToBucket(counterKey)];

    // Evict timestamps outside the sliding window.
    bucket.timestamps = bucket.timestamps.filter(ts => now - ts < WINDOW_MS);

    if (bucket.timestamps.length >= limit) {
      const oldest = bucket.timestamps[0]!;
      const retryAfterMs = Math.max(WINDOW_MS - (now - oldest), 0);
      log.warn({ userId, counterKey, limit, retryAfterMs }, 'Rate limit exceeded');
      return { allowed: false, retryAfterMs };
    }

    bucket.timestamps.push(now);
    return { allowed: true };
  }

  private _getUserWindows(userId: string): UserWindows {
    if (!this.windows.has(userId)) {
      this.windows.set(userId, {
        messages: { timestamps: [] },
        toolCalls: { timestamps: [] },
        shellCommands: { timestamps: [] },
        browserNavigations: { timestamps: [] },
      });
    }
    return this.windows.get(userId)!;
  }

  private _counterKeyToBucket(key: CounterKey): BucketKey {
    switch (key) {
      case 'messagesPerMinute': return 'messages';
      case 'toolCallsPerMinute': return 'toolCalls';
      case 'shellCommandsPerMinute': return 'shellCommands';
      case 'browserNavigationsPerMinute': return 'browserNavigations';
      default: return 'messages';
    }
  }
}
