/**
 * Unit tests for ssrf-dns-pin.ts — P0 #2 (DNS pinning / anti-rebinding).
 *
 * pinnedLookup is undici's connect.lookup: the single point where a request's
 * socket learns its destination. It must resolve, validate EVERY resolved
 * address, fail closed on any blocked address (including a mixed public+private
 * rebind answer), and otherwise return the validated addresses so undici dials
 * them with no second resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LookupAddress } from 'node:dns';

// Mock node:dns so we control what the hostname resolves to.
const dnsResult: { err: Error | null; addrs: LookupAddress[] } = { err: null, addrs: [] };
vi.mock('node:dns', () => ({
  lookup: (
    _hostname: string,
    _opts: unknown,
    cb: (err: Error | null, addrs: LookupAddress[]) => void,
  ) => cb(dnsResult.err, dnsResult.addrs),
}));

import { pinnedLookup, isDnsPinningEnabled, SSRFBlockedAddressError } from '../../src/core/security/ssrf-dns-pin.js';

/** Drive pinnedLookup and capture its callback synchronously (mock dns is sync). */
function runLookup(all: boolean): { err: Error | null; address: unknown; family?: number } {
  let captured: { err: Error | null; address: unknown; family?: number } = { err: null, address: undefined };
  pinnedLookup('host.example', { all } as never, ((err, address, family) => {
    captured = { err, address, family };
  }) as never);
  return captured;
}

describe('ssrf-dns-pin: pinnedLookup', () => {
  beforeEach(() => {
    dnsResult.err = null;
    dnsResult.addrs = [];
  });

  it('passes a hostname that resolves only to public addresses (pinned)', () => {
    dnsResult.addrs = [{ address: '93.184.216.34', family: 4 }];
    const out = runLookup(false);
    expect(out.err).toBeNull();
    expect(out.address).toBe('93.184.216.34');
    expect(out.family).toBe(4);
  });

  it('fails closed when the hostname resolves to the cloud-metadata IP', () => {
    dnsResult.addrs = [{ address: '169.254.169.254', family: 4 }];
    const out = runLookup(false);
    expect(out.err).toBeInstanceOf(SSRFBlockedAddressError);
    expect(out.address).toBe('');
  });

  it('fails closed when the hostname resolves to a private range', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1']) {
      dnsResult.addrs = [{ address: ip, family: 4 }];
      expect(runLookup(false).err).toBeInstanceOf(SSRFBlockedAddressError);
    }
  });

  it('rejects a rebind answer that mixes a public and a private address (no sibling connect)', () => {
    // Attacker returns one allowed and one blocked address; we must NOT connect
    // to the public sibling and silently accept — the whole lookup fails.
    dnsResult.addrs = [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    const out = runLookup(true);
    expect(out.err).toBeInstanceOf(SSRFBlockedAddressError);
  });

  it('returns the full validated set when options.all is true', () => {
    dnsResult.addrs = [
      { address: '93.184.216.34', family: 4 },
      { address: '151.101.1.140', family: 4 },
    ];
    const out = runLookup(true);
    expect(out.err).toBeNull();
    expect(out.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '151.101.1.140', family: 4 },
    ]);
  });

  it('fails closed on a resolution error', () => {
    dnsResult.err = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const out = runLookup(false);
    expect(out.err).toBeTruthy();
    expect(out.err?.message).toContain('ENOTFOUND');
  });

  it('fails closed when nothing resolves', () => {
    dnsResult.addrs = [];
    expect(runLookup(false).err).toBeInstanceOf(SSRFBlockedAddressError);
  });
});

describe('ssrf-dns-pin: isDnsPinningEnabled', () => {
  const prev = process.env['SUDO_SSRF_DNS_PIN'];
  afterEach(() => {
    if (prev === undefined) delete process.env['SUDO_SSRF_DNS_PIN'];
    else process.env['SUDO_SSRF_DNS_PIN'] = prev;
  });

  it('is on by default', () => {
    delete process.env['SUDO_SSRF_DNS_PIN'];
    expect(isDnsPinningEnabled()).toBe(true);
  });

  it('is off only when explicitly set to 0', () => {
    process.env['SUDO_SSRF_DNS_PIN'] = '0';
    expect(isDnsPinningEnabled()).toBe(false);
    process.env['SUDO_SSRF_DNS_PIN'] = '1';
    expect(isDnsPinningEnabled()).toBe(true);
  });
});
