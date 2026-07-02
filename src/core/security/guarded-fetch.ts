/**
 * @file security/guarded-fetch.ts
 * @description Single guarded-fetch entry point for agent builtin tools.
 *
 * Every outbound HTTP request made by a builtin tool should go through
 * {@link toolFetch} rather than the global `fetch`. This routes the request
 * through the SSRF guard (`safeFetch`): protocol allow-list, domain/IP
 * validation (internal ranges, cloud-metadata, deny-list), and per-redirect
 * re-validation.
 *
 * Consolidating on this one wrapper avoids the SSRF-implementation drift
 * flagged in docs/REVIEW-2026-07-02-vs-openclaw.md (P0 #1): before this,
 * ~22 builtin tool files called the raw global `fetch` with agent- or
 * user-supplied URLs and never touched a guard.
 *
 * Escape hatch: set `SUDO_TOOL_FETCH_GUARD_DISABLE=1` to fall back to the raw
 * global `fetch`. This defeats SSRF protection and exists only for local
 * debugging; it emits a one-time warning per process.
 */

import { createLogger } from '../shared/logger.js';
import { safeFetch } from './web-fetch-guard.js';

const log = createLogger('security:tool-fetch');

let warnedDisabled = false;

/**
 * Guarded drop-in replacement for the global `fetch`, for use by builtin tools.
 *
 * @param url     - Target URL (string). Tools pass absolute http(s) URLs.
 * @param options - Standard `RequestInit`, forwarded verbatim.
 * @returns The `Response` from the guarded fetch.
 * @throws When the URL (or a redirect target) is blocked by the SSRF guard.
 */
export async function toolFetch(url: string, options?: RequestInit): Promise<Response> {
  if (process.env['SUDO_TOOL_FETCH_GUARD_DISABLE'] === '1') {
    if (!warnedDisabled) {
      warnedDisabled = true;
      log.warn(
        'SUDO_TOOL_FETCH_GUARD_DISABLE=1 — tool fetches bypass the SSRF guard. Debug use only.',
      );
    }
    return fetch(url, options);
  }
  return safeFetch(url, options);
}
