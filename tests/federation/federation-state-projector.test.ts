/**
 * @file tests/federation/federation-state-projector.test.ts
 * @description Gap #28d slice 3 — pure-function tests for the federation
 * state projector. The secret-redaction contract (PeerConfig.token does
 * NOT leak into FederationState.peers[].*) is the critical invariant.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  projectFederationState,
  type PeerRegistryRead,
  type AuditChainSyncRead,
  type FederationTokenPoolRead,
} from '../../src/core/federation/federation-state-projector.js';

describe('projectFederationState (#28d slice 3 redaction + aggregation)', () => {
  it('FP-01: no subsystems → enabled:false + honest zeros', () => {
    const state = projectFederationState({ instanceId: 'i0' });
    expect(state).toEqual({
      enabled: false,
      instanceId: 'i0',
      peers: [],
      audit: { inboundEventCount: 0, lastInboundTs: null, lastInboundIso: null },
      tokens: { totalCount: 0, activeCount: 0, byProvider: {} },
    });
  });

  it('FP-02: only peerRegistry (no auditChainSync) → enabled:false even with peers', () => {
    const peerRegistry: PeerRegistryRead = {
      getPeers: () => [{ name: 'a', url: 'https://a', token: 'tA' }],
    };
    const state = projectFederationState({ instanceId: 'i', peerRegistry });
    expect(state.enabled).toBe(false);
    expect(state.peers).toEqual([{ name: 'a', url: 'https://a' }]);
  });

  it('FP-03 (REDACTION CRITICAL): PeerConfig.token must not appear in the output', () => {
    const peerRegistry: PeerRegistryRead = {
      getPeers: () => [
        { name: 'peer-1', url: 'https://1', token: 'SECRET-TOKEN-1-DO-NOT-LEAK' },
        { name: 'peer-2', url: 'https://2', token: 'SECRET-TOKEN-2-DO-NOT-LEAK' },
      ],
    };
    const auditChainSync: AuditChainSyncRead = {
      getInboundEventCount: () => 0, getLastInboundTs: () => null,
    };
    const state = projectFederationState({ instanceId: 'i', peerRegistry, auditChainSync });
    // Type-level assertion: state.peers[number] has exactly {name, url}.
    expect(Object.keys(state.peers[0] ?? {}).sort()).toEqual(['name', 'url']);
    // Run-time assertion: serialized payload must not contain the secret.
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('SECRET-TOKEN-1');
    expect(serialized).not.toContain('SECRET-TOKEN-2');
    expect(serialized).not.toContain('"token"');
  });

  it('FP-04: enabled with peers + audit window populates correctly', () => {
    const peerRegistry: PeerRegistryRead = {
      getPeers: () => [{ name: 'p', url: 'https://p', token: 't' }],
    };
    const auditChainSync: AuditChainSyncRead = {
      getInboundEventCount: () => 17,
      getLastInboundTs: () => 1750000000000,
    };
    const state = projectFederationState({ instanceId: 'host-42', peerRegistry, auditChainSync });
    expect(state.enabled).toBe(true);
    expect(state.instanceId).toBe('host-42');
    expect(state.peers).toEqual([{ name: 'p', url: 'https://p' }]);
    expect(state.audit).toEqual({
      inboundEventCount: 17,
      lastInboundTs: 1750000000000,
      lastInboundIso: new Date(1750000000000).toISOString(),
    });
  });

  it('FP-05: AuditChainSync.getLastInboundTs() returning null leaves lastInboundIso null', () => {
    const peerRegistry: PeerRegistryRead = { getPeers: () => [] };
    const auditChainSync: AuditChainSyncRead = {
      getInboundEventCount: () => 5,
      getLastInboundTs: () => null,
    };
    const state = projectFederationState({ instanceId: 'i', peerRegistry, auditChainSync });
    expect(state.audit.lastInboundTs).toBeNull();
    expect(state.audit.lastInboundIso).toBeNull();
    expect(state.audit.inboundEventCount).toBe(5);
  });

  it('FP-06: FederationTokenPool active counts grouped by provider; inactive tokens excluded from byProvider', () => {
    const pool: FederationTokenPoolRead = {
      listTokens: () => [
        { active: true, provider: 'openai' },
        { active: true, provider: 'openai' },
        { active: true, provider: 'anthropic' },
        { active: false, provider: 'openai' }, // inactive — counts in totalCount only
      ],
    };
    const state = projectFederationState({ instanceId: 'i', federationTokenPool: pool });
    expect(state.tokens.totalCount).toBe(4);
    expect(state.tokens.activeCount).toBe(3);
    expect(state.tokens.byProvider).toEqual({ openai: 2, anthropic: 1 });
  });

  it('FP-07: AuditChainSync throw is caught + onError fires; audit stays zero', () => {
    const onError = vi.fn();
    const peerRegistry: PeerRegistryRead = { getPeers: () => [] };
    const auditChainSync: AuditChainSyncRead = {
      getInboundEventCount: () => { throw new Error('audit-boom'); },
      getLastInboundTs: () => 0,
    };
    const state = projectFederationState({ instanceId: 'i', peerRegistry, auditChainSync, onError });
    expect(state.audit).toEqual({ inboundEventCount: 0, lastInboundTs: null, lastInboundIso: null });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[1]).toBe('audit-chain-sync');
  });

  it('FP-08: FederationTokenPool throw is caught + onError fires; tokens stay zero', () => {
    const onError = vi.fn();
    const pool: FederationTokenPoolRead = {
      listTokens: () => { throw new Error('pool-boom'); },
    };
    const state = projectFederationState({ instanceId: 'i', federationTokenPool: pool, onError });
    expect(state.tokens).toEqual({ totalCount: 0, activeCount: 0, byProvider: {} });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[1]).toBe('federation-token-pool');
  });
});
