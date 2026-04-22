/**
 * @file tests/federation/peer-key-cache.test.ts
 * @description Unit tests for PeerKeyCache — Wave 10H Builder B1.
 *
 * Tests:
 *   PKC-1   Cache miss returns undefined on empty cache
 *   PKC-2   Set and get entry within TTL returns entry
 *   PKC-3   Entry past TTL treated as miss
 *   PKC-4   Evict removes entry; subsequent get returns undefined
 *   PKC-5   Size cap: inserting 1001 entries evicts 100 oldest; size() returns 901
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PeerKeyCache } from '../../src/core/federation/peer-key-cache.js';
import type { PeerKeyEntry } from '../../src/core/federation/peer-key-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(keyId: string, fetchedAt?: number): PeerKeyEntry {
  return {
    keyId,
    publicKeyDerHex: `aabbcc${keyId}`,
    peerName: 'test-peer',
    fetchedAt: fetchedAt ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeerKeyCache', () => {
  let cache: PeerKeyCache;

  beforeEach(() => {
    cache = new PeerKeyCache();
  });

  it('PKC-1: cache miss returns undefined on empty cache', () => {
    expect(cache.get('nonexistent-key-id')).toBeUndefined();
  });

  it('PKC-2: set and get entry within TTL returns entry', () => {
    const entry = makeEntry('key-abc-001');
    cache.set(entry);

    const result = cache.get('key-abc-001');
    expect(result).not.toBeUndefined();
    expect(result!.keyId).toBe('key-abc-001');
    expect(result!.publicKeyDerHex).toBe(entry.publicKeyDerHex);
    expect(result!.peerName).toBe('test-peer');
  });

  it('PKC-3: entry past TTL treated as miss', async () => {
    cache._setTtl(100); // 100ms TTL
    cache.set(makeEntry('key-ttl-test'));

    // Wait for TTL to expire
    await new Promise<void>(resolve => setTimeout(resolve, 150));

    expect(cache.get('key-ttl-test')).toBeUndefined();
  });

  it('PKC-4: evict removes entry; subsequent get returns undefined', () => {
    cache.set(makeEntry('key-to-evict'));
    expect(cache.get('key-to-evict')).not.toBeUndefined();

    cache.evict('key-to-evict');
    expect(cache.get('key-to-evict')).toBeUndefined();
  });

  it('PKC-5: size cap at 1000 — inserting 1001st entry evicts 100 oldest; size() returns 901', () => {
    // Insert 1000 entries with ascending fetchedAt timestamps so the eviction
    // order is deterministic: entries 0..99 are oldest, entries 900..999 newest.
    const baseTime = Date.now() - 2_000_000; // 33 min ago, well within default TTL

    for (let i = 0; i < 1000; i++) {
      cache.set({
        keyId: `key-${i}`,
        publicKeyDerHex: `hex${i}`,
        peerName: 'peer-x',
        fetchedAt: baseTime + i, // strictly ascending
      });
    }

    expect(cache.size()).toBe(1000);

    // Insert the 1001st entry — should trigger eviction of 100 oldest (keys 0-99)
    cache.set({
      keyId: 'key-1000',
      publicKeyDerHex: 'hexfinal',
      peerName: 'peer-x',
      fetchedAt: baseTime + 1000,
    });

    // After evicting 100 oldest + inserting 1 new: 1000 - 100 + 1 = 901
    expect(cache.size()).toBe(901);

    // Verify that the oldest keys were evicted
    expect(cache.get('key-0')).toBeUndefined();
    expect(cache.get('key-99')).toBeUndefined();

    // Verify that newer keys survived
    expect(cache.get('key-100')).not.toBeUndefined();
    expect(cache.get('key-999')).not.toBeUndefined();
    expect(cache.get('key-1000')).not.toBeUndefined();
  });
});
