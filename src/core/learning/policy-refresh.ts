/**
 * @file policy-refresh.ts
 * @description Background (scheduled) refresh of a TraceDrivenPolicy so the
 * learned routing rules don't go stale between restarts as new traces
 * accumulate.
 *
 * Why this shape: TraceDrivenPolicy.refreshPolicies() runs SYNCHRONOUS
 * better-sqlite3 aggregation. It is BOUNDED (the analyzer queries a time window
 * with a row limit), so the cost is small — but it still briefly blocks the
 * event loop when it runs. We therefore keep it OFF every request's critical
 * path: it runs in a standalone, UNREF'd interval callback (never inline in a
 * request, never keeps the process alive). It is overlap-guarded and fail-open.
 *
 * For very large trace stores, moving the aggregation into a worker thread (true
 * off-main-thread) is the upgrade — a documented follow-up.
 */

/** The slice of TraceDrivenPolicy this loop needs. */
export interface RefreshablePolicy {
  refreshPolicies(): void;
}

/** Floor on the refresh interval — guards against an abusively frequent schedule. */
export const POLICY_REFRESH_MIN_MS = 30_000;

/**
 * Start a background policy-refresh loop.
 *
 * @param policy     - The policy to refresh.
 * @param intervalMs - Requested interval in ms. <= 0 (or non-finite) disables
 *                     the loop entirely (returns a no-op stop). Values below
 *                     {@link POLICY_REFRESH_MIN_MS} are clamped up to it.
 * @param onError    - Optional callback for a refresh that throws (fail-open).
 * @returns A stop() that clears the timer — call it on shutdown.
 */
export function startPolicyRefreshLoop(
  policy: RefreshablePolicy,
  intervalMs: number,
  onError?: (err: unknown) => void,
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => { /* disabled — nothing to stop */ };
  }
  const ms = Math.max(POLICY_REFRESH_MIN_MS, intervalMs);
  let refreshing = false;

  const timer = setInterval(() => {
    if (refreshing) return; // overlap guard (defensive — refresh is synchronous)
    refreshing = true;
    try {
      policy.refreshPolicies();
    } catch (err) {
      onError?.(err);
    } finally {
      refreshing = false;
    }
  }, ms);

  // Don't let the refresh schedule keep the process alive or interfere with exit.
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
