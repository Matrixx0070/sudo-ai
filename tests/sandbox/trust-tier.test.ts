/**
 * Trust-tier classification + routing gate (Feature 8).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  classifyTrustTier,
  isTierRoutingEnabled,
  resolveUntrustedNetwork,
  UNTRUSTED_EXEC_BACKEND,
} from '../../src/core/sandbox/trust-tier.js';

afterEach(() => {
  delete process.env['SUDO_SANDBOX_TIER_ROUTING'];
});

describe('classifyTrustTier', () => {
  it('owner caller → owner tier (host backend)', () => {
    expect(classifyTrustTier({ isOwner: true, channel: 'web' })).toBe('owner');
  });

  it('explicit non-owner caller → untrusted (hook/email/community)', () => {
    expect(classifyTrustTier({ isOwner: false, channel: 'hook' })).toBe('untrusted');
    expect(classifyTrustTier({ isOwner: false, channel: 'email', peerId: 't1' })).toBe('untrusted');
  });

  it('undefined caller (internal/autonomous turn) → owner tier, NOT untrusted', () => {
    // Critical: background/scheduled/consciousness turns have no caller and must
    // stay on the host — never forced into a container.
    expect(classifyTrustTier(undefined)).toBe('owner');
  });

  it('caller present but isOwner undefined → owner tier (fail-open for internal)', () => {
    expect(classifyTrustTier({ channel: 'system' })).toBe('owner');
  });

  it('the untrusted backend is docker', () => {
    expect(UNTRUSTED_EXEC_BACKEND).toBe('docker');
  });
});

describe('isTierRoutingEnabled', () => {
  it('default ON', () => {
    expect(isTierRoutingEnabled()).toBe(true);
  });
  it('kill-switch SUDO_SANDBOX_TIER_ROUTING=0 disables it', () => {
    process.env['SUDO_SANDBOX_TIER_ROUTING'] = '0';
    expect(isTierRoutingEnabled()).toBe(false);
  });
  it('any other value keeps it ON', () => {
    process.env['SUDO_SANDBOX_TIER_ROUTING'] = '1';
    expect(isTierRoutingEnabled()).toBe(true);
  });
});

describe('resolveUntrustedNetwork (per-hook egress opt-in)', () => {
  it('no caller / no egress → none', () => {
    expect(resolveUntrustedNetwork(undefined)).toEqual({ network: 'none' });
    expect(resolveUntrustedNetwork({ isOwner: false, channel: 'hook' })).toEqual({ network: 'none' });
  });

  it('allowlist opt-in with hosts', () => {
    expect(
      resolveUntrustedNetwork({ isOwner: false, egress: { mode: 'allowlist', hosts: ['api.example.com', ''] } }),
    ).toEqual({ network: 'allowlist', hosts: ['api.example.com'] });
  });

  it('allowlist opt-in without hosts → allowlist with defaults (no hosts key)', () => {
    expect(resolveUntrustedNetwork({ isOwner: false, egress: { mode: 'allowlist' } })).toEqual({
      network: 'allowlist',
    });
  });

  it("malformed egress can never widen — 'host'/junk modes → none", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveUntrustedNetwork({ isOwner: false, egress: { mode: 'host' } as any })).toEqual({ network: 'none' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveUntrustedNetwork({ isOwner: false, egress: 'allowlist' as any })).toEqual({ network: 'none' });
  });
});
