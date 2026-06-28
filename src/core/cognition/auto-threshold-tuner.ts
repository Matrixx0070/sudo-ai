/**
 * @file cognition/auto-threshold-tuner.ts
 * @description AutoThresholdTuner — adjusts the veto gate threshold dynamically
 * based on ConfidenceCalibrationTracker's Brier score.
 *
 * When calibration is drifting (Brier score high), the veto gate becomes MORE
 * aggressive (lower threshold). When calibration is tight (Brier < 0.10), no
 * adjustment is applied. Result is always clamped to [0.3, 0.95].
 *
 * Pure module — no REST wiring here (wired in admin-routes.ts + cli.ts).
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:auto-threshold-tuner');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum Brier score before any adjustment is applied. */
const BRIER_NO_ADJUST = 0.10;
/** Brier threshold below which max partial adjustment applies. */
const BRIER_PARTIAL_MAX = 0.25;
/** Brier threshold below which full adjustment applies. */
const BRIER_FULL_MAX = 0.40;

/** Max adjustment for Brier in (0.10, 0.25] zone. */
const ADJ_PARTIAL = 0.10;
/** Max adjustment for Brier in (0.25, 0.40] zone. */
const ADJ_FULL = 0.20;
/** Hard cap on adjustment (Brier > 0.40). */
const ADJ_CAP = 0.25;

/** Minimum allowed effective threshold (never go below this). */
const THRESHOLD_MIN = 0.30;
/** Maximum allowed effective threshold (never go above this). */
const THRESHOLD_MAX = 0.95;

/** Minimum sample count needed to apply any adjustment. */
const MIN_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Duck-typed interface for CalibrationTracker
// ---------------------------------------------------------------------------

/**
 * Minimal interface AutoThresholdTuner requires from a calibration tracker.
 * Matches ConfidenceCalibrationTracker's public getReport() shape.
 */
export interface CalibrationTrackerLike {
  getReport(opts?: { windowDays?: number; tag?: string }): {
    totalSamples: number;
    brierScore: number;
  };
}

// ---------------------------------------------------------------------------
// Result shape for the last computed threshold
// ---------------------------------------------------------------------------

export interface ThresholdComputation {
  baseThreshold: number;
  effectiveThreshold: number;
  brierScore: number;
  totalSamples: number;
  adjustment: number;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// AutoThresholdTuner
// ---------------------------------------------------------------------------

/**
 * AutoThresholdTuner computes a dynamic veto threshold based on calibration
 * drift. The tuner caches its last computation for the REST endpoint.
 *
 * Adjustment formula (piecewise linear):
 *   Brier <= 0.10                → no adjustment (return baseThreshold)
 *   Brier in (0.10, 0.25]       → reduce by up to 0.10, linear in range
 *   Brier in (0.25, 0.40]       → reduce by up to 0.20, linear in range
 *   Brier > 0.40                → cap at -0.25 reduction
 *
 * Special cases:
 *   - totalSamples < 5          → return baseThreshold (insufficient data)
 *   - tracker throws             → fail-open, return baseThreshold
 *   - result clamped to [0.3, 0.95]
 */
export class AutoThresholdTuner {
  private readonly _tracker: CalibrationTrackerLike;
  private _lastComputation: ThresholdComputation | null = null;

  constructor(tracker: CalibrationTrackerLike) {
    this._tracker = tracker;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute how much to reduce the threshold given a Brier score.
   * Returns a non-negative number (the reduction amount).
   */
  private static _computeAdjustment(brier: number): number {
    // A non-finite brier (e.g. NaN from sumSquaredError/0 in the tracker) fails every
    // `<=` comparison below and would fall through to the max ADJ_CAP reduction —
    // silently treating unknown calibration as worst-case drift and suppressing the
    // veto. Unknown calibration must apply NO adjustment (fail-safe to base threshold).
    if (!Number.isFinite(brier)) return 0;

    if (brier <= BRIER_NO_ADJUST) {
      // No adjustment — calibration is tight
      return 0;
    }

    if (brier <= BRIER_PARTIAL_MAX) {
      // Linear from 0 to ADJ_PARTIAL across (0.10, 0.25]
      const fraction = (brier - BRIER_NO_ADJUST) / (BRIER_PARTIAL_MAX - BRIER_NO_ADJUST);
      return fraction * ADJ_PARTIAL;
    }

    if (brier <= BRIER_FULL_MAX) {
      // Linear from ADJ_PARTIAL to ADJ_FULL across (0.25, 0.40]
      const fraction = (brier - BRIER_PARTIAL_MAX) / (BRIER_FULL_MAX - BRIER_PARTIAL_MAX);
      return ADJ_PARTIAL + fraction * (ADJ_FULL - ADJ_PARTIAL);
    }

    // Brier > 0.40 — cap at ADJ_CAP
    return ADJ_CAP;
  }

  /**
   * Clamp a threshold into the documented [THRESHOLD_MIN, THRESHOLD_MAX] contract.
   * A non-finite input maps to THRESHOLD_MAX — fail-safe, since a higher threshold
   * makes the veto HARDER to trip (never accidentally disabled by NaN > comparisons).
   */
  private static _clampThreshold(t: number): number {
    return Number.isFinite(t) ? Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, t)) : THRESHOLD_MAX;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Compute the effective veto threshold, adjusting downward when calibration
   * is drifting.
   *
   * @param baseThreshold  The static baseline threshold (e.g. 0.5).
   * @returns              The (possibly reduced and clamped) effective threshold.
   */
  computeVetoThreshold(baseThreshold: number): number {
    let brierScore = 0;
    let totalSamples = 0;
    let adjustment = 0;

    try {
      const report = this._tracker.getReport();
      brierScore = report.brierScore;
      totalSamples = report.totalSamples;

      if (totalSamples < MIN_SAMPLES) {
        // Insufficient data — no adjustment, but still honor the [0.3, 0.95] contract.
        const effectiveThreshold = AutoThresholdTuner._clampThreshold(baseThreshold);
        this._lastComputation = {
          baseThreshold,
          effectiveThreshold,
          brierScore,
          totalSamples,
          adjustment: 0,
          computedAt: new Date().toISOString(),
        };
        return effectiveThreshold;
      }

      adjustment = AutoThresholdTuner._computeAdjustment(brierScore);
    } catch (err: unknown) {
      // Tracker threw — fail-open: return baseThreshold
      log.warn(
        { err: String(err), event: 'auto-threshold-tuner.tracker.error' },
        'AutoThresholdTuner: calibration tracker threw — failing open to base threshold',
      );
      const effectiveThreshold = AutoThresholdTuner._clampThreshold(baseThreshold);
      this._lastComputation = {
        baseThreshold,
        effectiveThreshold,
        brierScore: 0,
        totalSamples: 0,
        adjustment: 0,
        computedAt: new Date().toISOString(),
      };
      return effectiveThreshold;
    }

    // Apply adjustment (reduce threshold — more aggressive)
    const rawEffective = baseThreshold - adjustment;
    // Clamp to [THRESHOLD_MIN, THRESHOLD_MAX]
    const effectiveThreshold = Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, rawEffective));

    this._lastComputation = {
      baseThreshold,
      effectiveThreshold,
      brierScore,
      totalSamples,
      adjustment,
      computedAt: new Date().toISOString(),
    };

    return effectiveThreshold;
  }

  /**
   * Return the last computed threshold data, or null if computeVetoThreshold
   * has never been called.
   */
  getLastComputation(): ThresholdComputation | null {
    return this._lastComputation;
  }
}
