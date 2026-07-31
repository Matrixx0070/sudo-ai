/**
 * @file fast-mode.ts
 * @description Claude seat "fast mode" (2026-07-31).
 *
 * The flat-rate Max seat serves opus-tier models at up to ~2.5x output
 * tokens/sec when the request carries `speed: 'fast'` plus the fast-mode beta.
 * Live-measured through this codebase: 61.5 -> 127.6 tok/s on opus-5 (same
 * prompt), i.e. a 5.9s reply became 2.7s — for the same $0.
 *
 * Kept in its own module so transport.ts stays under its max-lines ratchet and
 * the body builder / header builder can share ONE decision function.
 */

/** Beta flag that unlocks `speed: 'fast'` (the Claude Code CLI sends this). */
export const ANTHROPIC_FAST_MODE_BETA = 'fast-mode-2026-02-01';

/**
 * Models that accept `speed: 'fast'` on the seat. Live-probed 2026-07-31:
 * opus-5 -> 200 (usage.speed=fast), opus-4-8 -> 200, sonnet-5 -> 400
 * "does not support the `speed` parameter". Sending it to an unsupported model
 * is a HARD 400, so this gate stays strict — never widen it without a probe.
 */
const FAST_MODE_MODEL_RE = /^claude-opus-(5|4-8|4-7)\b/;

/**
 * True when this route should request fast mode. Derived from
 * (provider, modelId, flag) ONLY, so the wire-body builder and the header
 * builder decide independently and can never drift apart.
 * Disable with SUDO_FAST_MODE=0.
 */
export function fastModeApplies(provider: string, modelId: string): boolean {
  if (process.env['SUDO_FAST_MODE'] === '0') return false;
  if (provider !== 'claude-oauth') return false;
  if (!FAST_MODE_MODEL_RE.test(modelId)) return false;
  return fastModeAvailable(`${provider}/${modelId}`);
}

// ---------------------------------------------------------------------------
// Sticky degrade (2026-07-31). The seat started answering fast-mode requests
// with 429 "Usage credits are required for fast mode". The original degrade
// relied on the policy layer re-entering the attempt — dead under the brain
// path's `noRetry: true` (maxAttempts 1), which took opus-5 down behind
// failover. Now a credits-429 marks the (provider/model) fast-unavailable for
// a TTL, so subsequent calls skip `speed` entirely and recover by themselves
// when credits appear / the ban lifts. SUDO_FAST_MODE_RETRY_MS tunes the TTL.
// ---------------------------------------------------------------------------

const fastUnavailableUntil = new Map<string, number>();

function fastModeRetryMs(): number {
  const n = Number.parseInt(process.env['SUDO_FAST_MODE_RETRY_MS'] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

/** True unless a recent credits-429 marked this provider/model unavailable. */
export function fastModeAvailable(key: string, now: number = Date.now()): boolean {
  const until = fastUnavailableUntil.get(key);
  if (until === undefined) return true;
  if (now >= until) {
    fastUnavailableUntil.delete(key);
    return true;
  }
  return false;
}

export function markFastModeUnavailable(key: string, now: number = Date.now()): void {
  fastUnavailableUntil.set(key, now + fastModeRetryMs());
}

/** Test seam. */
export function resetFastModeCache(): void {
  fastUnavailableUntil.clear();
}

/**
 * The credits-metering refusal, distinct from an ordinary rate limit — only
 * this variant triggers the sticky degrade + same-call naked retry (a real
 * rate limit would 429 the naked retry too and must go to failover instead).
 */
export function isFastModeCreditsError(status: number, body: string): boolean {
  return status === 429 && /fast.mode/i.test(body);
}

/** Remove `speed` from a serialized wire body (the fast-mode 429 degrade). */
export function stripSpeedFromWireBody(wireBody: string): string {
  try {
    const parsed = JSON.parse(wireBody) as Record<string, unknown>;
    if (parsed['speed'] === undefined) return wireBody;
    delete parsed['speed'];
    return JSON.stringify(parsed);
  } catch {
    return wireBody;
  }
}
