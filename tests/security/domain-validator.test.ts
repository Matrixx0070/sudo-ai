/**
 * Unit tests for domain-validator.ts — Session 20 SSRF hardening.
 *
 * Adversarial coverage:
 * - IPv6 bracket notation bypass
 * - IPv4-mapped IPv6 in both dotted and hex-pair forms
 * - IPv6 link-local and unique-local prefixes
 * - CGNAT range 100.64.0.0/10
 * - Classic private IPv4 ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16)
 * - Cloud metadata hostnames (AWS IMDS, GCP, Azure)
 * - Internal domain suffix patterns (.internal, .local)
 * - Negative cases: legitimate public hosts must PASS
 * - Runtime permission map (setDomainPermission / getDomainPermission)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  validateDomain,
  setDomainPermission,
  getDomainPermission,
} from '../../src/core/security/domain-validator.js';
import {
  guardFetch,
  safeFetch,
  SSRFBlockedRedirectError,
} from '../../src/core/security/web-fetch-guard.js';

// ---------------------------------------------------------------------------
// IPv6 bracket bypass
// ---------------------------------------------------------------------------

describe('validateDomain — IPv6 bracket bypass', () => {
  it('blocks [::1] (IPv6 loopback with brackets)', () => {
    const r = validateDomain('[::1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks ::1 (IPv6 loopback without brackets)', () => {
    const r = validateDomain('::1');
    expect(r.allowed).toBe(false);
  });

  it('blocks [::]  (IPv6 unspecified with brackets)', () => {
    const r = validateDomain('[::]');
    expect(r.allowed).toBe(false);
  });

  it('blocks :: (IPv6 unspecified without brackets)', () => {
    const r = validateDomain('::');
    expect(r.allowed).toBe(false);
  });

  it('blocks 0:0:0:0:0:0:0:1 (full-form loopback)', () => {
    const r = validateDomain('0:0:0:0:0:0:0:1');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPv4-mapped IPv6 — dotted form (Node normalises before we see it, but we
// still handle it for direct validateDomain calls)
// ---------------------------------------------------------------------------

describe('validateDomain — IPv4-mapped IPv6 (dotted form)', () => {
  it('blocks [::ffff:127.0.0.1]', () => {
    const r = validateDomain('[::ffff:127.0.0.1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [::ffff:169.254.169.254]', () => {
    const r = validateDomain('[::ffff:169.254.169.254]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [::ffff:10.0.0.1]', () => {
    const r = validateDomain('[::ffff:10.0.0.1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [::ffff:192.168.1.1]', () => {
    const r = validateDomain('[::ffff:192.168.1.1]');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPv4-mapped IPv6 — hex-pair form (what Node 22 URL parser actually returns)
// ---------------------------------------------------------------------------

describe('validateDomain — IPv4-mapped IPv6 (hex-pair form from Node URL parser)', () => {
  it('blocks [::ffff:7f00:1] (= 127.0.0.1 as returned by new URL)', () => {
    // new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'
    const r = validateDomain('[::ffff:7f00:1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [::ffff:a9fe:a9fe] (= 169.254.169.254 AWS metadata)', () => {
    // new URL('http://[::ffff:169.254.169.254]/').hostname === '[::ffff:a9fe:a9fe]'
    const r = validateDomain('[::ffff:a9fe:a9fe]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [::ffff:c0a8:101] (= 192.168.1.1)', () => {
    // 0xc0a8 = 192.168, 0x0101 = 1.1
    const r = validateDomain('[::ffff:c0a8:101]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [::ffff:ac10:1] (= 172.16.0.1)', () => {
    // 0xac10 = 172.16, 0x0001 = 0.1
    const r = validateDomain('[::ffff:ac10:1]');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPv6 link-local and unique-local
// ---------------------------------------------------------------------------

describe('validateDomain — IPv6 link-local and unique-local', () => {
  it('blocks [fe80::1] (link-local with brackets)', () => {
    const r = validateDomain('[fe80::1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks fe80::1 (link-local without brackets)', () => {
    const r = validateDomain('fe80::1');
    expect(r.allowed).toBe(false);
  });

  it('blocks [fc00::1] (unique-local fc prefix)', () => {
    const r = validateDomain('[fc00::1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [fd00::1] (unique-local fd prefix)', () => {
    const r = validateDomain('[fd00::1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks [fd00:ec2::254] (AWS IPv6 metadata endpoint)', () => {
    const r = validateDomain('[fd00:ec2::254]');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CGNAT range 100.64.0.0/10
// ---------------------------------------------------------------------------

describe('validateDomain — CGNAT range 100.64.0.0/10', () => {
  it('blocks 100.64.0.1 (start of CGNAT range)', () => {
    // Derived from http://100.64.0.1/
    const r = validateDomain('100.64.0.1');
    expect(r.allowed).toBe(false);
  });

  it('blocks 100.64.1.1', () => {
    const r = validateDomain('100.64.1.1');
    expect(r.allowed).toBe(false);
  });

  it('blocks 100.127.255.255 (end of CGNAT range)', () => {
    const r = validateDomain('100.127.255.255');
    expect(r.allowed).toBe(false);
  });

  it('allows 100.128.0.1 (just outside CGNAT range)', () => {
    const r = validateDomain('100.128.0.1');
    expect(r.allowed).toBe(true);
  });

  it('allows 100.63.255.255 (just below CGNAT range)', () => {
    const r = validateDomain('100.63.255.255');
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classic private IPv4 ranges
// ---------------------------------------------------------------------------

describe('validateDomain — private IPv4 ranges', () => {
  it('blocks 127.0.0.1 (loopback)', () => {
    const r = validateDomain('127.0.0.1');
    expect(r.allowed).toBe(false);
  });

  it('blocks 127.255.255.255 (loopback range end)', () => {
    const r = validateDomain('127.255.255.255');
    expect(r.allowed).toBe(false);
  });

  it('blocks 10.0.0.1 (RFC1918 Class A)', () => {
    const r = validateDomain('10.0.0.1');
    expect(r.allowed).toBe(false);
  });

  it('blocks 10.255.255.255', () => {
    const r = validateDomain('10.255.255.255');
    expect(r.allowed).toBe(false);
  });

  it('blocks 172.16.0.1 (RFC1918 Class B start)', () => {
    const r = validateDomain('172.16.0.1');
    expect(r.allowed).toBe(false);
  });

  it('blocks 172.31.255.255 (RFC1918 Class B end)', () => {
    const r = validateDomain('172.31.255.255');
    expect(r.allowed).toBe(false);
  });

  it('allows 172.15.255.255 (just below RFC1918 Class B)', () => {
    const r = validateDomain('172.15.255.255');
    expect(r.allowed).toBe(true);
  });

  it('allows 172.32.0.0 (just above RFC1918 Class B)', () => {
    const r = validateDomain('172.32.0.0');
    expect(r.allowed).toBe(true);
  });

  it('blocks 192.168.0.1 (RFC1918 Class C)', () => {
    const r = validateDomain('192.168.0.1');
    expect(r.allowed).toBe(false);
  });

  it('blocks 192.168.255.255', () => {
    const r = validateDomain('192.168.255.255');
    expect(r.allowed).toBe(false);
  });

  it('blocks 169.254.169.254 (AWS/GCP/Azure IMDS)', () => {
    const r = validateDomain('169.254.169.254');
    expect(r.allowed).toBe(false);
  });

  it('blocks 169.254.0.1 (link-local range)', () => {
    const r = validateDomain('169.254.0.1');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cloud metadata hostnames
// ---------------------------------------------------------------------------

describe('validateDomain — cloud metadata hostnames', () => {
  it('blocks metadata.google.internal', () => {
    const r = validateDomain('metadata.google.internal');
    expect(r.allowed).toBe(false);
  });

  it('blocks metadata.goog', () => {
    const r = validateDomain('metadata.goog');
    expect(r.allowed).toBe(false);
  });

  it('blocks metadata.azure.com', () => {
    const r = validateDomain('metadata.azure.com');
    expect(r.allowed).toBe(false);
  });

  it('blocks localhost', () => {
    const r = validateDomain('localhost');
    expect(r.allowed).toBe(false);
  });

  it('blocks 0.0.0.0', () => {
    const r = validateDomain('0.0.0.0');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Internal domain suffix patterns
// ---------------------------------------------------------------------------

describe('validateDomain — internal domain suffixes', () => {
  it('blocks foo.internal', () => {
    const r = validateDomain('foo.internal');
    expect(r.allowed).toBe(false);
  });

  it('blocks service.cluster.local', () => {
    const r = validateDomain('service.cluster.local');
    expect(r.allowed).toBe(false);
  });

  it('blocks api.corp.example', () => {
    const r = validateDomain('api.corp.example');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Negative cases — legitimate public hosts MUST pass
// ---------------------------------------------------------------------------

describe('validateDomain — public hosts allowed (negative / allow cases)', () => {
  it('allows api.openai.com', () => {
    const r = validateDomain('api.openai.com');
    expect(r.allowed).toBe(true);
  });

  it('allows api.x.ai', () => {
    const r = validateDomain('api.x.ai');
    expect(r.allowed).toBe(true);
  });

  it('allows sudoapi.shop', () => {
    const r = validateDomain('sudoapi.shop');
    expect(r.allowed).toBe(true);
  });

  it('allows api.anthropic.com', () => {
    const r = validateDomain('api.anthropic.com');
    expect(r.allowed).toBe(true);
  });

  it('allows github.com', () => {
    const r = validateDomain('github.com');
    expect(r.allowed).toBe(true);
  });

  it('allows 8.8.8.8 (Google public DNS — not a private address)', () => {
    const r = validateDomain('8.8.8.8');
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// guardFetch / safeFetch integration (via URL parsing)
// ---------------------------------------------------------------------------

describe('validateDomain — URL hostname integration (what guardFetch passes)', () => {
  it('blocks the hostname that Node URL parser returns for http://[::1]/', () => {
    // new URL('http://[::1]/').hostname === '[::1]'
    const r = validateDomain(new URL('http://[::1]/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks the hostname that Node URL parser returns for http://[::ffff:a9fe:a9fe]/', () => {
    const r = validateDomain(new URL('http://[::ffff:169.254.169.254]/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks the hostname that Node URL parser returns for http://[::ffff:127.0.0.1]/', () => {
    // Node normalises to [::ffff:7f00:1]
    const r = validateDomain(new URL('http://[::ffff:127.0.0.1]/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks the hostname that Node URL parser returns for http://[fe80::1]/', () => {
    const r = validateDomain(new URL('http://[fe80::1]/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks the hostname that Node URL parser returns for http://[fd00:ec2::254]/', () => {
    const r = validateDomain(new URL('http://[fd00:ec2::254]/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks the hostname from http://metadata.google.internal/', () => {
    const r = validateDomain(new URL('http://metadata.google.internal/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks the hostname from http://100.64.1.1/', () => {
    const r = validateDomain(new URL('http://100.64.1.1/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks the hostname from http://100.127.255.255/', () => {
    const r = validateDomain(new URL('http://100.127.255.255/').hostname);
    expect(r.allowed).toBe(false);
  });

  it('allows the hostname from https://api.openai.com/', () => {
    const r = validateDomain(new URL('https://api.openai.com/').hostname);
    expect(r.allowed).toBe(true);
  });

  it('allows the hostname from https://sudoapi.shop/v1/chat', () => {
    const r = validateDomain(new URL('https://sudoapi.shop/v1/chat').hostname);
    expect(r.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runtime permission map
// ---------------------------------------------------------------------------

describe('setDomainPermission / getDomainPermission', () => {
  it('defaults to allow when no permission is set', () => {
    expect(getDomainPermission('newdomain.example.com')).toBe('allow');
  });

  it('getDomainPermission returns set value', () => {
    setDomainPermission('blocked.example.com', 'deny');
    expect(getDomainPermission('blocked.example.com')).toBe('deny');
  });

  it('validateDomain respects deny policy', () => {
    setDomainPermission('custom-blocked.example.com', 'deny');
    const r = validateDomain('custom-blocked.example.com');
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('denied by user policy');
  });

  it('validateDomain allows when permission is allow', () => {
    setDomainPermission('custom-allowed.example.com', 'allow');
    const r = validateDomain('custom-allowed.example.com');
    expect(r.allowed).toBe(true);
  });

  it('ignores invalid domain in setDomainPermission', () => {
    // Should not throw
    setDomainPermission('', 'deny');
    expect(getDomainPermission('')).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('validateDomain — edge cases', () => {
  it('rejects empty string', () => {
    const r = validateDomain('');
    expect(r.allowed).toBe(false);
  });

  it('rejects null-like via type coercion guard', () => {
    // @ts-expect-error testing runtime guard
    const r = validateDomain(null);
    expect(r.allowed).toBe(false);
  });

  it('handles whitespace trimming', () => {
    const r = validateDomain('  localhost  ');
    expect(r.allowed).toBe(false);
  });

  it('is case-insensitive for hostnames', () => {
    const r = validateDomain('LOCALHOST');
    expect(r.allowed).toBe(false);
  });

  it('is case-insensitive for metadata.GOOGLE.internal', () => {
    const r = validateDomain('metadata.GOOGLE.internal');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trailing-dot FQDN bypass (HIGH — Security Round 2)
// ---------------------------------------------------------------------------

describe('validateDomain — trailing-dot FQDN bypass', () => {
  it('blocks http://localhost./ hostname (localhost.)', () => {
    const hostname = new URL('http://localhost./').hostname;
    const r = validateDomain(hostname);
    expect(r.allowed).toBe(false);
  });

  it('blocks localhost. directly', () => {
    const r = validateDomain('localhost.');
    expect(r.allowed).toBe(false);
  });

  it('blocks metadata.google.internal. (trailing dot)', () => {
    const r = validateDomain('metadata.google.internal.');
    expect(r.allowed).toBe(false);
  });

  it('blocks metadata.goog. (trailing dot)', () => {
    const r = validateDomain('metadata.goog.');
    expect(r.allowed).toBe(false);
  });

  it('blocks metadata.azure.com. (trailing dot)', () => {
    const r = validateDomain('metadata.azure.com.');
    expect(r.allowed).toBe(false);
  });

  it('blocks foo.internal. (trailing dot on .internal suffix)', () => {
    const r = validateDomain('foo.internal.');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zero-padded IPv6 bypass (LOW — Security Round 2)
// ---------------------------------------------------------------------------

describe('validateDomain — zero-padded IPv6', () => {
  it('blocks [0000:0000:0000:0000:0000:0000:0000:0001] (zero-padded loopback)', () => {
    const r = validateDomain('[0000:0000:0000:0000:0000:0000:0000:0001]');
    expect(r.allowed).toBe(false);
  });

  it('blocks 0000:0000:0000:0000:0000:0000:0000:0001 without brackets', () => {
    const r = validateDomain('0000:0000:0000:0000:0000:0000:0000:0001');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Embedded IPv4 without ::ffff: prefix (LOW — Security Round 2)
// ---------------------------------------------------------------------------

describe('validateDomain — embedded IPv4 without ::ffff: prefix', () => {
  it('blocks [::0.0.0.1] (bare embedded IPv4 loopback, equals ::1)', () => {
    const r = validateDomain('[::0.0.0.1]');
    expect(r.allowed).toBe(false);
  });

  it('blocks ::0.0.0.1 without brackets', () => {
    const r = validateDomain('::0.0.0.1');
    expect(r.allowed).toBe(false);
  });

  it('blocks ::127.0.0.1 (bare embedded IPv4 127.x loopback)', () => {
    const r = validateDomain('::127.0.0.1');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safeFetch redirect re-validation (MEDIUM — Security Round 2)
// ---------------------------------------------------------------------------

describe('safeFetch — redirect re-validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws SSRFBlockedRedirectError when 302 Location points to SSRF target', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    ));

    const err = await safeFetch('https://api.example.com/redirect').catch(e => e);
    expect(err).toBeInstanceOf(SSRFBlockedRedirectError);
    expect(err.message).toContain('169.254.169.254');
  });

  it('follows a relative redirect on an allowed host', async () => {
    const finalResponse = new Response('OK', { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: '/admin' },
          }),
        )
        .mockResolvedValueOnce(finalResponse),
    );

    const result = await safeFetch('https://api.example.com/start');
    expect(result.status).toBe(200);
  });

  it('throws when more than 5 redirects occur', async () => {
    const redirect302 = new Response(null, {
      status: 302,
      headers: { location: 'https://api.example.com/loop' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(redirect302));

    await expect(safeFetch('https://api.example.com/loop')).rejects.toThrow(
      'Too many redirects',
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-trailing-dot bypass (HIGH — Security Round 3)
// ---------------------------------------------------------------------------

describe('validateDomain — multi-trailing-dot bypass', () => {
  it('blocks localhost... (triple trailing dot)', () => {
    expect(validateDomain('localhost...').allowed).toBe(false);
  });

  it('blocks metadata.google.internal... (triple trailing dot)', () => {
    expect(validateDomain('metadata.google.internal...').allowed).toBe(false);
  });

  it('blocks foo.internal... (suffix bypass via triple dot)', () => {
    expect(validateDomain('foo.internal...').allowed).toBe(false);
  });

  it('blocks localhost....................... (30 trailing dots)', () => {
    expect(validateDomain('localhost' + '.'.repeat(30)).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// guardFetch multi-trailing-dot bypass (HIGH — Security Round 3)
// ---------------------------------------------------------------------------

describe('guardFetch — multi-trailing-dot bypass', () => {
  it('guardFetch blocks http://localhost.../ (triple trailing dot in URL hostname)', () => {
    const r = guardFetch('http://localhost.../');
    expect(r.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPv6 unspecified full form (LOW — Security Round 3, defense-in-depth)
// ---------------------------------------------------------------------------

describe('validateDomain — IPv6 unspecified full form', () => {
  it('blocks 0:0:0:0:0:0:0:0 (IPv6 unspecified full form)', () => {
    expect(validateDomain('0:0:0:0:0:0:0:0').allowed).toBe(false);
  });
});
