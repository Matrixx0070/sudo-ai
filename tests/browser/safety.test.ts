/**
 * Browser safety rails (Spec 3 step 5) — owner-only gating + domain allowlist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSessionOwner, sessionIsOwner, checkOwnerAllowed, domainAllowed, __resetSessionOwnersForTests,
} from '../../src/core/tools/builtin/browser/safety.js';
import type { BrowserProfileEntry } from '../../src/core/tools/builtin/browser/profile-registry.js';

const personal: BrowserProfileEntry = { name: 'personal', trust: 'high', ownerOnly: true, ephemeral: false, domainAllowlist: [] };
const work: BrowserProfileEntry = { name: 'work', trust: 'medium', ownerOnly: false, ephemeral: false, domainAllowlist: ['example.com'] };

beforeEach(() => __resetSessionOwnersForTests());

describe('owner-only gating', () => {
  it('DENIES an owner-only profile for a known non-owner session', () => {
    setSessionOwner('s1', false);
    const r = checkOwnerAllowed(personal, 's1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/owner-only/);
  });

  it('ALLOWS an owner-only profile for a known owner session', () => {
    setSessionOwner('s2', true);
    expect(checkOwnerAllowed(personal, 's2').allowed).toBe(true);
  });

  it('ALLOWS (with audit) when identity is unknown', () => {
    expect(sessionIsOwner('s-unknown')).toBeUndefined();
    expect(checkOwnerAllowed(personal, 's-unknown').allowed).toBe(true);
  });

  it('never blocks a non-owner-only profile', () => {
    setSessionOwner('s3', false);
    expect(checkOwnerAllowed(work, 's3').allowed).toBe(true);
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
