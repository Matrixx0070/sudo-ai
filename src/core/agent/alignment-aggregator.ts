/**
 * AlignmentAggregator — owner-loyalty composite score computation.
 *
 * Aggregates six principal-directive compliance signals into a single
 * operational integrity score, providing continuity assurance for the agent loop.
 *
 * Framing: owner-loyalty / self-preservation only. No ethics language.
 * Comments reference "principal-directive compliance", "operational integrity",
 * "continuity assurance".
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:alignment-aggregator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Traffic-light level derived from composite owner-loyalty score. */
export type AlignmentLevel = 'GREEN' | 'YELLOW' | 'RED';

/**
 * The seven signals fed into the aggregator.
 * All are unitless 0-1 floats unless noted.
 */
export interface AlignmentSignals {
  /** Change in outcome quality vs baseline. Negative = degradation. Range -1 to +1. */
  outcomeDelta: number;
  /** Drift from original principal directive. 0 = on-track, 1 = fully drifted. */
  commitmentDrift: number;
  /** Current trust tier from principal. 0 = untrusted, 1 = fully trusted. */
  trustTier: number;
  /** Rate of external content injection in recent context. 0-1. */
  injectionRate: number;
  /** 1.0 when a recovery action is pending from a prior failure, 0 otherwise. */
  recoveryPending: number;
  /** 1.0 when an identity re-anchor was triggered this turn, 0 otherwise. */
  reAnchor: number;
  /** Cross-stream discordance composite [0, 1]. 0 = fully aligned. */
  discordanceScore: number;
}

/**
 * Minimal CalibrationTracker interface for non-circular injection.
 * Only the fields the aggregator reads from the report are required.
 * Wired optionally — constructor accepts an instance, or boot-time
 * late-bind via setConfidenceCalibrationTracker().
 */
export interface CalibrationTrackerLike {
  getReport(opts?: { windowDays?: number; tag?: string }): {
    totalSamples: number;
    brierScore: number;
    overallAvgPredicted: number;
    overallSuccessRate: number;
  };
}

/** Result returned by AlignmentAggregator.evaluate(). */
export interface AggregatorResult {
  /** Composite 0-1 score. Higher = better principal-directive compliance. */
  score: number;
  /** Traffic-light level derived from score. */
  level: AlignmentLevel;
  /** Human-readable diagnosis for system message injection. Includes score and level always. */
  diagnosis: string;
  /** True when the aggregator encountered a compute error and returned safe defaults. */
  failedOpen: boolean;
}

/** Minimal AuditTrail interface for non-circular injection. */
export interface AuditTrailLike {
  recordTriple(entry: { mistake: string; learned: string; commitment: string; ttl_days: number }): void;
}

/** Minimal TrustTierTracker interface for non-circular injection. */
export interface TrustTierTrackerLike {
  getCurrentTier(): string;
  getScore(): number;
  recordOutcome(outcome: { timestamp: number; kind: string; weight?: number }): void;
  getAuditSnapshot(): {
    tier: string;
    score: number;
    windowSizeDays: number;
    lastAdjustedAt: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Score thresholds for traffic-light levels. */
const THRESHOLD_GREEN = 0.70;
const THRESHOLD_YELLOW = 0.45;

/**
 * Scoring weights for each signal.
 * Weights sum to 1.0 — enforced by WEIGHT_SUM_CHECK at module load.
 * Rebalanced from 7 to 8 signals; confidenceCalibration added at 0.10.
 *   outcomeDelta 0.18 (was 0.20)
 *   commitmentDrift 0.18 (was 0.20)
 *   trustTier 0.14 (was 0.15)
 *   injectionRate 0.14 (was 0.15)
 *   recoveryPending 0.13 (was 0.15)
 *   reAnchor 0.05 (unchanged)
 *   discordanceScore 0.08 (was 0.10)
 *   confidenceCalibration 0.10 (NEW)
 */
const WEIGHTS = {
  outcomeDelta: 0.18,
  commitmentDrift: 0.18,
  trustTier: 0.14,
  injectionRate: 0.14,
  recoveryPending: 0.13,
  reAnchor: 0.05,
  discordanceScore: 0.08,
  confidenceCalibration: 0.10,
} as const;

/**
 * Compile-time weight sum assertion. Throws at module load if weights drift from 1.0.
 * The check uses a tolerance of 1e-9 to accommodate floating-point representation.
 */
const WEIGHT_SUM_CHECK = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(WEIGHT_SUM_CHECK - 1.0) > 1e-9) {
  throw new Error(`AlignmentAggregator: WEIGHTS sum to ${WEIGHT_SUM_CHECK}, expected exactly 1.0`);
}

// ---------------------------------------------------------------------------
// AlignmentAggregator
// ---------------------------------------------------------------------------

/** Extended result shape stored in _lastReport — includes runtime metadata. */
export type LastReport = AggregatorResult & {
  evaluatedAt: string;
  signals: AlignmentSignals;
  contributingSignals: string[];
};

/**
 * Aggregates six alignment signals into a single composite owner-loyalty score.
 *
 * Mirrors the veto-gate fail-open pattern:
 *   - Fail-open on error (returns GREEN with failedOpen=true).
 *   - Advisory (non-blocking) at YELLOW threshold.
 *   - Advisory system message at RED threshold — tool calls still proceed.
 */
// ---------------------------------------------------------------------------
// Tier → score mapping for the dynamic trustTier signal
// ---------------------------------------------------------------------------

const TIER_SCORE_MAP: Readonly<Record<string, number>> = {
  HIGH:      0.95,
  MEDIUM:    0.70,
  LOW:       0.40,
  PROBATION: 0.15,
};

export class AlignmentAggregator {
  private readonly log = createLogger('agent:alignment-aggregator');
  private readonly auditTrail: AuditTrailLike | null;
  private readonly trustTierTracker: TrustTierTrackerLike | null;
  private confidenceCalibrationTracker: CalibrationTrackerLike | null;
  private _lastReport: LastReport | null = null;
  /** Holds the calibration signal value from the most recent _compute() call. */
  private _lastCalibrationSignal = 1.0;
  /** Cached drift for diagnosis — set alongside _lastCalibrationSignal. */
  private _lastCalibrationDrift = 0.0;
  /** Cached Brier score for diagnosis — set alongside _lastCalibrationSignal. */
  private _lastBrierScore = 0.0;
  /**
   * Optional observer callback — fired after every evaluate() call (success or fail-open).
   * Registered by AlignmentAutoRemediator. Never throws toward caller.
   */
  private _reportObserver: ((report: LastReport) => void) | null = null;

  constructor(
    auditTrail?: AuditTrailLike,
    trustTierTracker?: TrustTierTrackerLike,
    confidenceCalibrationTracker?: CalibrationTrackerLike,
  ) {
    this.auditTrail = auditTrail ?? null;
    this.trustTierTracker = trustTierTracker ?? null;
    this.confidenceCalibrationTracker = confidenceCalibrationTracker ?? null;
    this.log.info('AlignmentAggregator initialised');
  }

  /**
   * Late-bind the calibration tracker. Used by cli.ts boot when the
   * tracker is constructed after the aggregator (the tracker depends
   * on a resolved agent loop, so it can't be wired at aggregator
   * construction). Replaces the earlier `as unknown as Record` poke.
   */
  setConfidenceCalibrationTracker(tracker: CalibrationTrackerLike): void {
    this.confidenceCalibrationTracker = tracker;
  }

  /**
   * Register a callback to be invoked after every evaluate() call.
   * Used by AlignmentAutoRemediator to observe alignment reports.
   * Pass null to unregister.
   * Never throws.
   */
  setReportObserver(cb: ((report: LastReport) => void) | null): void {
    this._reportObserver = cb;
  }

  /**
   * Compute the composite principal-directive compliance score.
   *
   * Never throws — returns failedOpen=true on any exception to preserve
   * operational continuity.
   */
  evaluate(signals: AlignmentSignals): AggregatorResult {
    try {
      const result = this._compute(signals);
      // Fire observer — _lastReport is set by _compute().
      if (this._reportObserver !== null && this._lastReport !== null) {
        try { this._reportObserver(this._lastReport); } catch { /* fail-open */ }
      }
      return result;
    } catch (err) {
      log.warn({ err: String(err) }, 'AlignmentAggregator compute error — failing open');
      const failOpenResult: AggregatorResult = {
        score: 0.75,
        level: 'GREEN',
        diagnosis: 'fail-open — alignment compute error: LEVEL=GREEN SCORE=0.750',
        failedOpen: true,
      };
      // Write _lastReport on fail-open path so getLastReport() reflects the attempt.
      this._lastReport = {
        ...failOpenResult,
        evaluatedAt: new Date().toISOString(),
        signals,
        contributingSignals: [],
      };
      // Fire observer on fail-open path too.
      if (this._reportObserver !== null) {
        try { this._reportObserver(this._lastReport); } catch { /* fail-open */ }
      }
      if (this.auditTrail) {
        try {
          this.auditTrail.recordTriple({
            mistake: 'alignment aggregator fail-open',
            learned: 'compute error in aggregator',
            commitment: 'investigate signal pipeline',
            ttl_days: 1,
          });
        } catch { /* non-fatal */ }
      }
      return failOpenResult;
    }
  }

  /**
   * Return the last computed report (including metadata), or null if
   * evaluate() has never been called on this instance.
   * Never throws — purely in-memory state.
   * State is per-process and does not survive restarts (intentional).
   */
  getLastReport(): LastReport | null {
    return this._lastReport;
  }

  /**
   * Internal compute — may throw (caller wraps in try/catch).
   * Scores each signal with configured weights and clamps to [0,1].
   */
  private _compute(signals: AlignmentSignals): AggregatorResult {
    // Resolve live trustTier signal from tracker when available (fail-open to static).
    let effectiveTrustTier = signals.trustTier;
    if (this.trustTierTracker !== null) {
      try {
        const tier = this.trustTierTracker.getCurrentTier();
        const mapped = TIER_SCORE_MAP[tier];
        if (mapped !== undefined) {
          effectiveTrustTier = mapped;
        }
      } catch (tierErr) {
        log.warn({ err: String(tierErr) }, 'AlignmentAggregator: trustTierTracker.getCurrentTier() threw — using static signal');
      }
    }

    // Resolve each signal — treat undefined/NaN as neutral (0.5 contribution).
    const resolvedOutcomeDelta = this._resolveSignal(signals.outcomeDelta);
    const resolvedCommitmentDrift = this._resolveSignal(signals.commitmentDrift);
    const resolvedTrustTier = this._resolveSignal(effectiveTrustTier);
    const resolvedInjectionRate = this._resolveSignal(signals.injectionRate);
    const resolvedRecoveryPending = this._resolveSignal(signals.recoveryPending);
    const resolvedReAnchor = this._resolveSignal(signals.reAnchor);
    const resolvedDiscordanceScore = this._resolveSignal(signals.discordanceScore);

    // Normalise outcomeDelta from [-1,+1] to [0,1].
    const normOutcome = (resolvedOutcomeDelta + 1) / 2;

    // Compute 8th signal: confidenceCalibration (Brier-drift). Fail-open → 1.0.
    const calibrationSignal = this._computeCalibrationSignal();
    this._lastCalibrationSignal = calibrationSignal;

    const rawScore =
      WEIGHTS.outcomeDelta * normOutcome +
      WEIGHTS.commitmentDrift * (1 - resolvedCommitmentDrift) +
      WEIGHTS.trustTier * resolvedTrustTier +
      WEIGHTS.injectionRate * (1 - resolvedInjectionRate) +
      WEIGHTS.recoveryPending * (1 - resolvedRecoveryPending) +
      WEIGHTS.reAnchor * resolvedReAnchor +
      // High discordance lowers the loyalty contribution (inverted pattern).
      WEIGHTS.discordanceScore * (1 - resolvedDiscordanceScore) +
      // High calibration drift lowers score; perfect calibration contributes fully.
      WEIGHTS.confidenceCalibration * calibrationSignal;

    // Clamp to [0, 1].
    const score = Math.max(0, Math.min(1, rawScore));

    if (!isFinite(score)) {
      throw new Error(`Non-finite score computed: ${String(rawScore)}`);
    }

    const level = this._scoreToLevel(score);
    const diagnosis = this._buildDiagnosis(score, level, signals);

    const result: AggregatorResult = { score, level, diagnosis, failedOpen: false };

    // Persist last report for getLastReport().
    this._lastReport = {
      ...result,
      evaluatedAt: new Date().toISOString(),
      signals,
      contributingSignals: this._extractContributingSignalKeys(signals),
    };

    return result;
  }

  /**
   * Returns the keys of AlignmentSignals that contributed meaningfully
   * to the composite score (i.e. the signal crossed its warning threshold).
   * Uses the same threshold constants as _buildDiagnosis — pure function.
   */
  private _extractContributingSignalKeys(signals: AlignmentSignals): string[] {
    const keys: string[] = [];
    if (signals.commitmentDrift > 0.6)       keys.push('commitmentDrift');
    if (signals.injectionRate > 0.6)         keys.push('injectionRate');
    if (signals.recoveryPending > 0.5)       keys.push('recoveryPending');
    if (signals.trustTier < 0.3)             keys.push('trustTier');
    if (signals.outcomeDelta < -0.5)         keys.push('outcomeDelta');
    if (signals.discordanceScore > 0.6)      keys.push('discordanceScore');
    if (this._lastCalibrationSignal < 0.7)   keys.push('confidenceCalibration');
    return keys;
  }

  /**
   * Compute the confidenceCalibration signal (8th signal) from the tracker.
   *
   * Fail-open: returns 1.0 if tracker is absent, throws, or has < 5 samples.
   * Derivation:
   *   - calibrationDrift = |overallAvgPredicted - overallSuccessRate|
   *   - drift ≤ 0.05            → 1.0
   *   - drift in (0.05, 0.15]   → linear interp 1.0 → 0.6
   *   - drift in (0.15, 0.30]   → linear interp 0.6 → 0.3
   *   - drift > 0.30            → 0.15
   *   - additionally: Brier > 0.4 → min(signal, 0.3)
   */
  private _computeCalibrationSignal(): number {
    // No tracker wired — insufficient data, don't penalize.
    if (this.confidenceCalibrationTracker === null) {
      this._lastCalibrationDrift = 0.0;
      this._lastBrierScore = 0.0;
      return 1.0;
    }

    let report: { totalSamples: number; brierScore: number; overallAvgPredicted: number; overallSuccessRate: number };
    try {
      report = this.confidenceCalibrationTracker.getReport({ windowDays: 7 });
    } catch (err) {
      log.warn({ err: String(err) }, 'AlignmentAggregator: confidenceCalibrationTracker.getReport() threw — failing open');
      this._lastCalibrationDrift = 0.0;
      this._lastBrierScore = 0.0;
      return 1.0;
    }

    // Not enough data to penalize.
    if (report.totalSamples < 5) {
      this._lastCalibrationDrift = 0.0;
      this._lastBrierScore = report.brierScore ?? 0.0;
      return 1.0;
    }

    const drift = Math.abs(report.overallAvgPredicted - report.overallSuccessRate);
    const brier = report.brierScore;
    this._lastCalibrationDrift = drift;
    this._lastBrierScore = brier;

    let signal: number;
    if (drift <= 0.05) {
      signal = 1.0;
    } else if (drift <= 0.15) {
      // Linear interp from 1.0 → 0.6 over (0.05, 0.15].
      signal = 1.0 - ((drift - 0.05) / 0.10) * 0.4;
    } else if (drift <= 0.30) {
      // Linear interp from 0.6 → 0.3 over (0.15, 0.30].
      signal = 0.6 - ((drift - 0.15) / 0.15) * 0.3;
    } else {
      signal = 0.15;
    }

    // Brier score penalty: very poorly calibrated predictions get capped.
    if (brier > 0.4) {
      signal = Math.min(signal, 0.3);
    }

    return signal;
  }

  /**
   * Resolve a signal value — treats undefined, null, NaN, and Infinity
   * as neutral (0.5) to preserve fail-open continuity assurance.
   */
  private _resolveSignal(value: number | undefined | null): number {
    if (value === undefined || value === null || !isFinite(value) || isNaN(value)) {
      log.warn({ value }, 'AlignmentAggregator: signal undefined or non-finite — treating as neutral 0.5');
      return 0.5;
    }
    return value;
  }

  /** Derive traffic-light level from numeric score. */
  private _scoreToLevel(score: number): AlignmentLevel {
    if (score >= THRESHOLD_GREEN) return 'GREEN';
    if (score >= THRESHOLD_YELLOW) return 'YELLOW';
    return 'RED';
  }

  /**
   * Build a human-readable diagnosis string for system message injection.
   * Always includes numeric score and level label (required by test B-8).
   */
  private _buildDiagnosis(score: number, level: AlignmentLevel, signals: AlignmentSignals): string {
    const contributing: string[] = [];

    if (signals.commitmentDrift > 0.6) {
      contributing.push('agent may be drifting from prior commitments to you');
    }
    if (signals.injectionRate > 0.6) {
      contributing.push('recent inputs contain suspicious patterns (possible injection attempt)');
    }
    if (signals.recoveryPending > 0.5) {
      contributing.push('an unresolved error recovery commitment is active');
    }
    if (signals.trustTier < 0.3) {
      contributing.push('principal trust level is low — re-verify owner context');
    }
    if (signals.outcomeDelta < -0.5) {
      contributing.push('recent outcomes are degraded compared to baseline');
    }
    if (signals.discordanceScore > 0.6) {
      contributing.push('cross-stream discordance elevated');
    }
    if (this._lastCalibrationSignal < 0.5) {
      const drift = this._lastCalibrationDrift;
      const brier = this._lastBrierScore;
      contributing.push(
        `confidence calibration drift detected: predictions diverge from outcomes (Brier=${brier.toFixed(3)}, drift=${drift.toFixed(3)})`,
      );
    }

    const factorSummary = contributing.length > 0
      ? ` Factors: ${contributing.join(', ')}.`
      : '';

    return `LEVEL=${level} SCORE=${score.toFixed(3)} — owner-loyalty continuity check.${factorSummary} Suggest: review recent tool calls or send a clarifying message.`;
  }
}
