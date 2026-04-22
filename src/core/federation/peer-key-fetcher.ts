/**
 * @file core/federation/peer-key-fetcher.ts
 * @description Fetches federation peer public keys via GET /v1/federation/public-key.
 *
 * Fan-out: requests all known peers in parallel, first peer whose response matches
 * the requested keyId (active or retiring) wins. Concurrent requests for the same
 * keyId are coalesced via an in-flight Map.
 *
 * Kill-switch: SUDO_FED_KEY_FETCH_DISABLE=1 → return null without any network call.
 *
 * Wave 10H — Builder B1.
 */

import { createLogger } from '../shared/logger.js';
import type { PeerRegistry } from './peer-registry.js';
import type { PeerKeyCache, PeerKeyEntry } from './peer-key-cache.js';

const log = createLogger('federation:peer-key-fetcher');

const FETCH_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON body returned by GET /v1/federation/public-key on a peer.
 * Matches Wave 10G ArtifactSigner.getPublicKey() response + retiring extension.
 */
export interface PeerPublicKeyResponse {
  keyId: string;
  keyVersion: number;
  algorithm: string;
  /** DER-encoded public key as hex string. */
  publicKey: string;
  generatedAt: string;
  /** Present when the peer has a retiring key in the dual-verify window. */
  retiring?: {
    keyId: string;
    keyVersion: number;
    publicKey: string;
  };
}

// ---------------------------------------------------------------------------
// PeerKeyFetcher class
// ---------------------------------------------------------------------------

export class PeerKeyFetcher {
  private readonly registry: PeerRegistry;
  private readonly cache: PeerKeyCache;
  /** In-flight promises keyed by keyId — ensures concurrent callers coalesce. */
  private readonly _inflight: Map<string, Promise<PeerKeyEntry | null>> = new Map();

  constructor(registry: PeerRegistry, cache: PeerKeyCache) {
    this.registry = registry;
    this.cache = cache;
  }

  /**
   * Looks up keyId from cache first; on miss, fans out to all known peers.
   *
   * Concurrent calls for the same keyId are de-duplicated: only one network
   * fan-out runs at a time; all callers receive the same Promise.
   *
   * Returns null when:
   *   - Kill-switch SUDO_FED_KEY_FETCH_DISABLE=1
   *   - No peers configured
   *   - No peer responded with a matching keyId
   */
  fetchForKeyId(keyId: string): Promise<PeerKeyEntry | null> {
    // Kill-switch — must be first check
    if (process.env['SUDO_FED_KEY_FETCH_DISABLE'] === '1') {
      log.debug({ keyId }, 'fetchForKeyId: disabled via kill-switch');
      return Promise.resolve(null);
    }

    // Check cache before network
    const cached = this.cache.get(keyId);
    if (cached) {
      return Promise.resolve(cached);
    }

    // De-duplicate concurrent in-flight requests for the same keyId
    const existing = this._inflight.get(keyId);
    if (existing) {
      log.debug({ keyId }, 'fetchForKeyId: coalescing onto existing in-flight request');
      return existing;
    }

    // Create the fan-out promise, register it in _inflight, delete on settle
    const promise = this._fanOut(keyId);
    // Store a version that cleans up on settle so all callers get the same handle
    const tracked = promise.finally(() => {
      this._inflight.delete(keyId);
    });
    this._inflight.set(keyId, tracked);
    return tracked;
  }

  /**
   * Bypasses cache, evicts any stale entry for keyId, then re-fetches from peers.
   * Useful when ArtifactSigner.verify() gets an unknown keyId that may have been
   * populated via a key rotation since last cache fill.
   */
  async refetchForKeyId(keyId: string): Promise<PeerKeyEntry | null> {
    // Kill-switch — respect on refetch too
    if (process.env['SUDO_FED_KEY_FETCH_DISABLE'] === '1') {
      log.debug({ keyId }, 'refetchForKeyId: disabled via kill-switch');
      return null;
    }

    // Evict stale/existing entry so cache.set() in fan-out is treated as new
    this.cache.evict(keyId);

    // Re-use the same in-flight coalescing logic
    return this.fetchForKeyId(keyId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fans out GET /v1/federation/public-key to all peers in parallel.
   * Returns the first entry that matches keyId (active or retiring key).
   * Any individual peer failure is silently skipped.
   */
  private async _fanOut(keyId: string): Promise<PeerKeyEntry | null> {
    const peers = this.registry.getPeers();
    if (peers.length === 0) {
      log.debug({ keyId }, 'fetchForKeyId: no peers configured, returning null');
      return null;
    }

    log.debug({ keyId, peerCount: peers.length }, 'fetchForKeyId: fanning out to peers');

    // Fire all requests in parallel; allSettled so one failure doesn't abort others
    const results = await Promise.allSettled(
      peers.map(peer => this._fetchFromPeer(peer.url, peer.token)),
    );

    // Walk results in peer-array order; first match wins
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status !== 'fulfilled' || result.value === null) continue;

      const data = result.value;
      const peer = peers[i]!;
      let matchedPublicKey: string | null = null;

      if (data.keyId === keyId) {
        // HIGH-1: cross-validate that publicKey derives to the claimed keyId
        if (typeof data.publicKey !== 'string' || data.publicKey.slice(24, 32) !== data.keyId) {
          log.warn({ keyId, peerName: peer.name }, 'peer-key-fetcher: keyId/publicKey mismatch - discarding response');
          continue;
        }
        matchedPublicKey = data.publicKey;
      } else if (data.retiring && data.retiring.keyId === keyId) {
        // HIGH-1: cross-validate retiring publicKey derives to the claimed retiring keyId
        if (typeof data.retiring.publicKey !== 'string' || data.retiring.publicKey.slice(24, 32) !== data.retiring.keyId) {
          log.warn({ keyId, peerName: peer.name }, 'peer-key-fetcher: retiring keyId/publicKey mismatch - discarding');
          continue;
        }
        matchedPublicKey = data.retiring.publicKey;
      }

      if (matchedPublicKey !== null) {
        const entry: PeerKeyEntry = {
          keyId,
          publicKeyDerHex: matchedPublicKey,
          peerName: peer.name,
          fetchedAt: Date.now(),
        };
        this.cache.set(entry);
        log.debug({ keyId, peerName: peer.name }, 'fetchForKeyId: key found and cached');
        return entry;
      }
    }

    log.debug({ keyId }, 'fetchForKeyId: no peer matched keyId, returning null');
    return null;
  }

  /**
   * GETs /v1/federation/public-key from a single peer.
   * Returns the parsed PeerPublicKeyResponse on success, null on any failure.
   * Failures are silently swallowed — caller (fan-out) decides what to do.
   */
  private async _fetchFromPeer(
    peerUrl: string,
    peerToken: string,
  ): Promise<PeerPublicKeyResponse | null> {
    const url = `${peerUrl}/v1/federation/public-key`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${peerToken}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        log.debug({ url, status: response.status }, '_fetchFromPeer: non-200 response, skipping');
        return null;
      }

      const body = await response.json() as { ok?: boolean; data?: PeerPublicKeyResponse };

      if (!body.ok || !body.data || typeof body.data.keyId !== 'string') {
        log.debug({ url }, '_fetchFromPeer: unexpected response shape, skipping');
        return null;
      }

      return body.data;
    } catch (err) {
      // Network error, timeout, JSON parse failure — all non-fatal
      log.debug({ url, err: String(err) }, '_fetchFromPeer: fetch failed, skipping peer');
      return null;
    }
  }
}
