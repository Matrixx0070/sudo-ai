import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SSRFGuard } from '../../src/core/tools/builtin/browser/ssrf-guard.js';

// ---------------------------------------------------------------------------
// Mock dns/promises so checkUrl can resolve without a real DNS round-trip.
// ---------------------------------------------------------------------------
vi.mock('dns/promises', () => ({
  lookup: vi.fn((hostname: string) => {
    const records: Record<string, string> = {
      'google.com': '8.8.8.8',
      'internal.local': '10.0.0.1',
      'localhost': '127.0.0.1',
    };
    if (hostname === 'nulladdr.test') return Promise.resolve({ address: null, family: 4 }); // odd resolver
    if (hostname in records) return Promise.resolve({ address: records[hostname], family: 4 });
    return Promise.reject(new Error(`ENOTFOUND ${hostname}`));
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSRFGuard', () => {
  let guard: SSRFGuard;

  beforeEach(() => {
    guard = new SSRFGuard();
  });

  // -- Blocked IPs ----------------------------------------------------------

  it('blocks private IP 10.0.0.1', () => {
    const result = guard.checkIp('10.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('private');
  });

  it('blocks private IP 192.168.1.1', () => {
    const result = guard.checkIp('192.168.1.1');
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('private');
  });

  it('blocks loopback 127.0.0.1', () => {
    const result = guard.checkIp('127.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('loopback');
  });

  it('blocks metadata endpoint 169.254.169.254', () => {
    const result = guard.checkIp('169.254.169.254');
    expect(result.allowed).toBe(false);
    // 169.254.169.254 matches the 169.254.0.0/16 link-local range first
    expect(result.category).toBe('link-local');
  });

  it('blocks link-local 169.254.0.1', () => {
    const result = guard.checkIp('169.254.0.1');
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('link-local');
  });

  it('blocks private IP 172.16.0.1 (172.16/12 range)', () => {
    const result = guard.checkIp('172.16.0.1');
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('private');
  });

  it('blocks unresolvable hostname (fail-closed)', async () => {
    const result = await guard.checkUrl('https://nonexistent.invalid');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('DNS resolution failed');
  });

  // -- Allowed IPs / hostnames -----------------------------------------------

  it('allows public IP 8.8.8.8', () => {
    const result = guard.checkIp('8.8.8.8');
    expect(result.allowed).toBe(true);
    expect(result.category).toBe('allowed');
  });

  // -- Regression: null-split crash (browser.navigate TypeError, flywheel-surfaced) --

  it('a URL with no host (file:///, about:blank) fails closed without throwing', async () => {
    for (const url of ['file:///etc/passwd', 'about:blank']) {
      const result = await guard.checkUrl(url);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/no host/i);
    }
  });

  it('a resolver returning a null address fails closed (no null.split crash)', async () => {
    const result = await guard.checkUrl('https://nulladdr.test');
    expect(result.allowed).toBe(false); // fail closed, not a thrown TypeError
  });

  it('allows hostname google.com via checkUrl', async () => {
    const result = await guard.checkUrl('https://google.com');
    expect(result.allowed).toBe(true);
    expect(result.category).toBe('allowed');
    expect(result.resolvedIp).toBe('8.8.8.8');
  });

  // -- Allowlist bypass ------------------------------------------------------

  it('allowlist: configured hosts bypass blocks via checkUrl', async () => {
    const allowGuard = new SSRFGuard({ allowedHosts: ['internal.local'] });

    // Without allowlist, internal.local resolves to 10.0.0.1 which is private
    const blocked = await guard.checkUrl('https://internal.local');
    expect(blocked.allowed).toBe(false);

    // With allowlist, internal.local is permitted despite resolving to private IP
    const allowed = await allowGuard.checkUrl('https://internal.local');
    expect(allowed.allowed).toBe(true);
    expect(allowed.category).toBe('allowed');
  });

  // -- Stats tracking --------------------------------------------------------

  it('tracks check statistics via checkUrl', async () => {
    // checkIp does not update stats; only checkUrl does
    guard.checkIp('8.8.8.8');
    expect(guard.getStats().totalChecks).toBe(0);

    // checkUrl increments counters
    await guard.checkUrl('https://google.com');       // allowed
    await guard.checkUrl('https://internal.local');    // blocked (10.0.0.1)
    await guard.checkUrl('https://localhost');         // blocked (127.0.0.1)

    const stats = guard.getStats();
    expect(stats.totalChecks).toBe(3);
    expect(stats.allowed).toBe(1);
    expect(stats.blocked).toBe(2);
    expect(stats.byCategory['allowed']).toBe(1);
    expect(stats.byCategory['private']).toBe(1);
    expect(stats.byCategory['loopback']).toBe(1);
  });
});