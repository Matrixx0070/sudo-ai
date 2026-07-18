/**
 * Failover policy knobs for Brain — backoff timing, attempt caps, terminal-error
 * class mapping, and /model switch resolution against the configured chain.
 * Extracted verbatim from brain.ts (F103 mechanical slimming); zero behavior change.
 */

import type { ErrorCategory } from './types.js';

/**
 * gw-refactor Phase 5: ErrorCategory (failover layer) → LLMErrorClass
 * (src/llm/errors.ts taxonomy) for the terminal-failure gateway-log row.
 * Local copy of the mapping in src/llm/errors.ts (CATEGORY_TO_CLASS is not
 * exported); brain already holds a categorized error at the throw sites, so
 * mapping it directly is cheaper than re-classifying the raw thrown value.
 */
export const GATEWAY_ERROR_CLASS: Record<ErrorCategory, string> = {
  rate_limit: 'rate_limited',
  overloaded: 'overloaded',
  timeout: 'timeout',
  context_overflow: 'context_exceeded',
  billing: 'billing',
  auth: 'auth',
  auth_permanent: 'auth',
  model_not_found: 'invalid_request',
  format: 'invalid_request',
  session_expired: 'invalid_request',
};

/**
 * Per-attempt backoff cap (ms) for failover when a provider is overloaded /
 * transient / timing out. Raised 5s → 15s and tunable via
 * SUDO_FAILOVER_BACKOFF_CAP_MS so a multi-second-to-minute cloud incident can
 * be ridden out instead of immediately surfacing "All failover attempts
 * failed". Clamped to [1s, 60s].
 */
export const FAILOVER_BACKOFF_CAP_MS = Math.min(
  60_000,
  Math.max(1_000, Number(process.env['SUDO_FAILOVER_BACKOFF_CAP_MS']) || 15_000),
);

/**
 * Backoff between sequential failover attempts when the previous profile
 * failed with a transient/overloaded category. Without this, the entire
 * chain fires in <2ms — a single anthropic blip 500s opus, sonnet, and
 * any same-window upstream simultaneously (observed live 2026-06-17 02:40).
 * If the upstream sent a retry-after header, honour it (capped). Otherwise
 * exponential: 250ms × 2^attempt, capped at FAILOVER_BACKOFF_CAP_MS.
 *
 * Kill-switch: SUDO_FAILOVER_BACKOFF_DISABLE=1 restores the zero-wait
 * burst (default off — always wait).
 */
export function failoverBackoffMs(category: string, attempt: number, retryAfterMs?: number): number {
  if (process.env['SUDO_FAILOVER_BACKOFF_DISABLE'] === '1') return 0;
  if (category !== 'overloaded' && category !== 'transient' && category !== 'timeout') return 0;
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(retryAfterMs, FAILOVER_BACKOFF_CAP_MS);
  }
  // Guard against a NaN/undefined/huge attempt counter: Math.pow(2, NaN) = NaN,
  // Math.min(cap, NaN) = NaN, and setTimeout(fn, NaN) fires immediately —
  // re-creating the zero-wait thundering-herd this backoff exists to prevent.
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const exp = Math.min(safeAttempt, 20);
  return Math.min(FAILOVER_BACKOFF_CAP_MS, 250 * Math.pow(2, exp));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maximum number of provider failover attempts per call. Raised 6 → 10 and
 * tunable via SUDO_FAILOVER_MAX_ATTEMPTS (clamped [1, 30]). Combined with the
 * 15s FAILOVER_BACKOFF_CAP_MS, a fully-overloaded chain now rides out ~60-75s
 * before surfacing an error (was ~9s) — per the operator's request to keep
 * retrying past 60s on a total upstream outage.
 *
 * Trade-off: when EVERY provider is down, a single reply can now take up to
 * ~75s instead of failing fast. Normal operation is unaffected — backoff only
 * applies to overloaded/transient/timeout categories, which are rare.
 */
export const MAX_FAILOVER_ATTEMPTS = Math.min(
  30,
  Math.max(1, Number(process.env['SUDO_FAILOVER_MAX_ATTEMPTS']) || 10),
);

/**
 * Resolve a /model switch target against the configured failover chain.
 * Accepts the full "provider/model-id" ref or the bare model id, both
 * case-insensitive. Returns the canonical configured ref, or null when the
 * target is not configured (switching to arbitrary unconfigured models would
 * bypass the failover chain and provider key setup).
 */
export function resolveModelSwitch(configured: string[], target: string): string | null {
  const t = target.trim().toLowerCase();
  if (!t) return null;
  return (
    configured.find((m) => m.toLowerCase() === t) ??
    configured.find((m) => m.toLowerCase().split('/').pop() === t) ??
    null
  );
}
