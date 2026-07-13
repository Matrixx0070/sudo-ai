/**
 * Browser safety rails (Spec 3 step 5) — owner-only gating + domain allowlist.
 */
import { describe, it, expect } from 'vitest';
import {
  checkOwnerAllowed, domainAllowed,
} from '../../src/core/tools/builtin/browser/safety.js';
import type { BrowserProfileEntry } from '../../src/core/tools/builtin/browser/profile-registry.js';

const personal: BrowserProfileEntry = { name: 'personal', trust: 'high', ownerOnly: true, ephemeral: false, domainAllowlist: [] };
const work: BrowserProfileEntry = { name: 'work', trust: 'medium', ownerOnly: false, ephemeral: false, domainAllowlist: ['example.com'] };

describe('owner-only gating (from resolved ctx.isOwner)', () => {
  it('DENIES an owner-only profile for a known non-owner (isOwner=false)', () => {
    const r = checkOwnerAllowed(personal, false, 's1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/owner-only/);
  });

  it('ALLOWS an owner-only profile for a known owner (isOwner=true)', () => {
    expect(checkOwnerAllowed(personal, true, 's2').allowed).toBe(true);
  });

  it('ALLOWS (with audit) when identity is unknown (internal/autonomous turn)', () => {
    expect(checkOwnerAllowed(personal, undefined, 's3').allowed).toBe(true);
  });

  it('never blocks a non-owner-only profile even for a non-owner', () => {
    expect(checkOwnerAllowed(work, false, 's4').allowed).toBe(true);
  });
});

describe('domain allowlist', () => {
  it('no allowlist → everything allowed', () => {
    expect(domainAllowed(personal, 'https://anything.example.org/x')).toBe(true);
  });
  it('allowlist matches exact host + subdomains, rejects others', () => {
    expect(domainAllowed(work, 'https://example.com/login')).toBe(true);
    expect(domainAllowed(work, 'https://mail.example.com/')).toBe(true);
    expect(domainAllowed(work, 'https://evil.com/')).toBe(false);
    expect(domainAllowed(work, 'https://notexample.com/')).toBe(false); // suffix guard: not a subdomain
  });
  it('malformed url → rejected when an allowlist is set', () => {
    expect(domainAllowed(work, 'not a url')).toBe(false);
  });
});
