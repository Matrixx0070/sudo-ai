/**
 * @file ssrf-guard.ts
 * @description SSRF protection for browser navigation in SUDO-AI v4.
 *
 * Inspired by OpenClaw's SSRF protection that blocks navigation to private IP
 * ranges. Before any navigation, URLs are checked against blocked IP ranges to
 * prevent Server-Side Request Forgery attacks.
 *
 * Blocked ranges:
 *   - Private IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Loopback:    127.0.0.0/8
 *   - Link-local:  169.254.0.0/16
 *   - Metadata:    169.254.169.254 (cloud provider metadata endpoint)
 *   - IPv6 private: ::1, fc00::/7, fe80::/10
 *
 * An explicit allowlist can override blocks for specific hosts (e.g. localhost
 * during development).
 */

import { createLogger } from '../../../shared/logger.js';

const log = createLogger('browser:ssrf');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of an SSRF check — whether a URL/IP is allowed and why. */
export interface SSRFResult {
  allowed: boolean;
  reason?: string;
  resolvedIp?: string;
  category?: 'private' | 'link-local' | 'metadata' | 'loopback' | 'allowed';
}

/** Configuration for the SSRF guard. All blocks default to enabled. */
export interface SSRFConfig {
  allowedHosts: string[];
  blockPrivateRanges: boolean;
  blockMetadataEndpoints: boolean;
  blockLinkLocal: boolean;
  blockLoopback: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SSRFConfig = {
  allowedHosts: [],
  blockPrivateRanges: true,
  blockMetadataEndpoints: true,
  blockLinkLocal: true,
  blockLoopback: true,
};

// ---------------------------------------------------------------------------
// IPv4 numeric helpers
// ---------------------------------------------------------------------------

/** Convert dotted-quad IPv4 string to a 32-bit unsigned integer, or null. */
function ipv4ToUint32(ip: string): number | null {
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  let result = 0;
  for (const octet of octets) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0; // force unsigned
}

/** Precomputed blocked IPv4 ranges as [start, end] with labels. */
const IPV4_RANGES: {
  label: string;
  category: SSRFResult['category'];
  start: number;
  end: number;
}[] = [
  { label: '127.0.0.0/8',        category: 'loopback',   start: ipv4ToUint32('127.0.0.0')!,   end: ipv4ToUint32('127.255.255.255')! },
  { label: '10.0.0.0/8',        category: 'private',    start: ipv4ToUint32('10.0.0.0')!,    end: ipv4ToUint32('10.255.255.255')! },
  { label: '172.16.0.0/12',     category: 'private',    start: ipv4ToUint32('172.16.0.0')!,  end: ipv4ToUint32('172.31.255.255')! },
  { label: '192.168.0.0/16',    category: 'private',    start: ipv4ToUint32('192.168.0.0')!,  end: ipv4ToUint32('192.168.255.255')! },
  { label: '169.254.0.0/16',    category: 'link-local',  start: ipv4ToUint32('169.254.0.0')!, end: ipv4ToUint32('169.254.255.255')! },
  { label: '169.254.169.254/32', category: 'metadata',   start: ipv4ToUint32('169.254.169.254')!, end: ipv4ToUint32('169.254.169.254')! },
];

// ---------------------------------------------------------------------------
// SSRFGuard class
// ---------------------------------------------------------------------------

export class SSRFGuard {
  private config: SSRFConfig;
  private allowedHostsSet: Set<string>;
  private stats = {
    totalChecks: 0,
    blocked: 0,
    allowed: 0,
    byCategory: {} as Record<string, number>,
  };

  constructor(config?: Partial<SSRFConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.allowedHostsSet = new Set(this.config.allowedHosts);
    log.info(
      'SSRFGuard initialized (private=%s, linkLocal=%s, metadata=%s, loopback=%s)',
      this.config.blockPrivateRanges, this.config.blockLinkLocal,
      this.config.blockMetadataEndpoints, this.config.blockLoopback,
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Check whether a URL is safe to navigate to.
   * Parses the URL, resolves the hostname via DNS, then checks the resolved IP
   * against blocked ranges. If DNS resolution fails the request is blocked
   * (fail-closed) to prevent DNS rebinding attacks.
   */
  async checkUrl(url: string): Promise<SSRFResult> {
    this.stats.totalChecks++;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      const reason = `Invalid URL: ${url}`;
      log.warn({ url }, reason);
      return { allowed: false, reason };
    }

    const hostname = parsed.hostname;

    // Allowlist bypass — explicitly allowed hosts skip all checks.
    if (this.allowedHostsSet.has(hostname)) {
      this.stats.allowed++;
      this.bumpCategory('allowed');
      log.debug({ hostname }, 'Host on allowlist, skipping SSRF check');
      return { allowed: true, category: 'allowed' };
    }

    // DNS resolution so we check the *resolved* IP, not just the hostname
    // string. This prevents DNS rebinding tricks.
    let resolvedIp: string;
    try {
      const { lookup } = await import('dns/promises');
      const result = await lookup(hostname);
      resolvedIp = result.address;
    } catch {
      // Fail closed — if we cannot resolve, we cannot guarantee safety.
      const reason = `DNS resolution failed for ${hostname}`;
      log.warn({ hostname }, reason);
      this.stats.blocked++;
      this.bumpCategory('metadata');
      return { allowed: false, reason, category: 'metadata' };
    }

    const ipResult = this.checkIp(resolvedIp);
    if (!ipResult.allowed) {
      this.stats.blocked++;
      this.bumpCategory(ipResult.category!);
      log.warn({ url, resolvedIp, category: ipResult.category }, 'SSRF check blocked navigation');
      return { ...ipResult, resolvedIp };
    }

    this.stats.allowed++;
    this.bumpCategory('allowed');
    return { allowed: true, resolvedIp, category: 'allowed' };
  }

  /**
   * Check whether a raw IP address falls into any blocked range.
   * Works for both IPv4 and IPv6 addresses.
   */
  checkIp(ip: string): SSRFResult {
    // IPv4 path — numeric range comparison
    const v4 = ipv4ToUint32(ip);
    if (v4 !== null) {
      for (const range of IPV4_RANGES) {
        if (v4 < range.start || v4 > range.end) continue;
        if (range.category === 'loopback'  && !this.config.blockLoopback) continue;
        if (range.category === 'private'   && !this.config.blockPrivateRanges) continue;
        if (range.category === 'link-local' && !this.config.blockLinkLocal) continue;
        if (range.category === 'metadata'  && !this.config.blockMetadataEndpoints) continue;
        return {
          allowed: false,
          reason: `IP ${ip} falls in blocked range ${range.label} (${range.category})`,
          category: range.category,
        };
      }
      return { allowed: true, category: 'allowed' };
    }

    // IPv6 path
    const lower = ip.toLowerCase();

    // Loopback — ::1
    if (lower === '::1') {
      if (this.config.blockLoopback) {
        return { allowed: false, reason: 'IPv6 loopback address ::1', category: 'loopback' };
      }
      return { allowed: true, category: 'allowed' };
    }

    // Unique local — fc00::/7 (fc or fd prefix)
    if (lower.startsWith('fc') || lower.startsWith('fd')) {
      if (this.config.blockPrivateRanges) {
        return { allowed: false, reason: `IPv6 private address ${ip}`, category: 'private' };
      }
    }

    // Link-local — fe80::/10
    if (/^fe[89ab]/.test(lower)) {
      if (this.config.blockLinkLocal) {
        return { allowed: false, reason: `IPv6 link-local address ${ip}`, category: 'link-local' };
      }
    }

    return { allowed: true, category: 'allowed' };
  }

  // -----------------------------------------------------------------------
  // Allowlist management
  // -----------------------------------------------------------------------

  /** Add a host to the allowlist. */
  addAllowedHost(host: string): void {
    this.allowedHostsSet.add(host);
    if (!this.config.allowedHosts.includes(host)) {
      this.config.allowedHosts.push(host);
    }
    log.info({ host }, 'Host added to SSRF allowlist');
  }

  /** Remove a host from the allowlist. */
  removeAllowedHost(host: string): void {
    this.allowedHostsSet.delete(host);
    const idx = this.config.allowedHosts.indexOf(host);
    if (idx !== -1) this.config.allowedHosts.splice(idx, 1);
    log.info({ host }, 'Host removed from SSRF allowlist');
  }

  // -----------------------------------------------------------------------
  // IP classification helpers (public instance methods)
  // -----------------------------------------------------------------------

  /** Check if an IP is in a private range (10/8, 172.16/12, 192.168/16, fc00::/7). */
  isPrivateIp(ip: string): boolean {
    const v4 = ipv4ToUint32(ip);
    if (v4 !== null) {
      return IPV4_RANGES.filter((r) => r.category === 'private')
        .some((r) => v4 >= r.start && v4 <= r.end);
    }
    return /^f[cd]/i.test(ip);
  }

  /** Check if an IP is link-local (169.254.0.0/16, fe80::/10). */
  isLinkLocal(ip: string): boolean {
    const v4 = ipv4ToUint32(ip);
    if (v4 !== null) {
      return v4 >= ipv4ToUint32('169.254.0.0')! && v4 <= ipv4ToUint32('169.254.255.255')!;
    }
    return /^fe[89ab]/i.test(ip);
  }

  /** Check if an IP is the cloud metadata endpoint (169.254.169.254). */
  isMetadataEndpoint(ip: string): boolean {
    return ip === '169.254.169.254';
  }

  /** Check if an IP is loopback (127.0.0.0/8, ::1). */
  isLoopback(ip: string): boolean {
    const v4 = ipv4ToUint32(ip);
    if (v4 !== null) {
      return v4 >= ipv4ToUint32('127.0.0.0')! && v4 <= ipv4ToUint32('127.255.255.255')!;
    }
    return ip.toLowerCase() === '::1';
  }

  /** Return cumulative statistics for checks, blocks, and allows. */
  getStats(): { totalChecks: number; blocked: number; allowed: number; byCategory: Record<string, number> } {
    return {
      totalChecks: this.stats.totalChecks,
      blocked: this.stats.blocked,
      allowed: this.stats.allowed,
      byCategory: { ...this.stats.byCategory },
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private bumpCategory(category: string): void {
    this.stats.byCategory[category] = (this.stats.byCategory[category] ?? 0) + 1;
  }
}