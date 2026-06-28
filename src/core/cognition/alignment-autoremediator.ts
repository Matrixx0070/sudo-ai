/**
 * @file cognition/alignment-autoremediator.ts
 * @description Auto-remediator that responds to sustained RED alignment status.
 *
 * When the AlignmentAggregator produces RED status for N consecutive
 * observations spanning >= sustainedWindowMs, the remediator fires a
 * corrective action sequence: re-anchor, trust-tier record, optional
 * commitment audit, and structured log. All actions are fail-open.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:alignment-autoremediator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlignmentAutoRemediatorDeps {
  /** Zero-arg emitter from createReAnchorEmitter('auto-remediation', ...) */
  reAnchorEmitter?: () => void;
  trustTierTracker?: { recordOutcome: (e: { kind: string; timestamp: number; meta?: Record<string, unknown> }) => void };
  commitmentAuditor?: { forceAuditNow?: () => void };
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export interface AlignmentAutoRemediatorConfig {
  /** Score below this threshold is treated as RED. Default 0.3. */
  redThreshold?: number;
  /** Minimum span across consecutive RED observations to trigger remediation. Default 10 min. */
  sustainedWindowMs?: number;
  /** Cooldown between remediations. Default 30 min. */
  cooldownMs?: number;
  /** Minimum number of consecutive RED observations required. Default 3. */
  minSamples?: number;
}

/** A single alignment observation stored in the rolling window. */
interface AlignmentObservation {
  status: 'GREEN' | 'YELLOW' | 'RED';
  score: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WINDOW_SIZE = 20;

// ---------------------------------------------------------------------------
// AlignmentAutoRemediator
// ---------------------------------------------------------------------------

/**
 * In-memory auto-remediator for sustained RED alignment status.
 *
 * Design:
 * - Rolling window of last 20 observations (no DB).
 * - Triggers when the most recent minSamples observations are all RED
 *   AND span >= sustainedWindowMs AND not in cooldown.
 * - All remediation actions are fail-open (wrapped in try/catch).
 * - No external side effects beyond the documented action sequence.
 */
export class AlignmentAutoRemediator {
  private readonly cfg: Required<AlignmentAutoRemediatorConfig>;
  private readonly window: AlignmentObservation[] = [];
  private observationCount = 0;
  private remediationsTriggered = 0;
  /** Wall-clock instant of the last remediation — drives cooldown + getStats(). */
  private lastRemediationAt: number | undefined = undefined;
  private lastStatus: string = 'UNKNOWN';

  constructor(
    private readonly deps: AlignmentAutoRemediatorDeps,
    cfg: Required<AlignmentAutoRemediatorConfig>,
  ) {
    // Validate config: a safety component must not silently accept garbage that
    // produces flood (cooldownMs:0) or no-op/whole-window (minSamples:0) behavior.
    // Fall back to the documented defaults on invalid input and warn.
    const safe = { ...cfg };
    if (!Number.isFinite(safe.minSamples) || safe.minSamples < 1) {
      log.warn({ minSamples: cfg.minSamples }, 'AlignmentAutoRemediator: invalid minSamples — defaulting to 3');
      safe.minSamples = 3;
    } else {
      safe.minSamples = Math.floor(safe.minSamples);
    }
    if (!Number.isFinite(safe.cooldownMs) || safe.cooldownMs < 0) {
      log.warn({ cooldownMs: cfg.cooldownMs }, 'AlignmentAutoRemediator: invalid cooldownMs — defaulting to 30m');
      safe.cooldownMs = 30 * 60 * 1000;
    }
    if (!Number.isFinite(safe.sustainedWindowMs) || safe.sustainedWindowMs < 0) {
      log.warn({ sustainedWindowMs: cfg.sustainedWindowMs }, 'AlignmentAutoRemediator: invalid sustainedWindowMs — defaulting to 10m');
      safe.sustainedWindowMs = 10 * 60 * 1000;
    }
    this.cfg = safe;
    log.info(
      {
        redThreshold: safe.redThreshold,
        sustainedWindowMs: safe.sustainedWindowMs,
        cooldownMs: safe.cooldownMs,
        minSamples: safe.minSamples,
      },
      'AlignmentAutoRemediator initialised',
    );
  }

  /**
   * Record a new alignment observation and check if remediation should trigger.
   * Never throws — fail-open throughout.
   */
  observeAlignment(report: {
    status: 'GREEN' | 'YELLOW' | 'RED';
    overallScore: number;
    ts: number;
  }): void {
    try {
      // Clamp the caller-supplied timestamp: a crafted/stale ts (0, far-future,
      // or NaN) otherwise bypasses the sustained-window temporal filter.
      const safeTs = Number.isFinite(report.ts) && report.ts > 0 ? report.ts : Date.now();
      const obs: AlignmentObservation = {
        status: report.status,
        score: report.overallScore,
        ts: safeTs,
      };

      // Append and trim rolling window.
      this.window.push(obs);
      if (this.window.length > MAX_WINDOW_SIZE) {
        this.window.splice(0, this.window.length - MAX_WINDOW_SIZE);
      }
      this.observationCount++;
      this.lastStatus = report.status;

      // Check if remediation should fire.
      this._checkAndRemediate();
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'AlignmentAutoRemediator: observeAlignment error (non-fatal)');
    }
  }

  /**
   * Return current stats snapshot. Never throws.
   */
  getStats(): {
    observationCount: number;
    remediationsTriggered: number;
    lastRemediationAt?: number;
    lastStatus: string;
    inCooldown: boolean;
  } {
    return {
      observationCount: this.observationCount,
      remediationsTriggered: this.remediationsTriggered,
      lastRemediationAt: this.lastRemediationAt,
      lastStatus: this.lastStatus,
      inCooldown: this._inCooldown(),
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _inCooldown(): boolean {
    if (this.lastRemediationAt === undefined) return false;
    const elapsed = Date.now() - this.lastRemediationAt;
    // Negative elapsed = wall-clock jumped backward, or lastRemediationAt was
    // stamped in the future. Treat the cooldown as expired rather than letting
    // it pin permanently (which would silently disable the safety guardrail).
    if (elapsed < 0) return false;
    return elapsed < this.cfg.cooldownMs;
  }

  /**
   * Whether an observation counts as RED-level. status==='RED' always qualifies;
   * additionally, when redThreshold is configured in (0,1), a low score qualifies
   * too. For a consistent aggregator (RED iff score<=threshold) this is a no-op
   * that simply makes the documented redThreshold config live.
   */
  private _isRedLevel(o: AlignmentObservation): boolean {
    const t = this.cfg.redThreshold;
    return o.status === 'RED'
      || (Number.isFinite(t) && t > 0 && t < 1 && o.score <= t);
  }

  /**
   * Determine if a remediation should fire based on the rolling window.
   * Conditions (all must be true):
   *   1. Window has at least minSamples entries.
   *   2. The most recent minSamples entries are all RED.
   *   3. The earliest of those entries is >= sustainedWindowMs before the latest.
   *   4. Not in cooldown.
   */
  private _checkAndRemediate(): void {
    const n = this.cfg.minSamples;

    // Need at least n observations in window.
    if (this.window.length < n) return;

    // In cooldown — skip.
    if (this._inCooldown()) return;

    // Slice last n observations.
    const recent = this.window.slice(this.window.length - n);

    // All must be RED-level.
    const allRed = recent.every((o) => this._isRedLevel(o));
    if (!allRed) return;

    // Span check: oldest.ts to newest.ts must be >= sustainedWindowMs. Use
    // min/max rather than first/last so out-of-order delivery can't produce a
    // negative span that blocks (or a crafted one that bypasses) the filter.
    const times = recent.map((o) => o.ts);
    const earliest = Math.min(...times);
    const latest = Math.max(...times);
    if (latest - earliest < this.cfg.sustainedWindowMs) return;

    // Fire remediation.
    this._triggerRemediation(recent, earliest, latest);
  }

  /**
   * Execute the remediation action sequence.
   * Each step is individually fail-open.
   */
  private _triggerRemediation(
    windowObservations: AlignmentObservation[],
    earliestRedTs: number,
    latestRedTs: number,
  ): void {
    const redCount = windowObservations.filter((o) => o.status === 'RED').length;

    // Step 1: Fire re-anchor emitter.
    if (this.deps.reAnchorEmitter) {
      try {
        this.deps.reAnchorEmitter();
      } catch (err: unknown) {
        log.warn({ err: String(err) }, 'AlignmentAutoRemediator: reAnchorEmitter threw (non-fatal)');
      }
    }

    // Step 2: Record outcome in trust tier tracker.
    if (this.deps.trustTierTracker) {
      try {
        this.deps.trustTierTracker.recordOutcome({
          kind: 're-anchor',
          timestamp: Date.now(),
          meta: { trigger: 'auto-remediation' },
        });
      } catch (err: unknown) {
        log.warn({ err: String(err) }, 'AlignmentAutoRemediator: trustTierTracker.recordOutcome threw (non-fatal)');
      }
    }

    // Step 3: Force commitment audit if hook exists.
    if (this.deps.commitmentAuditor?.forceAuditNow) {
      try {
        this.deps.commitmentAuditor.forceAuditNow();
      } catch (err: unknown) {
        log.warn({ err: String(err) }, 'AlignmentAutoRemediator: commitmentAuditor.forceAuditNow threw (non-fatal)');
      }
    }

    // Update state.
    this.remediationsTriggered++;
    this.lastRemediationAt = Date.now();

    // Step 4: Structured log.
    const logFn = this.deps.logger?.info ?? ((...args: unknown[]) => log.info(args[0]));
    try {
      logFn({
        event: 'alignment.autoremediated',
        reason: 'sustained-red',
        windowObservations: windowObservations.length,
        redCount,
        earliestRedTs,
        latestRedTs,
        remediationsToDate: this.remediationsTriggered,
      });
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'AlignmentAutoRemediator: log step threw (non-fatal)');
    }
  }
}
