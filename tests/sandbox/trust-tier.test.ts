/**
 * Trust-tier classification + routing gate (Feature 8).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  classifyTrustTier,
  isTierRoutingEnabled,
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
