/**
 * Digest endpoint response types for SUDO-AI v4.
 * Pure type definitions - no runtime code.
 */

import type { AlignmentReport } from './alignment.js';

/**
 * Digest snapshot returned from GET /v1/admin/digest.
 * Matches collectDigestSnapshot() return shape (admin-routes.ts line 1289-1428).
 * Window days parameter for the digest query.
 */
export type DigestSnapshot = {
  /** Number of days for the digest window (1-90, default 7). */
  windowDays: number;
  /** ISO 8601 timestamp when digest was computed. */
  computedAt: string;
  /** Alignment state from AlignmentAggregator. */
  alignment: AlignmentReport | null;
  /** Trust tier snapshot from TrustTierTracker. */
  trust: {
    tier: string;
    score: number;
    windowSizeDays: number;
    lastAdjustedAt: string;
  } | null;
  /** Calibration report from ConfidenceCalibrationTracker. */
  calibration: {
    totalSamples: number;
    brierScore: number;
    overallAvgPredicted: number;
    overallSuccessRate: number;
  } | null;
  /** Commitment expiry counts from CommitmentAuditor. */
  commitments: {
    expiringCount: number | null;
    expiredCount: number | null;
  } | null;
  /** Epistemic gate stats from EpistemicGate. */
  epistemic: {
    total: number;
    byTag: Record<'CERTAIN' | 'PROBABLE' | 'CONJECTURE' | 'UNKNOWN', number>;
    byDecision: Record<'PASS' | 'BLOCK' | 'UNCERTAIN', number>;
    blockRate: number;
    window: { sinceMs: number; untilMs: number };
  } | null;
  /** Mistake pattern analysis from MistakePatternRecognizer. */
  patterns: {
    totalMistakes: number;
    uniquePatterns: number;
    recurringCount: number;
  } | null;
  /** Cross-signal diagnostics from CrossSignalDiagnostics. */
  diagnostics: {
    totalEventsScanned: number;
    correlationCount: number;
    topCorrelation: {
      leadingSpike: { source: string; kind: string; ts: number; count: number };
      trailingSpike: { source: string; kind: string; ts: number; count: number };
      deltaMs: number;
      confidence: number;
    } | null;
  } | null;
  /** Injection detection stats from TrustTierTracker. */
  injection: {
    count: number;
    score: number;
  } | null;
  /** Re-anchor event stats from ReAnchorMonitor. */
  reanchor: {
    total: number;
    byTrigger: Record<string, number>;
    windowDays: number;
    computedAt: string;
    lastReAnchorAt?: number;
  } | null;
  /** Commitment resolution stats from CommitmentResolutionTracker. */
  resolutions: {
    total: number;
    honored: number;
    abandoned: number;
    expiredAcknowledged: number;
    honorRate: number;
    windowDays: number;
    computedAt: string;
  } | null;
};

/**
 * Response envelope for GET /v1/admin/digest.
 */
export type DigestResponse = {
  ok: boolean;
  data: DigestSnapshot;
};
