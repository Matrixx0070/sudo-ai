/**
 * @file security/web-fetch-guard.ts
 * @description Upgrade 50 — Web fetch safety guard.
 *
 * Validates URLs before any outbound HTTP request is made. Checks:
 *   1. Protocol — only http: and https: are permitted.
 *   2. Domain — delegates to domain-validator which blocks internal IPs,
 *      cloud-metadata endpoints, and user-denied domains.
 *
 * Use `safeFetch` as a drop-in replacement for the global `fetch` when making
 * outbound requests from agent tools. Use `guardFetch` when you only need
 * validation without performing the actual request.
 *
 * Session 21 — redirect safety: safeFetch now follows redirects manually
 * and re-validates each Location header before following. Open redirects
 * to SSRF targets are blocked with SSRFBlockedRedirectError.
 */

import type { Dispatcher } from 'undici';
import { createLogger } from '../shared/logger.js';
import { validateDomain } from './domain-validator.js';
import { getPinnedDispatcher, isDnsPinningEnabled } from './ssrf-dns-pin.js';

const log = createLogger('security:web-fetch');

/** `RequestInit` plus undici's non-standard `dispatcher` option (Node global fetch). */
type UndiciRequestInit = RequestInit & { dispatcher?: Dispatcher };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FetchGuardResult {
  /** Whether the URL is safe to fetch. */
  allowed: boolean;
  /** Original URL string passed to the guard. */
  url: string;
  /** Extracted hostname from the URL (empty when URL is unparseable). */
  domain: string;
  /** Human-readable reason when `allowed === false`. */
  reason?: string;
}

/**
 * Thrown by `safeFetch` when a redirect Location header points to a
 * blocked internal/private target. Contains the blocked URL in the message.
 */
export class SSRFBlockedRedirectError extends Error {
  constructor(public readonly blockedUrl: string, reason?: string) {
    super(`SSRF: redirect to blocked target ${blockedUrl}${reason ? ` — ${reason}` : ''}`);
    this.name = 'SSRFBlockedRedirectError';
  }
}

/** Maximum number of redirects safeFetch will follow before erroring. */
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a URL before fetching it.
 *
 * Checks the protocol and delegates domain validation to `validateDomain`.
 * Does not perform any network I/O.
 *
 * @param url - The target URL string to validate.
 * @returns A {@link FetchGuardResult} describing the outcome.
 */
export function guardFetch(url: string): FetchGuardResult {
  if (!url || typeof url !== 'string') {
    return { allowed: false, url: String(url), domain: '', reason: 'URL must be a non-empty string' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ url }, `web-fetch-guard: invalid URL — ${msg}`);
    return { allowed: false, url, domain: '', reason: `Invalid URL: ${msg}` };
  }

  const domain = parsed.hostname;

  // Block non-HTTP protocols.
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const reason = `Blocked protocol: ${parsed.protocol}`;
    log.warn({ url, domain, protocol: parsed.protocol }, `web-fetch-guard: ${reason}`);
    return { allowed: false, url, domain, reason };
  }

  // Validate domain (blocks internal IPs, cloud-metadata, deny-listed domains).
  const validation = validateDomain(domain);
  if (!validation.allowed) {
    log.warn({ url, domain, reason: validation.reason }, 'web-fetch-guard: domain blocked');
    return { allowed: false, url, domain, reason: validation.reason };
  }

  log.debug({ url, domain }, 'web-fetch-guard: fetch allowed');
  return { allowed: true, url, domain };
}

/**
 * Safe drop-in replacement for the global `fetch`.
 *
 * Runs `guardFetch` first. Throws when the URL is blocked. Otherwise delegates
 * to the platform `fetch` using manual redirect mode so every redirect
 * Location is re-validated before following.
 *
 * @param url     - Target URL.
 * @param options - Standard `RequestInit` options forwarded to `fetch`.
 * @returns The `Response` from the underlying `fetch` call.
 * @throws {Error} When the URL is blocked by the guard.
 * @throws {SSRFBlockedRedirectError} When a redirect target is blocked.
 * @throws {Error} When more than MAX_REDIRECTS hops are encountered.
 */
export async function safeFetch(url: string, options?: RequestInit): Promise<Response> {
  const initialGuard = guardFetch(url);
  if (!initialGuard.allowed) {
    log.error({ url, reason: initialGuard.reason }, 'web-fetch-guard: safeFetch blocked');
    throw new Error(`Fetch blocked: ${initialGuard.reason}`);
  }

  // Force manual redirect handling so we can inspect and re-validate
  // every Location header before following it.
  const fetchOptions: UndiciRequestInit = { ...options, redirect: 'manual' };

  // DNS-pin the socket to a validated address so a hostname that passes the
  // string check cannot rebind to a private/metadata IP at connect time.
  // Skipped if the caller supplied its own dispatcher or pinning is disabled.
  if (isDnsPinningEnabled() && !(options as UndiciRequestInit | undefined)?.dispatcher) {
    fetchOptions.dispatcher = getPinnedDispatcher();
  }

  let currentUrl = url;
  let hops = 0;

  while (true) {
    const response = await fetch(currentUrl, fetchOptions);

    // Non-redirect: return immediately.
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    // Redirect path.
    hops += 1;
    if (hops > MAX_REDIRECTS) {
      log.error({ url, hops }, 'web-fetch-guard: too many redirects');
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) for ${url}`);
    }

    const location = response.headers.get('location');
    if (!location) {
      // No Location header on a 3xx — return the response as-is.
      return response;
    }

    // Resolve relative redirects against the current URL.
    let resolved: string;
    try {
      resolved = new URL(location, currentUrl).toString();
    } catch {
      log.error({ location, currentUrl }, 'web-fetch-guard: unparseable redirect Location');
      throw new Error(`Unparseable redirect Location: ${location}`);
    }

    // Re-validate the redirect target before following.
    const redirectGuard = guardFetch(resolved);
    if (!redirectGuard.allowed) {
      log.error(
        { url, redirect: resolved, reason: redirectGuard.reason },
        'web-fetch-guard: redirect to blocked target',
      );
      throw new SSRFBlockedRedirectError(resolved, redirectGuard.reason);
    }

    log.debug({ from: currentUrl, to: resolved, hop: hops }, 'web-fetch-guard: following redirect');
    currentUrl = resolved;
  }
}
