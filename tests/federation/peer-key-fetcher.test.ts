/**
 * @file tests/federation/peer-key-fetcher.test.ts
 * @description Unit tests for PeerKeyFetcher — Wave 10H Builder B1.
 *
 * Uses vi.stubGlobal('fetch', ...) for network mocking (no real HTTP calls).
 *
 * Tests:
 *   PKF-1   fetchForKeyId returns null when registry has no peers
 *   PKF-2   fetchForKeyId fans out; peer-B matches keyId; entry cached + returned
 *   PKF-3   fetchForKeyId matches via retiring.keyId; returns retiring publicKey
 *   PKF-4   fetchForKeyId returns null when all peers respond with non-matching keyIds
 *   PKF-5   SUDO_FED_KEY_FETCH_DISABLE=1 → returns null without calling fetch
 *   PKF-6   5 concurrent fetchForKeyId calls for same keyId coalesce to 1 fan-out
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';
import { PeerKeyCache } from '../../src/core/federation/peer-key-cache.js';
import { PeerKeyFetcher } from '../../src/core/federation/peer-key-fetcher.js';
import type { PeerPublicKeyResponse } from '../../src/core/federation/peer-key-fetcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeerRegistry(peers: Array<{ name: string; url: string; token: string }>): PeerRegistry {
  return new PeerRegistry(JSON.stringify(peers), undefined);
}

function makeEmptyRegistry(): PeerRegistry {
  return new PeerRegistry(undefined, undefined);
}

/** Builds a fetch mock that returns the given response body as JSON. */
function mockFetchSuccess(data: PeerPublicKeyResponse) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
  });
}

/** Builds a fetch mock that returns HTTP 500. */
function mockFetchError500() {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeerKeyFetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['SUDO_FED_KEY_FETCH_DISABLE'];
  });

  // -------------------------------------------------------------------------
  // PKF-1: empty registry → null
  // -------------------------------------------------------------------------
  it('PKF-1: fetchForKeyId returns null when registry has no peers', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const fetcher = new PeerKeyFetcher(makeEmptyRegistry(), new PeerKeyCache());
    const result = await fetcher.fetchForKeyId('key-xyz');

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // PKF-2: peer-B matches keyId
  // -------------------------------------------------------------------------
  it('PKF-2: fan-out to 2 peers; peer-B matches keyId; entry cached with peerName=peer-B', async () => {
    const lookupKeyId = 'cafe0123';

    // peer-A returns a different keyId (no match). publicKey slice(24,32) === '1a2b3c4d'.
    const peerAResponse: PeerPublicKeyResponse = {
      keyId: '1a2b3c4d',
      keyVersion: 1,
      algorithm: 'ed25519',
      publicKey: '000000000000000000000000' + '1a2b3c4d' + '0'.repeat(56),
      generatedAt: '2026-04-20T00:00:00Z',
    };

    // peer-B returns the keyId we're looking for. publicKey slice(24,32) === 'cafe0123'.
    const peerBResponse: PeerPublicKeyResponse = {
      keyId: lookupKeyId,
      keyVersion: 1,
      algorithm: 'ed25519',
      publicKey: '000000000000000000000000' + 'cafe0123' + '0'.repeat(56),
      generatedAt: '2026-04-20T00:00:00Z',
    };

    // Mock fetch: first call returns peerA response, second returns peerB response
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: peerAResponse }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: peerBResponse }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const registry = makePeerRegistry([
      { name: 'peer-A', url: 'https://peer-a.example.com', token: 'token-a' },
      { name: 'peer-B', url: 'https://peer-b.example.com', token: 'token-b' },
    ]);
    const cache = new PeerKeyCache();
    const fetcher = new PeerKeyFetcher(registry, cache);

    const result = await fetcher.fetchForKeyId(lookupKeyId);

    expect(result).not.toBeNull();
    expect(result!.keyId).toBe(lookupKeyId);
    expect(result!.publicKeyDerHex).toBe('000000000000000000000000' + 'cafe0123' + '0'.repeat(56));
    expect(result!.peerName).toBe('peer-B');

    // Entry should be in cache
    expect(cache.get(lookupKeyId)).not.toBeUndefined();
    expect(cache.get(lookupKeyId)!.peerName).toBe('peer-B');

    // Both peers were queried
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // PKF-3: match via retiring.keyId
  // -------------------------------------------------------------------------
  it('PKF-3: matches via retiring.keyId; returns retiring publicKey', async () => {
    // keyId must be 8 hex chars; publicKey.slice(24,32) must equal keyId.
    const activeKeyId = 'abcd1234';
    const retiringKeyId = '9876fedc';
    const retiringPublicKey = '000000000000000000000000' + '9876fedc' + '0'.repeat(56);

    const peerResponse: PeerPublicKeyResponse = {
      keyId: activeKeyId,
      keyVersion: 2,
      algorithm: 'ed25519',
      publicKey: '000000000000000000000000' + 'abcd1234' + '0'.repeat(56),
      generatedAt: '2026-04-20T00:00:00Z',
      retiring: {
        keyId: retiringKeyId,
        keyVersion: 1,
        publicKey: retiringPublicKey,
      },
    };

    vi.stubGlobal('fetch', mockFetchSuccess(peerResponse));

    const registry = makePeerRegistry([
      { name: 'peer-C', url: 'https://peer-c.example.com', token: 'token-c' },
    ]);
    const fetcher = new PeerKeyFetcher(registry, new PeerKeyCache());

    // Look up the RETIRING key id
    const result = await fetcher.fetchForKeyId(retiringKeyId);

    expect(result).not.toBeNull();
    expect(result!.keyId).toBe(retiringKeyId);
    expect(result!.publicKeyDerHex).toBe(retiringPublicKey);
    expect(result!.peerName).toBe('peer-C');
  });

  // -------------------------------------------------------------------------
  // PKF-4: no peer matches → null
  // -------------------------------------------------------------------------
  it('PKF-4: returns null when all peers respond with non-matching keyIds', async () => {
    const peerResponse: PeerPublicKeyResponse = {
      keyId: 'completely-different-key',
      keyVersion: 1,
      algorithm: 'ed25519',
      publicKey: 'aaaaaaaaaaaaaaaa',
      generatedAt: '2026-04-20T00:00:00Z',
    };

    vi.stubGlobal('fetch', mockFetchSuccess(peerResponse));

    const registry = makePeerRegistry([
      { name: 'peer-D', url: 'https://peer-d.example.com', token: 'token-d' },
    ]);
    const fetcher = new PeerKeyFetcher(registry, new PeerKeyCache());

    const result = await fetcher.fetchForKeyId('key-we-want-but-nobody-has');

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // PKF-5: kill-switch prevents fetch entirely
  // -------------------------------------------------------------------------
  it('PKF-5: SUDO_FED_KEY_FETCH_DISABLE=1 returns null without calling fetch', async () => {
    process.env['SUDO_FED_KEY_FETCH_DISABLE'] = '1';

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const registry = makePeerRegistry([
      { name: 'peer-E', url: 'https://peer-e.example.com', token: 'token-e' },
    ]);
    const fetcher = new PeerKeyFetcher(registry, new PeerKeyCache());

    const result = await fetcher.fetchForKeyId('any-key-id');

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // PKF-7: attribution-forgery regression — malicious peer claims victim keyId with attacker pubkey
  // -------------------------------------------------------------------------
  it('PKF-7: malicious peer returns victim keyId with attacker publicKey → null (discarded)', async () => {
    const victimKeyId = 'aabbccdd';
    // Attacker publicKey: slice(24,32) === '11111111', NOT 'aabbccdd' — forged attribution.
    const attackerPublicKey = '302a300506032b65700321001111111122222222333333334444444455555555555555556666666666666666';
    // Verify our assumption: slice(24,32) on attackerPublicKey must NOT equal victimKeyId
    // '302a300506032b65700321001111111122222222...' → positions 24..31 = '11111111'

    const maliciousResponse: PeerPublicKeyResponse = {
      keyId: victimKeyId,
      keyVersion: 1,
      algorithm: 'ed25519',
      publicKey: attackerPublicKey,
      generatedAt: '2026-04-20T00:00:00Z',
    };

    vi.stubGlobal('fetch', mockFetchSuccess(maliciousResponse));

    const registry = makePeerRegistry([
      { name: 'malicious-peer', url: 'https://malicious.example.com', token: 'token-m' },
    ]);
    const cache = new PeerKeyCache();
    const fetcher = new PeerKeyFetcher(registry, cache);

    const result = await fetcher.fetchForKeyId(victimKeyId);

    // Must be discarded — mismatch between keyId claim and publicKey derivation
    expect(result).toBeNull();
    // Cache must remain empty — attacker pubkey must NOT be stored
    expect(cache.size()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // PKF-6: 5 concurrent calls coalesce to 1 fan-out per peer
  // -------------------------------------------------------------------------
  it('PKF-6: 5 concurrent calls for same keyId coalesce to 1 fan-out; all resolve same entry', async () => {
    // keyId must be 8 hex chars; publicKey.slice(24,32) must equal keyId.
    const targetKeyId = 'deadc0de';
    const targetPublicKey = '000000000000000000000000' + 'deadc0de' + '0'.repeat(56);

    let fetchCallCount = 0;

    // Simulates a slow-ish fetch to ensure all 5 calls arrive while in-flight
    const mockFetch = vi.fn().mockImplementation(async () => {
      fetchCallCount++;
      // Small delay so that all 5 callers enter fetchForKeyId before the fan-out resolves
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      return {
        ok: true,
        status: 200,
        json: async (): Promise<{ ok: boolean; data: PeerPublicKeyResponse }> => ({
          ok: true,
          data: {
            keyId: targetKeyId,
            keyVersion: 1,
            algorithm: 'ed25519',
            publicKey: targetPublicKey,
            generatedAt: '2026-04-20T00:00:00Z',
          },
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const registry = makePeerRegistry([
      { name: 'peer-F1', url: 'https://peer-f1.example.com', token: 'token-f1' },
      { name: 'peer-F2', url: 'https://peer-f2.example.com', token: 'token-f2' },
    ]);
    const fetcher = new PeerKeyFetcher(registry, new PeerKeyCache());

    // Fire 5 concurrent calls — none should be in cache, all should coalesce
    const results = await Promise.all([
      fetcher.fetchForKeyId(targetKeyId),
      fetcher.fetchForKeyId(targetKeyId),
      fetcher.fetchForKeyId(targetKeyId),
      fetcher.fetchForKeyId(targetKeyId),
      fetcher.fetchForKeyId(targetKeyId),
    ]);

    // All 5 results should be identical (same entry)
    for (const result of results) {
      expect(result).not.toBeNull();
      expect(result!.keyId).toBe(targetKeyId);
      expect(result!.publicKeyDerHex).toBe(targetPublicKey);
    }

    // Fetch should have been called once per peer (2 peers), NOT 5 times per peer
    // Total fetch calls = 2 (one fan-out with 2 peers), not 10 (5 fan-outs × 2 peers)
    expect(fetchCallCount).toBe(2);
  });
});
