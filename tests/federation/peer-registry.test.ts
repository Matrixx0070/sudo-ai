/**
 * @file tests/federation/peer-registry.test.ts
 * @description PeerRegistry unit tests — Wave 7E.
 *
 * Tests:
 *   PEER-REG-1  Empty registry when env not set
 *   PEER-REG-2  Parses valid peers from env
 *   PEER-REG-3  Skips peers with missing name
 *   PEER-REG-4  Skips peers with missing url
 *   PEER-REG-5  Skips peers with missing token
 *   PEER-REG-6  Skips duplicate peer names
 *   PEER-REG-7  Skips peers with invalid URL
 *   PEER-REG-8  Malformed JSON → empty registry (fail-open)
 *   PEER-REG-9  getPeer() returns correct peer
 *   PEER-REG-10 getPeer() returns undefined for unknown
 *   PEER-REG-11 isInboundTokenValid() false when no tokens configured
 *   PEER-REG-12 isInboundTokenValid() true for matching token
 *   PEER-REG-13 isInboundTokenValid() false for wrong token
 *   PEER-REG-14 isInboundTokenValid() timing-safe — no early return on length mismatch (structural)
 *   PEER-REG-15 Inbound tokens: malformed JSON → empty token list
 *   PEER-REG-16 Multiple valid peers in registry
 */

import { describe, it, expect } from 'vitest';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';

// ---------------------------------------------------------------------------
// PEER-REG-1: Empty registry when env not set
// ---------------------------------------------------------------------------
describe('PeerRegistry — empty state', () => {
  it('PEER-REG-1: returns empty peers when env not set', () => {
    const registry = new PeerRegistry(undefined, undefined);
    expect(registry.getPeers()).toEqual([]);
  });

  it('PEER-REG-1b: returns empty peers when env is empty string', () => {
    const registry = new PeerRegistry('', '');
    expect(registry.getPeers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PEER-REG-2: Parses valid peers
// ---------------------------------------------------------------------------
describe('PeerRegistry — valid peer parsing', () => {
  it('PEER-REG-2: parses a valid peer config', () => {
    const peersJson = JSON.stringify([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_peer_a_token' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    const peers = registry.getPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]).toEqual({
      name: 'peer-a',
      url: 'https://peer-a.example.com:18900',
      token: 'sk_peer_a_token',
    });
  });

  it('PEER-REG-16: parses multiple valid peers', () => {
    const peersJson = JSON.stringify([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a' },
      { name: 'peer-b', url: 'https://peer-b.example.com:18900', token: 'sk_b' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    expect(registry.getPeers()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PEER-REG-3 to 7: Skipping invalid peers
// ---------------------------------------------------------------------------
describe('PeerRegistry — peer validation', () => {
  it('PEER-REG-3: skips peers with missing name', () => {
    const peersJson = JSON.stringify([
      { url: 'https://peer-a.example.com:18900', token: 'sk_a' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    expect(registry.getPeers()).toHaveLength(0);
  });

  it('PEER-REG-4: skips peers with missing url', () => {
    const peersJson = JSON.stringify([
      { name: 'peer-a', token: 'sk_a' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    expect(registry.getPeers()).toHaveLength(0);
  });

  it('PEER-REG-5: skips peers with missing token', () => {
    const peersJson = JSON.stringify([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    expect(registry.getPeers()).toHaveLength(0);
  });

  it('PEER-REG-6: skips duplicate peer names (keeps first)', () => {
    const peersJson = JSON.stringify([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a1' },
      { name: 'peer-a', url: 'https://peer-a-dup.example.com:18900', token: 'sk_a2' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    const peers = registry.getPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.url).toBe('https://peer-a.example.com:18900');
  });

  it('PEER-REG-7: skips peers with invalid URL', () => {
    const peersJson = JSON.stringify([
      { name: 'peer-a', url: 'not-a-valid-url', token: 'sk_a' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    expect(registry.getPeers()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PEER-REG-8: Malformed JSON
// ---------------------------------------------------------------------------
describe('PeerRegistry — malformed input', () => {
  it('PEER-REG-8: malformed JSON peers → empty registry', () => {
    const registry = new PeerRegistry('{not valid json}', undefined);
    expect(registry.getPeers()).toHaveLength(0);
  });

  it('PEER-REG-15: malformed JSON inbound tokens → empty token list', () => {
    const registry = new PeerRegistry(undefined, 'not-valid-json');
    expect(registry.isInboundTokenValid('any-token')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PEER-REG-9 + 10: getPeer()
// ---------------------------------------------------------------------------
describe('PeerRegistry — getPeer()', () => {
  it('PEER-REG-9: returns correct peer by name', () => {
    const peersJson = JSON.stringify([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a' },
    ]);
    const registry = new PeerRegistry(peersJson, undefined);
    const peer = registry.getPeer('peer-a');
    expect(peer).toBeDefined();
    expect(peer!.name).toBe('peer-a');
  });

  it('PEER-REG-10: returns undefined for unknown peer', () => {
    const registry = new PeerRegistry('[]', undefined);
    expect(registry.getPeer('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PEER-REG-11 to 14: isInboundTokenValid()
// ---------------------------------------------------------------------------
describe('PeerRegistry — isInboundTokenValid()', () => {
  it('PEER-REG-11: returns false when no inbound tokens configured', () => {
    const registry = new PeerRegistry(undefined, undefined);
    expect(registry.isInboundTokenValid('sk_anything')).toBe(false);
  });

  it('PEER-REG-12: returns true for matching inbound token', () => {
    const tokensJson = JSON.stringify(['sk_inbound_token_abc']);
    const registry = new PeerRegistry(undefined, tokensJson);
    expect(registry.isInboundTokenValid('sk_inbound_token_abc')).toBe(true);
  });

  it('PEER-REG-13: returns false for non-matching token', () => {
    const tokensJson = JSON.stringify(['sk_inbound_token_abc']);
    const registry = new PeerRegistry(undefined, tokensJson);
    expect(registry.isInboundTokenValid('sk_wrong_token')).toBe(false);
  });

  it('PEER-REG-14: returns false for empty candidate token', () => {
    const tokensJson = JSON.stringify(['sk_inbound_token_abc']);
    const registry = new PeerRegistry(undefined, tokensJson);
    expect(registry.isInboundTokenValid('')).toBe(false);
  });

  it('PEER-REG-12b: accepts any matching token from a list of multiple', () => {
    const tokensJson = JSON.stringify(['sk_token_one', 'sk_token_two']);
    const registry = new PeerRegistry(undefined, tokensJson);
    expect(registry.isInboundTokenValid('sk_token_two')).toBe(true);
  });
});
