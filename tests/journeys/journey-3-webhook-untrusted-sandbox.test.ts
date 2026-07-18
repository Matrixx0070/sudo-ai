/**
 * @file tests/journeys/journey-3-webhook-untrusted-sandbox.test.ts
 * @description GW-13 Journey 3 — inbound webhook → untrusted sandbox tier.
 *
 * A signed webhook turn is an external, non-owner caller. The journey asserts —
 * on the trust-tier resolver's DECISION (the auditable artifact), not by trying
 * to escape a real container — that such a turn is routed to the Docker backend
 * with a fail-closed egress posture, while owner/internal turns stay on host.
 * This is the blast-radius arithmetic (tool power × inbound access) made
 * testable: a prompt-injected webhook turn can never land on the host backend.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTrustTier,
  resolveUntrustedNetwork,
  isTierRoutingEnabled,
  UNTRUSTED_EXEC_BACKEND,
  type CallerLike,
} from '../../src/core/sandbox/trust-tier.js';

describe('GW-13 Journey 3 — webhook → untrusted sandbox tier', () => {
  it('an inbound webhook (non-owner) is untrusted → docker backend, no host network', () => {
    // The webhook bridge stamps the turn's caller from the channel boundary.
    const webhookCaller: CallerLike = { isOwner: false, channel: 'hook', peerId: 'wh:orders' };

    expect(isTierRoutingEnabled()).toBe(true); // default-on (kill-switch SUDO_SANDBOX_TIER_ROUTING=0)
    expect(classifyTrustTier(webhookCaller)).toBe('untrusted');
    expect(UNTRUSTED_EXEC_BACKEND).toBe('docker'); // never 'host'

    // No operator-configured egress → fail-closed: no network at all.
    expect(resolveUntrustedNetwork(webhookCaller)).toEqual({ network: 'none' });
  });

  it('operator-set egress allowlist graduates to enforced allowlist — still docker-only', () => {
    const webhookWithEgress: CallerLike = {
      isOwner: false,
      channel: 'hook',
      egress: { mode: 'allowlist', hosts: ['api.orders.example'] },
    };
    // The allowlist is set by the channel boundary from operator config, never
    // by the peer — and is strictly narrower than host networking.
    expect(classifyTrustTier(webhookWithEgress)).toBe('untrusted');
    expect(resolveUntrustedNetwork(webhookWithEgress)).toEqual({
      network: 'allowlist',
      hosts: ['api.orders.example'],
    });
  });

  it('owner and internal/scheduled turns stay host-tier (not forced into a container)', () => {
    expect(classifyTrustTier({ isOwner: true, channel: 'telegram' })).toBe('owner');
    // Absent caller = internal/autonomous turn — host-tier by design (fail-open
    // for the daemon's OWN work), never mistaken for untrusted.
    expect(classifyTrustTier(undefined)).toBe('owner');
    expect(classifyTrustTier({})).toBe('owner');
  });

  it('a peer cannot forge egress: a malformed egress value stays no-network', () => {
    const forged = { isOwner: false, channel: 'hook', egress: { mode: 'wide-open' } } as unknown as CallerLike;
    expect(resolveUntrustedNetwork(forged)).toEqual({ network: 'none' });
  });
});
