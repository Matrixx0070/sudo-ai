/**
 * Cooldown policy math for the failover system: escalation schedules with
 * additive jitter, Retry-After handling, and the last-resort cap. Pure
 * functions — all state lives in ModelFailover (failover.ts).
 */

/** Optional inputs to recordError() / cooldown computation. */
export interface RecordErrorOptions {
  /** Server-provided Retry-After in ms (parsed from the response header/body), if any. */
  retryAfterMs?: number;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Per-profile salt derived from profileId hash to de-sync jitter across simultaneously-failing profiles. */
  profileSeed?: number;
}

/**
 * Additive jitter applied to scheduled cooldowns: the final wait is
 * base .. base*(1+JITTER_RATIO). Jitter only ever LENGTHENS the wait, so we
 * never retry sooner than the schedule, while still de-synchronizing retries
 * across profiles to avoid a thundering-herd storm.
 */
export const JITTER_RATIO = 0.2;

/**
 * Hard cap on a server-provided Retry-After, so a pathological/huge value can't
 * wedge a model out of rotation indefinitely.
 */
export const MAX_RETRY_AFTER_MS = 3_600_000; // 1 hour

/**
 * Absolute last-resort profile(s) for the cron heartbeat / background ticks.
 * A 2026-07-25 incident had system.heartbeat report "all profiles exhausted"
 * for 4+ hours because the primary + fallback chain all hit cooldown/disable
 * at once with nothing left to retry sooner than their normal (up to 30min
 * auth / 10min billing) backoff ceilings. This model gets a much shorter,
 * fixed cooldown cap instead of an unlimited exemption — it's a BILLED
 * ollama:cloud model (~$0.057/call, see project history), so a true never-
 * cooldown exemption during a real outage would mean paying for a retry
 * every tick indefinitely. A 60s cap bounds that cost while still giving the
 * heartbeat a provider to retry against within a minute instead of hours.
 */
export const LAST_RESORT_MODEL_IDS: ReadonlySet<string> = new Set([
  'ollama/glm-5.2:cloud',
]);
export const LAST_RESORT_COOLDOWN_CAP_MS = 60_000;

/** Apply the last-resort cap when the profile qualifies; identity otherwise. */
export function capLastResort(profileId: string, ms: number): number {
  return LAST_RESORT_MODEL_IDS.has(profileId) ? Math.min(ms, LAST_RESORT_COOLDOWN_CAP_MS) : ms;
}

/** Derive a stable per-profile jitter phase seed from its id. */
export function profileSeedFor(profileId: string): number {
  let hash = 0;
  for (let i = 0; i < profileId.length; i++) {
    hash = ((hash * 31) + profileId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Compute a cooldown for the given schedule + consecutive error count.
 *
 * Applies additive jitter (never shorter than the base schedule) to avoid
 * synchronized retry storms, then honors a server Retry-After when it asks us
 * to wait LONGER than our own schedule (capped at MAX_RETRY_AFTER_MS).
 */
export function computeCooldownMs(
  schedule: readonly number[],
  errorCount: number,
  opts: RecordErrorOptions,
): number {
  const idx = Math.min(Math.max(errorCount - 1, 0), schedule.length - 1);
  const base = schedule[idx];
  const rng = opts.rng ?? Math.random;
  const rVal = Math.max(0, Math.min(1, rng()));
  // Only mix profileSeed phase when using the default RNG — injected RNGs (tests) control jitter exactly.
  const phase = (!opts.rng && opts.profileSeed !== undefined) ? ((opts.profileSeed >>> 0) % 1000) / 1000 : 0;
  // Additive jitter: base .. base*(1 + JITTER_RATIO). Never below base.
  let ms = base + base * JITTER_RATIO * Math.max(0, Math.min(1, rVal + phase));
  // Respect a longer server-provided Retry-After (capped).
  if (typeof opts.retryAfterMs === 'number' && opts.retryAfterMs > ms) {
    ms = Math.min(opts.retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  return Math.round(ms);
}
