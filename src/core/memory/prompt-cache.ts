/**
 * @file prompt-cache.ts
 * @description PromptCacheManager — in-process LRU cache for reusing system prompts.
 *
 * Supports Anthropic-style cache_control breakpoints so callers can annotate
 * stable content for server-side prompt caching.
 *
 * Design:
 *  - Map<key, CacheEntry> with insertion-order eviction (LRU via delete+re-insert).
 *  - Max 50 entries; oldest entry evicted when limit is exceeded.
 *  - Per-entry TTL (default 1 hour). Expired entries are treated as misses.
 *  - Hit/miss counters for getStats().
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:prompt-cache');

const MAX_ENTRIES = 50;
const DEFAULT_TTL_MS = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheEntry {
  systemPrompt: string;
  cachedAt: number;
  ttlMs: number;
  tokens: number;
}

export interface CacheBreakpoint {
  cache_control: { type: 'ephemeral' };
}

export interface CacheStats {
  entries: number;
  hitRate: number;
  hits: number;
  misses: number;
}

// ---------------------------------------------------------------------------
// PromptCacheManager
// ---------------------------------------------------------------------------

export class PromptCacheManager {
  private readonly cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the cached system prompt for `key` if it exists and has not expired.
   * Returns null on miss or expiry (counts as a miss either way).
   *
   * @param key - Cache key (e.g. agent name, conversation ID).
   */
  getCachedPrompt(key: string): string | null {
    if (!key) {
      log.warn('getCachedPrompt called with empty key');
      return null;
    }

    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      log.debug({ key }, 'Cache miss: key not found');
      return null;
    }

    const age = Date.now() - entry.cachedAt;
    if (age > entry.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      log.debug({ key, ageMs: age, ttlMs: entry.ttlMs }, 'Cache miss: entry expired');
      return null;
    }

    // Refresh LRU position
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    log.debug({ key, ageMs: age }, 'Cache hit');
    return entry.systemPrompt;
  }

  /**
   * Store a system prompt in the cache.
   * If the cache is full, the least-recently-used entry is evicted first.
   *
   * @param key       - Cache key.
   * @param prompt    - The system prompt string to cache.
   * @param ttlMs     - Time-to-live in milliseconds (default: 1 hour).
   */
  setCachedPrompt(key: string, prompt: string, ttlMs: number = DEFAULT_TTL_MS): void {
    if (!key) throw new Error('Cache key must not be empty');
    if (!prompt) throw new Error('System prompt must not be empty');
    if (ttlMs <= 0) throw new Error('ttlMs must be a positive number');

    // Evict LRU entry if at capacity
    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(key)) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
        log.debug({ evicted: lruKey }, 'LRU eviction');
      }
    }

    // Estimate token count: ~4 chars per token
    const tokens = Math.ceil(prompt.length / 4);

    const entry: CacheEntry = {
      systemPrompt: prompt,
      cachedAt: Date.now(),
      ttlMs,
      tokens,
    };

    // Re-insert to refresh LRU position if key already exists
    this.cache.delete(key);
    this.cache.set(key, entry);

    log.info({ key, tokens, ttlMs }, 'System prompt cached');
  }

  /**
   * Immediately remove a cache entry by key.
   * No-op if the key does not exist.
   *
   * @param key - Cache key to remove.
   */
  invalidate(key: string): void {
    if (!key) return;
    const deleted = this.cache.delete(key);
    if (deleted) {
      log.info({ key }, 'Cache entry invalidated');
    }
  }

  /**
   * Build an Anthropic-compatible cache_control breakpoint object.
   * Callers inject this into message content blocks for server-side caching.
   *
   * @param stableContent - The stable text to annotate (used for logging only).
   * @returns An object with the cache_control breakpoint shape.
   */
  buildCacheBreakpoint(stableContent: string): CacheBreakpoint {
    if (!stableContent) throw new Error('stableContent must not be empty');
    log.debug({ length: stableContent.length }, 'Cache breakpoint created');
    return { cache_control: { type: 'ephemeral' } };
  }

  /**
   * Return cache statistics including entry count and hit rate.
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      hitRate: total === 0 ? 0 : this.hits / total,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * Remove all expired entries. Useful for periodic housekeeping.
   * Returns the number of entries removed.
   */
  evictExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.cachedAt > entry.ttlMs) {
        this.cache.delete(key);
        count++;
      }
    }
    if (count > 0) {
      log.debug({ count }, 'Expired cache entries evicted');
    }
    return count;
  }
}
