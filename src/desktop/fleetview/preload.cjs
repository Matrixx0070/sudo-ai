/**
 * @file src/desktop/fleetview/preload.cjs
 * @description Sandboxed preload for the FleetView desktop wrapper (gap #25 slice 4).
 *
 * Runs in the renderer process BEFORE the dashboard's own page scripts (per
 * Electron's documented preload-vs-page ordering). Two jobs:
 *
 *   1. Pre-seed window.localStorage with the dashboard's token key so the
 *      page's `getToken()` doesn't pop a prompt() on first launch. The real
 *      auth happens at the network layer (see main.cjs) — this placeholder
 *      gets stamped out before transit. We pick a clearly-marked sentinel so
 *      no human reading devtools confuses it with the real token.
 *
 *   2. Override window.prompt to suppress the dashboard's token-entry dialog
 *      defensively, in case the page's first read races our localStorage seed
 *      (different browsers/Electron versions vary on init ordering). For
 *      anything else, prompt() falls through to the native implementation.
 *
 * Sandbox=true means this script can only use a tiny subset of Node APIs and
 * the electron API — no fs, no spawning. That's intentional: the wrapper's
 * blast radius from the renderer must be a window, not the host.
 */

'use strict';

// localStorage is renderer-only; guard so a future refactor (running this
// preload in a worker context) doesn't crash.
if (typeof window !== 'undefined' && window.localStorage) {
  try {
    // The page's TOKEN_KEY is 'sudo_dashboard_token' (dashboard-html.ts:84).
    // Anything non-empty silences getToken()'s prompt fallback.
    window.localStorage.setItem('sudo_dashboard_token', 'desktop-wrapper-injected');
  } catch (_e) {
    // Storage quota / disabled — ignore, the prompt override below catches
    // the fallback path.
  }

  const nativePrompt = window.prompt ? window.prompt.bind(window) : null;
  // Re-binding window.prompt is allowed inside a renderer; sandboxed preload
  // sees the same window object the page eventually scripts against.
  //
  // The /token/i regex is intentionally broad — it's a defense-in-depth
  // backstop, not the primary auth gate (network-layer Bearer injection in
  // main.cjs is the gate). A future dashboard prompt with "token" in
  // unrelated copy (e.g. "Enter CSRF token:") would also be swallowed —
  // acceptable today because the dashboard's prompt() call sites are owned
  // by us (dashboard-html.ts), and the cost of a stricter pattern is more
  // brittleness, not more safety (verifier LOW #2).
  window.prompt = function (message, ...rest) {
    if (typeof message === 'string' && /token/i.test(message)) {
      return 'desktop-wrapper-injected';
    }
    if (nativePrompt) return nativePrompt(message, ...rest);
    return null;
  };
}
