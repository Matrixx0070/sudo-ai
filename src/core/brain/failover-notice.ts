/**
 * @file brain/failover-notice.ts
 * @description GW-2: bounded degradation notice. Failover used to be silent —
 * no operator signal on sustained degradation. This monitor fires exactly ONE
 * notice when the brain has been serving from a NON-primary model for too long
 * (>sustainedMs) OR too many consecutive hops (>hopThreshold), then re-arms
 * only after rearmMs so a wedged provider can't spam. Pure + injectable clock.
 *
 * It does NOT drive failover or cooldowns — ModelFailover already owns those
 * (reused, not duplicated). This is observation only.
 */

export interface FailoverNotice {
  /** Consecutive non-primary selections at the moment the notice fired. */
  consecutiveHops: number;
  /** Milliseconds since the first non-primary selection in this streak. */
  elapsedMs: number;
  /** The profile currently being served (non-primary). */
  currentProfile: string;
}

export interface SustainedFailoverOptions {
  /** Fire after this many consecutive non-primary selections. Default 3. */
  hopThreshold?: number;
  /** Fire after this long continuously off-primary (ms). Default 30_000. */
  sustainedMs?: number;
  /** Minimum gap between notices for the same streak class (ms). Default 30 min. */
  rearmMs?: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Sink for the (single) notice. */
  notify: (notice: FailoverNotice) => void;
}

const DEFAULT_HOP_THRESHOLD = 3;
const DEFAULT_SUSTAINED_MS = 30_000;
const DEFAULT_REARM_MS = 30 * 60_000;

export class SustainedFailoverMonitor {
  private readonly hopThreshold: number;
  private readonly sustainedMs: number;
  private readonly rearmMs: number;
  private readonly now: () => number;
  private readonly notify: (n: FailoverNotice) => void;

  /** Whether we're currently in a non-primary streak. */
  private streakActive = false;
  /** First non-primary selection time in the current streak. */
  private streakStartedAt = 0;
  private consecutiveHops = 0;
  /** When the last notice fired (for re-arm). Negative infinity = never. */
  private lastNoticeAt = Number.NEGATIVE_INFINITY;

  constructor(opts: SustainedFailoverOptions) {
    this.hopThreshold = opts.hopThreshold ?? DEFAULT_HOP_THRESHOLD;
    this.sustainedMs = opts.sustainedMs ?? DEFAULT_SUSTAINED_MS;
    this.rearmMs = opts.rearmMs ?? DEFAULT_REARM_MS;
    this.now = opts.now ?? Date.now;
    this.notify = opts.notify;
  }

  /**
   * Record which model was just selected. `isPrimary` true when it's the
   * top-priority profile. Serving the primary resets the streak (recovery).
   */
  noteSelection(profileId: string, isPrimary: boolean): void {
    if (isPrimary) {
      this.streakActive = false;
      this.streakStartedAt = 0;
      this.consecutiveHops = 0;
      return;
    }
    const t = this.now();
    if (!this.streakActive) {
      this.streakActive = true;
      this.streakStartedAt = t;
    }
    this.consecutiveHops += 1;

    const elapsedMs = t - this.streakStartedAt;
    const crossed = this.consecutiveHops > this.hopThreshold || elapsedMs > this.sustainedMs;
    if (!crossed) return;
    if (t - this.lastNoticeAt < this.rearmMs) return; // still in re-arm window

    this.lastNoticeAt = t;
    try {
      this.notify({ consecutiveHops: this.consecutiveHops, elapsedMs, currentProfile: profileId });
    } catch {
      /* a broken sink must never break failover */
    }
  }

  /** Test/observability: current streak state. */
  snapshot(): { consecutiveHops: number; onStreak: boolean } {
    return { consecutiveHops: this.consecutiveHops, onStreak: this.streakActive };
  }
}
