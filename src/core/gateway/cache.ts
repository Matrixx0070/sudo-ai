/**
 * gateway/cache.ts
 *
 * Simple in-memory response cache for the gateway.
 * Caches identical requests (keyed by model + last message) for CACHE_TTL_MS.
 * Evicts the oldest entry when the MAX_ENTRIES limit is reached (LRU-lite).
 */

import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 200;

interface CacheEntry { data: string; expiresAt: number }
const store = new Map<string, CacheEntry>();

/**
 * Build a short cache key from the model name and the last message in the
 * request body. Falls back to hashing the raw body string on parse failure.
 */
export function getCacheKey(body: string): string {
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    const msgs = p['messages'];
    const lastMsg = Array.isArray(msgs) && msgs.length > 0 ? msgs[msgs.length - 1] : '';
    return createHash('sha256')
      .update(`${String(p['model'] ?? '')}::${JSON.stringify(lastMsg)}`)
      .digest('hex').slice(0, 16);
  } catch {
    return createHash('sha256').update(body).digest('hex').slice(0, 16);
  }
}

/** Return cached data for `key`, or null if absent / expired. */
export function cacheGet(key: string): string | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { store.delete(key); return null; }
  return entry.data;
}

/** Store `data` under `key` with a 60-second TTL. Evicts oldest on overflow. */
export function cacheSet(key: string, data: string): void {
  if (store.size >= MAX_ENTRIES) {
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
  store.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Current number of live cache entries (for health stats). */
export function cacheSize(): number { return store.size; }
