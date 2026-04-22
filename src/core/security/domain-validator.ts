/**
 * @file domain-validator.ts
 * @description Upgrade 46 — Domain fetch validation.
 *
 * Blocks requests to internal/private IP ranges and cloud metadata endpoints.
 * Supports per-domain allow/deny/ask permission overrides at runtime.
 *
 * Session 20 — SSRF hardening: added full IPv6 bracket stripping, IPv4-mapped
 * IPv6 recursive check (both dotted and hex-pair forms), CGNAT 100.64.0.0/10,
 * IPv6 link-local (fe80::/10) and unique-local (fc00::/7, fd00::/8), plus
 * additional cloud metadata hostnames (metadata.goog, fd00:ec2::254).
 *
 * Session 21 — Round 2 SSRF fixes: trailing-dot FQDN bypass fixed in both
 * isBlockedHost and validateDomain, zero-padded IPv6 normalization, embedded
 * IPv4 without ::ffff: prefix detection (e.g. ::0.0.0.1 = ::1).
 *
 * Session 22 — Round 3 SSRF fixes: multi-trailing-dot bypass (localhost...,
 * metadata.google.internal...) fixed by changing /\.$/ to /\.+$/ in both
 * strip sites; added '0:0:0:0:0:0:0:0' to BLOCKED_EXACT_HOSTS for defense-in-depth.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('security:domain');

// ---------------------------------------------------------------------------
// Blocked hostname strings (exact match, case-insensitive after stripping)
// ---------------------------------------------------------------------------

/**
 * Cloud metadata endpoints and loopback addresses blocked by exact hostname
 * string match. Brackets are stripped before comparison.
 */
const BLOCKED_EXACT_HOSTS = new Set<string>([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',            // AWS / Azure / GCP IMDS (IPv4)
  'metadata.google.internal',   // GCP metadata
  'metadata.goog',              // GCP metadata alternate
  'metadata.azure.com',         // Azure metadata
  '::1',                        // IPv6 loopback
  '::',                         // IPv6 unspecified
  '0:0:0:0:0:0:0:1',           // IPv6 loopback (full form)
  '0:0:0:0:0:0:0:0',           // IPv6 unspecified (full form) — defense-in-depth
]);

// ---------------------------------------------------------------------------
// Domain suffix patterns (broader than IP checks; catch internal TLDs)
// ---------------------------------------------------------------------------

const BLOCKED_SUFFIX_PATTERNS: RegExp[] = [
  /\.internal$/,
  /\.local$/,
  /\.corp\./,
];

// ---------------------------------------------------------------------------
// IPv6 / IPv4-mapped helpers (ported from approval/allowlist.ts, no shared dep)
// ---------------------------------------------------------------------------

/**
 * Converts an IPv6 hex-pair representation (e.g. "a9fe:a9fe") to
 * dotted-decimal IPv4 (e.g. "169.254.169.254").
 * Returns null if the input is not exactly two colon-separated hex words.
 */
function hexPairsToDotted(s: string): string | null {
  const parts = s.split(':');
  if (parts.length !== 2) return null;
  try {
    const n1 = parseInt(parts[0]!, 16);
    const n2 = parseInt(parts[1]!, 16);
    if (
      !Number.isFinite(n1) || !Number.isFinite(n2) ||
      n1 < 0 || n1 > 0xffff || n2 < 0 || n2 > 0xffff
    ) return null;
    const b1 = (n1 >> 8) & 0xff;
    const b2 = n1 & 0xff;
    const b3 = (n2 >> 8) & 0xff;
    const b4 = n2 & 0xff;
    return `${b1}.${b2}.${b3}.${b4}`;
  } catch {
    return null;
  }
}

/**
 * Returns true if the hostname is a blocked IP address or known cloud metadata
 * endpoint. Handles all of:
 *   - IPv6 bracket notation ([::1] → ::1)
 *   - IPv6 loopback (::1, 0:0:0:0:0:0:0:1), unspecified (::)
 *   - IPv6 link-local (fe80::/10)
 *   - IPv6 unique-local (fc00::/7 — fc and fd prefixes)
 *   - IPv4-mapped IPv6 in dotted form  (::ffff:127.0.0.1)
 *   - IPv4-mapped IPv6 in hex-pair form (::ffff:7f00:1 or ::ffff:a9fe:a9fe)
 *   - RFC1918 ranges: 10/8, 172.16-31/12, 192.168/16
 *   - Link-local: 169.254/16 (AWS/GCP/Azure metadata)
 *   - CGNAT: 100.64.0.0/10
 *   - Loopback: 127/8
 *   - Blocked exact hostname strings
 */
function isBlockedHost(hostname: string): boolean {
  // Strip IPv6 brackets if present, then lowercase
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // Strip FQDN trailing dots to prevent bypass via "localhost..", "localhost...", etc.
  const raw = stripped.toLowerCase().replace(/\.+$/, '');

  // Exact match against blocked hosts set
  if (BLOCKED_EXACT_HOSTS.has(raw)) return true;

  // IPv6 address (contains colon)
  if (raw.includes(':')) {
    // Normalize zero-padded groups (e.g. 0000:0000:...:0001 → 0:0:...:1)
    // so zero-padded loopback forms match BLOCKED_EXACT_HOSTS entries.
    const zeroNorm = raw
      .split(':')
      .map(g => (g === '' ? '' : (parseInt(g, 16).toString(16) || '0')))
      .join(':');
    if (BLOCKED_EXACT_HOSTS.has(zeroNorm)) return true;

    // Link-local: fe80::/10
    if (raw.startsWith('fe80:')) return true;
    // Unique-local: fc00::/7 (covers fc and fd prefixes)
    if (raw.startsWith('fc') || raw.startsWith('fd')) return true;

    // IPv4-mapped IPv6: ::ffff:<ipv4-dotted> or ::ffff:<hex>:<hex>
    if (raw.startsWith('::ffff:')) {
      const v4part = raw.slice(7); // strip "::ffff:"
      // Determine if it's dotted-decimal or hex-pair form
      const dotted = v4part.includes('.')
        ? v4part
        : hexPairsToDotted(v4part);
      if (dotted !== null && isBlockedHost(dotted)) return true;
    }

    // Embedded IPv4 without ::ffff: prefix (e.g. "::0.0.0.1" = ::1 loopback,
    // "::127.0.0.1" = loopback). Detect the bare IPv4 tail (last group with dot).
    // The embedded IPv4 form is valid in IPv6 addresses like ::1.2.3.4.
    const colonParts = raw.split(':');
    const lastPart = colonParts[colonParts.length - 1] ?? '';
    if (lastPart.includes('.')) {
      // Parse the embedded IPv4 octets
      const ipv4Octets = lastPart.split('.').map(Number);
      if (
        ipv4Octets.length === 4 &&
        ipv4Octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)
      ) {
        const [a, b, c, d] = ipv4Octets as [number, number, number, number];
        // Convert IPv4 to two 16-bit hex groups (last two groups of the IPv6 address)
        const hiGroup = ((a << 8) | b).toString(16);
        const loGroup = ((c << 8) | d).toString(16);
        // Replace the IPv4 tail with the two hex groups and expand the full
        // 8-group uncompressed form so we can check it reliably.
        const prefixParts = colonParts.slice(0, -1);
        const expandedParts = [...prefixParts, hiGroup, loGroup];
        // Expand '::' compression: count empty strings caused by '::'
        const emptyCount = expandedParts.filter(p => p === '').length;
        // emptyCount=2 means '::' was at start or end; emptyCount=3 means '::' in middle
        // Fill to 8 groups by replacing the empty-string run with zeros
        const neededZeros = 8 - expandedParts.filter(p => p !== '').length;
        const filled: string[] = [];
        let zerosInserted = false;
        for (const part of expandedParts) {
          if (part === '' && !zerosInserted && emptyCount >= 2) {
            for (let i = 0; i < neededZeros; i++) filled.push('0');
            zerosInserted = true;
          } else if (part !== '') {
            filled.push(part);
          }
        }
        // Pad to 8 groups if still short (edge case)
        while (filled.length < 8) filled.push('0');
        const fullForm = filled.slice(0, 8).join(':');
        if (isBlockedHost(fullForm)) return true;
        // Also check the IPv4 part on its own (catches ::127.0.0.1 etc.)
        if (isBlockedHost(lastPart)) return true;
      }
    }

    return false;
  }

  // IPv4 dotted-decimal range checks
  const octets = raw.split('.').map(Number);
  if (octets.length === 4 && octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255)) {
    const [a, b] = octets as [number, number, number, number];
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 127) return true;                          // 127.0.0.0/8 loopback
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16-31.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FetchPermission = 'allow' | 'deny' | 'ask';

// ---------------------------------------------------------------------------
// Runtime permission store
// ---------------------------------------------------------------------------

const domainPermissions: Map<string, FetchPermission> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate whether the given hostname or IP is safe to fetch.
 *
 * The input may be a plain hostname, an IPv4 address, or an IPv6 address with
 * or without surrounding brackets (as returned by `new URL().hostname` in Node).
 *
 * @param domain - Hostname or IP address extracted from the target URL.
 * @returns `allowed: true` when the domain passes all block checks.
 */
export function validateDomain(domain: string): { allowed: boolean; reason?: string } {
  if (!domain || typeof domain !== 'string') {
    return { allowed: false, reason: 'Domain is empty or invalid' };
  }

  // Strip FQDN trailing dots to prevent bypass via "localhost..", "localhost...", etc.
  const d = domain.toLowerCase().trim().replace(/\.+$/, '');

  // Block internal IPs, IPv6 addresses, CGNAT, and cloud metadata endpoints.
  if (isBlockedHost(d)) {
    const reason = `Blocked internal/private host: ${d}`;
    log.warn({ domain: d }, reason);
    return { allowed: false, reason };
  }

  // Block internal domain suffixes (.internal, .local, .corp.)
  for (const pattern of BLOCKED_SUFFIX_PATTERNS) {
    if (pattern.test(d)) {
      const reason = `Blocked internal domain pattern: ${d}`;
      log.warn({ domain: d, pattern: pattern.source }, reason);
      return { allowed: false, reason };
    }
  }

  // Check user-set domain permissions.
  const perm = domainPermissions.get(d);

  if (perm === 'deny') {
    const reason = `Domain denied by user policy: ${d}`;
    log.warn({ domain: d }, reason);
    return { allowed: false, reason };
  }

  // 'ask' defers to the caller (non-blocking here; caller must handle the UX).
  return { allowed: true };
}

/**
 * Set a persistent runtime permission for the given domain.
 *
 * @param domain     - Hostname (will be lowercased).
 * @param permission - 'allow' | 'deny' | 'ask'
 */
export function setDomainPermission(domain: string, permission: FetchPermission): void {
  if (!domain || typeof domain !== 'string') {
    log.warn({ domain, permission }, 'setDomainPermission: invalid domain argument — ignored');
    return;
  }

  domainPermissions.set(domain.toLowerCase(), permission);
  log.info({ domain: domain.toLowerCase(), permission }, 'Domain permission set');
}

/**
 * Retrieve the current permission for a domain (defaults to 'allow').
 */
export function getDomainPermission(domain: string): FetchPermission {
  if (!domain || typeof domain !== 'string') return 'allow';
  return domainPermissions.get(domain.toLowerCase()) ?? 'allow';
}
