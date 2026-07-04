/**
 * @file security/ssrf-dns-pin.ts
 * @description DNS-pinning dispatcher for the SSRF guard (P0 #2).
 *
 * The hostname-string checks in `domain-validator.ts` cannot stop a
 * DNS-rebinding attack: a hostname that passes the string check (a normal
 * public name) can resolve to `169.254.169.254` or an RFC1918 address at
 * connection time. Validating the name and then letting the socket re-resolve
 * leaves a TOCTOU window.
 *
 * This module closes that window the way OpenClaw's `net-policy` does: it
 * supplies undici's `connect.lookup`, which is the single point where the
 * request's socket learns its destination address. We resolve the hostname
 * ourselves, validate EVERY resolved address against `validateDomain` (which
 * accepts raw IP strings), and hand undici back only validated addresses. The
 * socket connects to exactly those addresses — there is no second resolution,
 * so the address that was validated is the address that is dialed (pinned).
 *
 * Fail-closed: any resolution error, or any resolved address that fails
 * validation, rejects the connection.
 *
 * Opt-out: `SUDO_SSRF_DNS_PIN=0` disables pinning (hostname-string checks in
 * `guardFetch` still apply). Pinning is ON by default.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import { createLogger } from '../shared/logger.js';
import { validateDomain } from './domain-validator.js';

const log = createLogger('security:ssrf-dns-pin');

/** Error surfaced as the undici connect failure `cause` when a resolved IP is blocked. */
export class SSRFBlockedAddressError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly address: string,
    reason?: string,
  ) {
    super(`SSRF: ${hostname} resolved to blocked address ${address}${reason ? ` — ${reason}` : ''}`);
    this.name = 'SSRFBlockedAddressError';
  }
}

/** Whether DNS pinning is enabled (default true; disable with SUDO_SSRF_DNS_PIN=0). */
export function isDnsPinningEnabled(): boolean {
  return process.env['SUDO_SSRF_DNS_PIN'] !== '0';
}

/**
 * undici-compatible `lookup` that resolves, validates, and pins.
 *
 * Every resolved address is checked with `validateDomain`. If any is blocked,
 * the whole lookup fails closed (we do not silently drop the bad address and
 * connect to a sibling — a rebind that returns one public and one private
 * address must not succeed). On success we return the validated addresses, so
 * undici dials them directly with no re-resolution.
 */
export const pinnedLookup: LookupFunction = (hostname, options, callback): void => {
  // Resolve ALL addresses ourselves; validate each before returning any.
  // Honor a caller-requested address family (e.g. an IPv4/IPv6-only egress
  // policy) when present; otherwise resolve both families.
  const family = typeof options === 'object' ? options.family : undefined;
  dnsLookup(hostname, { all: true, verbatim: true, ...(family ? { family } : {}) }, (err, addresses) => {
    if (err) {
      log.warn({ hostname, err: err.message }, 'ssrf-dns-pin: resolution failed (fail-closed)');
      // Extra positional args are ignored by undici's connect on the error
      // path; passing them keeps the LookupFunction call shape consistent.
      callback(err, '', undefined);
      return;
    }

    const resolved = addresses as LookupAddress[];
    if (!resolved.length) {
      callback(new SSRFBlockedAddressError(hostname, '(none)', 'no addresses resolved'), '', undefined);
      return;
    }

    for (const { address } of resolved) {
      const verdict = validateDomain(address);
      if (!verdict.allowed) {
        log.error(
          { hostname, address, reason: verdict.reason },
          'ssrf-dns-pin: blocked resolved address (fail-closed)',
        );
        callback(new SSRFBlockedAddressError(hostname, address, verdict.reason), '', undefined);
        return;
      }
    }

    // All validated — pin by returning exactly these addresses.
    const wantAll = typeof options === 'object' && options.all === true;
    if (wantAll) {
      callback(null, resolved);
    } else {
      const first = resolved[0]!;
      callback(null, first.address, first.family);
    }
  });
};

let sharedDispatcher: Dispatcher | undefined;

/**
 * A shared undici dispatcher whose socket destinations are DNS-pinned and
 * validated by {@link pinnedLookup}. Reused across requests. Pass it as the
 * `dispatcher` option to `fetch`.
 */
export function getPinnedDispatcher(): Dispatcher {
  if (!sharedDispatcher) {
    sharedDispatcher = new Agent({ connect: { lookup: pinnedLookup } });
  }
  return sharedDispatcher;
}
