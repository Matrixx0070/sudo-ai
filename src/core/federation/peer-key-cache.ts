/**
 * @file core/federation/peer-key-cache.ts
 * @description In-memory TTL cache for federation peer public keys.
 *
 * Entries are keyed by keyId (string). Default TTL is 1 hour.
 * Size cap is 1000 entries; when exceeded the oldest 100 entries (by fetchedAt)
 * are batch-evicted (10% oldest pattern from metrics.ts).
 *
 * Kill-switch: SUDO_FED_KEY_CACHE_TTL_MS — numeric override for TTL in ms.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('federation:peer-key-cache');

const DEFAULT_TTL_MS = 3_600_000; // 1 hour
const MAX_ENTRIES = 1_000;
const EVICT_COUNT = 100; // 10% of MAX_ENTRIES

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PeerKeyEntry {
  /** The key identifier (hex prefix of public key, or server-assigned id). */
  keyId: string;
  /** DER-encoded public key as hex string. */
  publicKeyDerHex: string;
  /** Name of the peer this key was fetched from. */
  peerName: string;
  /** Epoch ms when this entry was fetched. */
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// PeerKeyCache class
// ---------------------------------------------------------------------------

export class PeerKeyCache {
  private readonly store: Map<string, PeerKeyEntry> = new Map();
  private _ttl: number;

  constructor() {
    const envTtl = process.env['SUDO_FED_KEY_CACHE_TTL_MS'];
    if (envTtl !== undefined && envTtl !== '') {
      const parsed = Number(envTtl);
      this._ttl = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
    } else {
      this._ttl = DEFAULT_TTL_MS;
    }
    log.debug({ ttlMs: this._ttl }, 'PeerKeyCache initialised');
  }

  /**
   * Returns the cached entry for keyId if present and within TTL.
   * Returns undefined on miss (absent or expired).
   */
  get(keyId: string): PeerKeyEntry | undefined {
    const entry = this.store.get(keyId);
    if (!entry) return undefined;

    if (Date.now() - entry.fetchedAt > this._ttl) {
      // Expired — treat as miss; leave in store (lazy eviction acceptable per spec)
      log.debug({ keyId }, 'PeerKeyCache: entry expired, treating as miss');
      return undefined;
    }
    return entry;
  }

  /**
   * Stores a key entry. If the cache is at capacity (1000) and the keyId is new,
   * batch-evict the oldest 100 entries by fetchedAt before inserting.
   * Update-in-place (same keyId) does NOT trigger eviction.
   */
  set(entry: PeerKeyEntry): void {
    const isNew = !this.store.has(entry.keyId);

    if (isNew && this.store.size >= MAX_ENTRIES) {
      this._evictOldest(EVICT_COUNT);
    }

    this.store.set(entry.keyId, entry);
  }

  /**
   * Removes an entry by keyId. No-op if not present.
   */
  evict(keyId: string): void {
    this.store.delete(keyId);
  }

  /**
   * Returns the number of entries currently in the cache (including expired ones
   * that have not yet been lazily removed).
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Override TTL in ms. Intended for tests only.
   */
  _setTtl(ms: number): void {
    this._ttl = ms;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Evicts the N oldest entries by fetchedAt.
   * Map iteration order is insertion order; we sort by fetchedAt to get true oldest.
   * On fetchedAt tie, insertion order (Map iteration) acts as stable tie-breaker.
   */
  private _evictOldest(n: number): void {
    const entries = Array.from(this.store.entries());
    // Sort ascending by fetchedAt; ties preserve insertion order (Array.sort is stable in V8)
    entries.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const toEvict = entries.slice(0, n);
    for (const [keyId] of toEvict) {
      this.store.delete(keyId);
    }
    log.debug({ evicted: toEvict.length }, 'PeerKeyCache: batch-evicted oldest entries');
  }
}
