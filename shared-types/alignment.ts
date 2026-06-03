/**
 * Alignment-related types for SUDO-AI v4.
 * Pure type definitions - no runtime code.
 */

/** Traffic-light level derived from composite owner-loyalty score. */
export type AlignmentLevel = 'GREEN' | 'YELLOW' | 'RED' | 'warming-up';

/**
 * Alignment report returned from AlignmentAggregator.evaluate().
 * Matches AggregatorResult + metadata from admin-routes.ts line 43-48.
 */
export type AlignmentReport = {
  /** Composite 0-1 score. Higher = better principal-directive compliance. */
  score: number | null;
  /** Traffic-light level. */
  level: AlignmentLevel;
  /** Status indicator for warming-up state. */
  status?: 'warming-up' | null;
  /** Human-readable diagnosis including score and level. */
  diagnosis: string;
  /** True when compute error occurred and safe defaults returned. */
  failedOpen: boolean;
  /** ISO 8601 timestamp of evaluation. */
  evaluatedAt: string | null;
  /** Signals that contributed meaningfully to the score. */
  contributingSignals: string[];
};

/**
 * Trust tier snapshot from TrustTierTracker.
 * Matches getAuditSnapshot() return shape (admin-routes.ts line 84-90).
 */
export type TrustSnapshot = {
  /** Trust tier: HIGH | MEDIUM | LOW | PROBATION. */
  tier: string;
  /** Trust score 0-1. */
  score: number;
  /** Window size in days for trust computation. */
  windowSizeDays: number;
  /** ISO 8601 timestamp of last adjustment. */
  lastAdjustedAt: string;
};

/**
 * Calibration report from ConfidenceCalibrationTracker.
 * Matches getReport() return shape (admin-routes.ts line 131-148).
 */
export type CalibrationReport = {
  /** Number of samples in the window. */
  totalSamples: number;
  /** Brier score (lower = better calibration). */
  brierScore: number;
  /** Average predicted probability across all samples. */
  overallAvgPredicted: number;
  /** Actual success rate across all samples. */
  overallSuccessRate: number;
  /** Calibration buckets for detailed analysis. */
  buckets?: Array<{
    bucket: string;
    rangeLow: number;
    rangeHigh: number;
    count: number;
    avgPredicted: number;
    actualSuccessRate: number;
    calibrationError: number;
  }>;
  /** Window size in days. */
  windowDays: number;
  /** ISO 8601 timestamp of computation. */
  computedAt: string;
};

/**
 * Veto threshold data from AutoThresholdTuner.
 * Matches handleVetoThresholdGet response (admin-routes.ts line 1568-1601).
 */
export type VetoThresholdData = {
  /** Static base threshold (typically 0.5). */
  baseThreshold: number;
  /** Effective threshold after Brier-driven adjustment. */
  effectiveThreshold: number;
  /** Current Brier score from calibration tracker. */
  brierScore: number;
  /** Total samples used for Brier computation. */
  totalSamples: number;
  /** Adjustment amount (effective - base). */
  adjustment: number;
  /** ISO 8601 timestamp of computation. */
  computedAt: string;
  /** Whether auto-tuning is enabled (SUDO_VETO_AUTO_TUNE=1). */
  autoTuneEnabled: boolean;
};
