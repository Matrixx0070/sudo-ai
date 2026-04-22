/**
 * mcp-adapter-ssrf.test.ts — Wave 2.1 SSRF hardening tests for HTTPMCPAdapter.
 *
 * Covers new guard additions in Wave 2.1:
 *   - Explicit localhost hostname check (belt-and-suspenders, fires before regex)
 *   - Extended PRIVATE_IP_RE patterns: 0.0.0.0, ::ffff:127.*, ::ffff:0*.
 *   - SUDO_MCP_ALLOW_PRIVATE_HOSTS=1 escape hatch still bypasses ALL checks.
 *
 * Tests:
 *   1. http://localhost/              → throws (lowercase localhost)
 *   2. http://LOCALHOST/              → throws (case-insensitive localhost)
 *   3. http://0.0.0.0/               → throws (INADDR_ANY)
 *   4. http://[::ffff:127.0.0.1]/    → throws (IPv4-mapped IPv6 loopback)
 *   5. https://example.com/ + ALLOW  → allows (escape hatch, public host)
 *   6. http://localhost/ + ALLOW     → allows (escape hatch covers localhost)
 *
 * Total: 6 tests
 */

import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger — suppress noise
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { HTTPMCPAdapter } from '../../src/core/tools/mcp-adapter.js';

// ---------------------------------------------------------------------------
// Helper — build an adapter without the escape hatch set
// ---------------------------------------------------------------------------

function makeStrictAdapter(baseUrl: string) {
  return new HTTPMCPAdapter({ id: 'ssrf-strict', transport: 'http', baseUrl });
}

// ---------------------------------------------------------------------------
// Wave 2.1 SSRF hardening
// ---------------------------------------------------------------------------

describe('Wave 2.1 SSRF hardening', () => {
  afterEach(() => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    vi.restoreAllMocks();
  });

  it('1. http://localhost/ → throws (SSRF guard blocks lowercase localhost)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://localhost/')).toThrow(
      'localhost hostname not permitted',
    );
  });

  it('2. http://LOCALHOST/ → throws (case-insensitive localhost check)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://LOCALHOST/')).toThrow(
      'localhost hostname not permitted',
    );
  });

  it('3. http://0.0.0.0/ → throws (INADDR_ANY blocked by PRIVATE_IP_RE)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://0.0.0.0/')).toThrow('SSRF protection');
  });

  it('4. http://[::ffff:127.0.0.1]/ → throws (IPv4-mapped IPv6 loopback blocked)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[::ffff:127.0.0.1]/')).toThrow('SSRF protection');
  });

  it('5. https://example.com/ + SUDO_MCP_ALLOW_PRIVATE_HOSTS=1 → allows (escape hatch for public host)', () => {
    process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] = '1';
    expect(() =>
      new HTTPMCPAdapter({ id: 'pub-dev', transport: 'http', baseUrl: 'https://example.com/' }),
    ).not.toThrow();
  });

  it('6. http://localhost/ + SUDO_MCP_ALLOW_PRIVATE_HOSTS=1 → allows (escape hatch applies to localhost)', () => {
    process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'] = '1';
    expect(() => makeStrictAdapter('http://localhost/')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wave 2.2i — fe80::/10 link-local IPv6 SSRF gap
// ---------------------------------------------------------------------------

describe('SSRF guard: fe80::/10 link-local IPv6', () => {
  afterEach(() => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    vi.restoreAllMocks();
  });

  it('rejects fe80::1 link-local IPv6', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[fe80::1]')).toThrow(/private|loopback|SSRF|blocked/i);
  });

  it('rejects feab::1 link-local IPv6 (upper /10 bound)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[feab::1]')).toThrow(/private|loopback|SSRF|blocked/i);
  });

  it('rejects febf::1 link-local IPv6 (/10 boundary)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[febf::1]')).toThrow(/private|loopback|SSRF|blocked/i);
  });

  it('allows fec0::1 (outside fe80::/10 range)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[fec0::1]')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wave 2.2k — fc00::/7 ULA regex tightening + domain false-positive fix
// ---------------------------------------------------------------------------

describe('SSRF guard: fc00::/7 ULA tightening + domain false-positive fix', () => {
  afterEach(() => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    vi.restoreAllMocks();
  });

  // Should STILL block — valid ULA IPv6 addresses

  it('blocks fc00::1 canonical RFC-assigned ULA', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[fc00::1]')).toThrow(/private|loopback|SSRF|blocked/i);
  });

  it('blocks fd12:3456:789a:bcde::1 typical locally-assigned ULA', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[fd12:3456:789a:bcde::1]')).toThrow(
      /private|loopback|SSRF|blocked/i,
    );
  });

  it('blocks fd::1 abbreviated form', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[fd::1]')).toThrow(/private|loopback|SSRF|blocked/i);
  });

  // Should NOW ALLOW — domains starting with fd/fc were false-positives before the fix

  it('allows fdi.example.com (domain, not ULA)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://fdi.example.com')).not.toThrow();
  });

  it('allows fcc.gov (domain, not ULA)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://fcc.gov')).not.toThrow();
  });

  // Regression guard — confirm fe80::/10 pattern still active

  it('still blocks fe80::1 (fe80::/10 from W22i)', () => {
    delete process.env['SUDO_MCP_ALLOW_PRIVATE_HOSTS'];
    expect(() => makeStrictAdapter('http://[fe80::1]')).toThrow(/private|loopback|SSRF|blocked/i);
  });
});
