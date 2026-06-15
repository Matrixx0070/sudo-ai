/**
 * @file heartbeat-dedup.ts
 * @description Dedup guard for the heartbeat cron path.
 *
 * Problem this solves (verified by the bot's own architectural audit, fix #1):
 *   The heartbeat scheduler can republish the same payload many times — clock
 *   drift, restarts, scheduler retries, even normal interval ticks landing on
 *   the same wall-clock minute. Each replay enters AgentLoop.run() and
 *   produces a fresh agent turn. MEMORY.md is dominated by 100+ near-identical
 *   "heartbeat acknowledged" entries; LoopGuard fires; idle warnings escalate.
 *
 * Approach:
 *   Track a SHA-256 hash of the (content-normalised) payload message for a
 *   sliding window. If we've seen the same hash within the window, drop the
 *   tick before it reaches the agent. Defaults to 60 min — long enough to
 *   absorb a restart-then-retry, short enough that real periodic content
 *   (which legitimately repeats every interval) still fires when the user
 *   actually changes context.
 *
 * Scope:
 *   In-process Map, intentionally simple. No SQLite ledger — restart wipes
 *   the cache, which is the right behaviour for a "drop duplicate ticks
 *   replayed shortly after we already processed them" guard. The window's
 *   only job is to prevent the agent burning turns; a clean cold start is
 *   not a duplicate.
 */

import { createHash } from 'node:crypto';

/** Default sliding window — heartbeats inside this gap are treated as dupes. */
export const DEFAULT_HEARTBEAT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 60 min

/** Max entries kept; protects memory if hashes never stop arriving. */
const MAX_ENTRIES = 4096;

/**
 * Normalize a heartbeat message so identity-bearing characters survive but
 * volatile decoration (timestamp lines the scheduler bakes in) doesn't make
 * every tick look unique.
 *
 * The Claude Code analysis specifically called out "[HEARTBEAT @ <ISO>]"-style
 * timestamp lines as the noise source. We strip ISO-8601-shaped lines and
 * collapse whitespace; everything else (the actual content) is preserved.
 */
export function normaliseHeartbeatMessage(raw: string): string {
  return raw
    // Drop lines containing an ISO 8601-ish timestamp — those are the
    // per-tick decoration the scheduler/builder injects, not real content.
    .split('\n')
    .filter((line) => !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable 16-char hash — collision probability is fine for a small Map. */
export function hashHeartbeatMessage(raw: string): string {
  return createHash('sha256').update(normaliseHeartbeatMessage(raw)).digest('hex').slice(0, 16);
}

export interface HeartbeatDedupResult {
  /** True when the caller should process the tick; false to drop. */
  shouldProcess: boolean;
  /** The hash that was matched/inserted — useful for logging. */
  hash: string;
  /** Defined only when shouldProcess=false: when the original tick was seen. */
  firstSeenAt?: number;
}

/**
 * Sliding-window dedup keyed by hashed (normalised) message content.
 *
 * Not thread-safe in any meaningful sense; the cron path is single-async so
 * the in-process Map's iteration semantics are fine. Tests can inject a
 * clock for deterministic expiry.
 */
export class HeartbeatDedup {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly windowMs: number = DEFAULT_HEARTBEAT_DEDUP_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Mark this message as seen. Returns `shouldProcess=true` on first sight
   * (and remembers it), `shouldProcess=false` when the same hash was seen
   * inside the window.
   */
  check(message: string): HeartbeatDedupResult {
    const hash = hashHeartbeatMessage(message);
    const now = this.now();
    this.evictExpired(now);

    const firstSeenAt = this.entries.get(hash);
    if (firstSeenAt !== undefined && now - firstSeenAt < this.windowMs) {
      // Still inside the window — refresh the timestamp so a rapid storm
      // doesn't expire mid-burst.
      this.entries.set(hash, now);
      return { shouldProcess: false, hash, firstSeenAt };
    }

    this.entries.set(hash, now);
    this.cap();
    return { shouldProcess: true, hash };
  }

  /** Test/diagnostic only. */
  size(): number {
    this.evictExpired(this.now());
    return this.entries.size;
  }

  /** Clear all state — for tests. */
  clear(): void {
    this.entries.clear();
  }

  private evictExpired(now: number): void {
    if (this.entries.size === 0) return;
    for (const [hash, ts] of this.entries) {
      if (now - ts >= this.windowMs) this.entries.delete(hash);
    }
  }

  private cap(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    // Drop the oldest entries to stay under the cap. Map iteration is
    // insertion-ordered, so the first entries are the oldest by insert time.
    const toDrop = this.entries.size - MAX_ENTRIES;
    let i = 0;
    for (const hash of this.entries.keys()) {
      if (i++ >= toDrop) break;
      this.entries.delete(hash);
    }
  }
}
