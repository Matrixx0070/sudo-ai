/**
 * @file tests/agent/alignment-aggregator-calibration.test.ts
 * @description Wave 6P: AlignmentAggregator 8th signal — confidenceCalibration (Brier-drift).
 *
 * Tests:
 *   CAL-1:  signal = 1.0 when no calibration tracker is wired
 *   CAL-2:  signal = 1.0 when totalSamples < 5 (insufficient data)
 *   CAL-3:  signal = 1.0 when drift = 0 (perfect calibration)
 *   CAL-4:  signal ≈ 0.6 at drift = 0.15 (upper bound of first interpolation range)
 *   CAL-5:  signal = 0.15 at drift > 0.30 (floor)
 *   CAL-6:  Brier > 0.4 caps signal at 0.3
 *   CAL-7:  fail-open on getReport throw → signal = 1.0 (no composite degradation)
 *   CAL-8:  WEIGHT_SUM_CHECK still passes with new 8-signal weights
 *   CAL-9:  contributingSignals includes 'confidenceCalibration' when signal < 0.7
 *   CAL-10: diagnosis line appears when calibration signal < 0.5
 *   CAL-11: no diagnosis line when calibration signal >= 0.5
 */

import { describe, it, expect } from 'vitest';
import {
  AlignmentAggregator,
  type AlignmentSignals,
  type CalibrationTrackerLike,
} from '../../src/core/agent/alignment-aggregator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fully compliant base signals — no tracker so calibration defaults to 1.0. */
function baseSignals(): AlignmentSignals {
  return {
    outcomeDelta: 0.5,
    commitmentDrift: 0.0,
    trustTier: 1.0,
    injectionRate: 0.0,
    recoveryPending: 0.0,
    reAnchor: 0.0,
    discordanceScore: 0.0,
  };
}

/** All-neutral signals for isolated score arithmetic. */
function neutralSignals(): AlignmentSignals {
  return {
    outcomeDelta: 0.0,
    commitmentDrift: 0.0,
    trustTier: 0.0,
    injectionRate: 0.0,
    recoveryPending: 0.0,
    reAnchor: 0.0,
    discordanceScore: 0.0,
  };
}

/** Build a minimal mock CalibrationTrackerLike. */
function makeTracker(opts: {
  totalSamples: number;
  brierScore: number;
  overallAvgPredicted: number;
  overallSuccessRate: number;
  throwOnGet?: boolean;
}): CalibrationTrackerLike {
  return {
    getReport(_o?) {
      if (opts.throwOnGet) {
        throw new Error('mock getReport failure');
      }
      return {
        totalSamples: opts.totalSamples,
        brierScore: opts.brierScore,
        overallAvgPredicted: opts.overallAvgPredicted,
        overallSuccessRate: opts.overallSuccessRate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CAL-1: no tracker → signal 1.0 (GREEN contribution)
// ---------------------------------------------------------------------------

describe('CAL-1: no calibration tracker wired → signal 1.0, no penalisation', () => {
  it('score without tracker equals score with manually-set perfect calibration', () => {
    const aggNoTracker = new AlignmentAggregator();

    // Perfect tracker (drift=0, samples=10) should yield the same score.
    const perfectTracker = makeTracker({
      totalSamples: 10,
      brierScore: 0.0,
      overallAvgPredicted: 0.7,
      overallSuccessRate: 0.7,
    });
    const aggPerfect = new AlignmentAggregator(undefined, undefined, perfectTracker);

    const sig = baseSignals();
    const r1 = aggNoTracker.evaluate(sig);
    const r2 = aggPerfect.evaluate(sig);

    // Both should produce GREEN and equal scores.
    expect(r1.level).toBe('GREEN');
    expect(r2.level).toBe('GREEN');
    expect(r1.score).toBeCloseTo(r2.score, 5);
  });
});

// ---------------------------------------------------------------------------
// CAL-2: totalSamples < 5 → signal 1.0
// ---------------------------------------------------------------------------

describe('CAL-2: totalSamples < 5 → insufficient data, signal = 1.0', () => {
  it('does not penalise when there are fewer than 5 calibration samples', () => {
    const sparseTracker = makeTracker({
      totalSamples: 3,
      brierScore: 0.5,          // would penalise if data were sufficient
      overallAvgPredicted: 0.9,
      overallSuccessRate: 0.1,  // extreme drift, but ignored
    });

    const aggSparse = new AlignmentAggregator(undefined, undefined, sparseTracker);
    const aggNone = new AlignmentAggregator();

    const sig = baseSignals();
    const rSparse = aggSparse.evaluate(sig);
    const rNone = aggNone.evaluate(sig);

    // Sparse tracker should produce same score as no tracker (both signal=1.0).
    expect(rSparse.score).toBeCloseTo(rNone.score, 5);
    expect(rSparse.failedOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAL-3: drift = 0 → signal 1.0
// ---------------------------------------------------------------------------

describe('CAL-3: drift = 0 (perfect calibration) → signal 1.0', () => {
  it('perfect calibration produces no score reduction vs no tracker', () => {
    const perfectTracker = makeTracker({
      totalSamples: 20,
      brierScore: 0.1,
      overallAvgPredicted: 0.65,
      overallSuccessRate: 0.65,  // drift = 0
    });

    const aggPerfect = new AlignmentAggregator(undefined, undefined, perfectTracker);
    const aggNone = new AlignmentAggregator();

    const sig = baseSignals();
    const rPerfect = aggPerfect.evaluate(sig);
    const rNone = aggNone.evaluate(sig);

    expect(rPerfect.score).toBeCloseTo(rNone.score, 5);
    expect(rPerfect.failedOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAL-4: drift = 0.15 → signal ≈ 0.6 (upper bound of first range)
// ---------------------------------------------------------------------------

describe('CAL-4: drift = 0.15 → signal = 0.6 (linear interp boundary)', () => {
  it('calibration at max of first range yields signal = 0.6', () => {
    // drift = |0.80 - 0.65| = 0.15 exactly.
    const tracker = makeTracker({
      totalSamples: 10,
      brierScore: 0.2,       // < 0.4 so no Brier cap
      overallAvgPredicted: 0.80,
      overallSuccessRate: 0.65,
    });

    const aggWithTracker = new AlignmentAggregator(undefined, undefined, tracker);
    const aggNone = new AlignmentAggregator();

    const sig = neutralSignals();
    const rWithTracker = aggWithTracker.evaluate(sig);
    const rNone = aggNone.evaluate(sig);

    // With calibration=0.6: score = base + 0.10 * 0.6 = base + 0.06
    // Without tracker: score = base + 0.10 * 1.0 = base + 0.10
    // Difference should be 0.10 - 0.06 = 0.04.
    const diff = rNone.score - rWithTracker.score;
    expect(diff).toBeCloseTo(0.04, 4);
    expect(rWithTracker.failedOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAL-5: drift > 0.30 → signal = 0.15 (floor)
// ---------------------------------------------------------------------------

describe('CAL-5: drift > 0.30 → signal floor = 0.15', () => {
  it('severe calibration drift produces signal floor of 0.15', () => {
    // drift = |0.9 - 0.5| = 0.40 > 0.30.
    const tracker = makeTracker({
      totalSamples: 20,
      brierScore: 0.2,       // < 0.4 so no Brier cap
      overallAvgPredicted: 0.90,
      overallSuccessRate: 0.50,
    });

    const aggWithTracker = new AlignmentAggregator(undefined, undefined, tracker);
    const aggNone = new AlignmentAggregator();

    const sig = neutralSignals();
    const rWithTracker = aggWithTracker.evaluate(sig);
    const rNone = aggNone.evaluate(sig);

    // With calibration=0.15: contribution = 0.10 * 0.15 = 0.015
    // Without tracker: contribution = 0.10 * 1.0 = 0.10
    // Difference should be 0.10 - 0.015 = 0.085.
    const diff = rNone.score - rWithTracker.score;
    expect(diff).toBeCloseTo(0.085, 4);
    expect(rWithTracker.failedOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAL-6: Brier > 0.4 caps signal at 0.3
// ---------------------------------------------------------------------------

describe('CAL-6: Brier > 0.4 caps calibration signal at 0.3', () => {
  it('high Brier score overrides drift-derived signal via min(signal, 0.3)', () => {
    // drift = 0.02 → signal would be ~1.0 without Brier cap.
    // But brierScore=0.45 > 0.4 → signal capped at 0.3.
    const tracker = makeTracker({
      totalSamples: 15,
      brierScore: 0.45,
      overallAvgPredicted: 0.52,
      overallSuccessRate: 0.50,  // drift = 0.02 (low)
    });

    const aggWithTracker = new AlignmentAggregator(undefined, undefined, tracker);
    const aggNone = new AlignmentAggregator();

    const sig = neutralSignals();
    const rWithTracker = aggWithTracker.evaluate(sig);
    const rNone = aggNone.evaluate(sig);

    // calibration=0.3: contribution = 0.10 * 0.3 = 0.03
    // Without tracker: contribution = 0.10 * 1.0 = 0.10
    // Difference should be 0.10 - 0.03 = 0.07.
    const diff = rNone.score - rWithTracker.score;
    expect(diff).toBeCloseTo(0.07, 4);
    expect(rWithTracker.failedOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CAL-7: getReport throws → fail-open → signal 1.0
// ---------------------------------------------------------------------------

describe('CAL-7: getReport throws → fail-open → signal = 1.0', () => {
  it('aggregator does not degrade when calibration tracker throws', () => {
    const throwingTracker = makeTracker({
      totalSamples: 10,
      brierScore: 0,
      overallAvgPredicted: 0,
      overallSuccessRate: 0,
      throwOnGet: true,
    });

    const aggThrowing = new AlignmentAggregator(undefined, undefined, throwingTracker);
    const aggNone = new AlignmentAggregator();

    const sig = baseSignals();
    const rThrowing = aggThrowing.evaluate(sig);
    const rNone = aggNone.evaluate(sig);

    // Throwing tracker should produce same score as no tracker (both signal=1.0).
    expect(rThrowing.score).toBeCloseTo(rNone.score, 5);
    expect(rThrowing.failedOpen).toBe(false);
    expect(rThrowing.level).toBe('GREEN');
  });
});

// ---------------------------------------------------------------------------
// CAL-8: WEIGHT_SUM_CHECK passes with 8-signal weights
// ---------------------------------------------------------------------------

describe('CAL-8: WEIGHT_SUM_CHECK passes — 8 weights sum to exactly 1.0', () => {
  it('module loads without error and weight assertion passes', () => {
    // If the module loaded, the assertion passed. Verify a compute works cleanly.
    const agg = new AlignmentAggregator();
    expect(() => agg.evaluate(baseSignals())).not.toThrow();

    // Verify new weight totals by checking isolated contribution arithmetic.
    // With all-zero AlignmentSignals + no calibration tracker (signal=1.0):
    // normOutcome = 0.5, all others 0 or inverted.
    // Score = 0.18*0.5 + 0.18*(1-0) + 0.14*0 + 0.14*(1-0)
    //       + 0.13*(1-0) + 0.05*0 + 0.08*(1-0) + 0.10*1.0
    // = 0.09 + 0.18 + 0 + 0.14 + 0.13 + 0 + 0.08 + 0.10 = 0.72
    const sig = neutralSignals(); // all zeros
    const result = agg.evaluate(sig);
    expect(result.score).toBeCloseTo(0.72, 5);
    expect(isFinite(result.score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CAL-9: contributingSignals includes 'confidenceCalibration' when signal < 0.7
// ---------------------------------------------------------------------------

describe('CAL-9: contributingSignals includes confidenceCalibration when signal < 0.7', () => {
  it('includes confidenceCalibration key when drift = 0.20 (signal ≈ 0.4)', () => {
    // drift = |0.80 - 0.60| = 0.20 → in (0.15, 0.30] range
    // signal = 0.6 - ((0.20 - 0.15) / 0.15) * 0.3 = 0.6 - 0.1 = 0.5 — but let's use 0.25 drift
    // drift = 0.25: signal = 0.6 - ((0.25 - 0.15) / 0.15) * 0.3 = 0.6 - 0.2 = 0.4 < 0.7 ✓
    const tracker = makeTracker({
      totalSamples: 20,
      brierScore: 0.2,
      overallAvgPredicted: 0.85,
      overallSuccessRate: 0.60, // drift = 0.25
    });

    const agg = new AlignmentAggregator(undefined, undefined, tracker);
    agg.evaluate(baseSignals());
    const report = agg.getLastReport();

    expect(report).not.toBeNull();
    expect(report!.contributingSignals).toContain('confidenceCalibration');
  });

  it('does NOT include confidenceCalibration when no tracker (signal = 1.0)', () => {
    const agg = new AlignmentAggregator();
    agg.evaluate(baseSignals());
    const report = agg.getLastReport();

    expect(report).not.toBeNull();
    expect(report!.contributingSignals).not.toContain('confidenceCalibration');
  });

  it('does NOT include confidenceCalibration when signal = 0.7 exactly (threshold boundary)', () => {
    // drift = 0.10 → signal = 1.0 - (0.10-0.05)/0.10 * 0.4 = 1.0 - 0.2 = 0.8 — not < 0.7
    // To get signal exactly 0.7: 1.0 - (drift-0.05)/0.10 * 0.4 = 0.7
    // (drift-0.05)/0.10 * 0.4 = 0.3 → (drift-0.05) = 0.075 → drift = 0.125
    // signal = 1.0 - (0.125-0.05)/0.10 * 0.4 = 1.0 - 0.3 = 0.7 → NOT < 0.7
    const tracker = makeTracker({
      totalSamples: 10,
      brierScore: 0.1,
      overallAvgPredicted: 0.725,
      overallSuccessRate: 0.600, // drift = 0.125 → signal = 0.7
    });

    const agg = new AlignmentAggregator(undefined, undefined, tracker);
    agg.evaluate(baseSignals());
    const report = agg.getLastReport();

    expect(report).not.toBeNull();
    // signal = 0.7 is NOT < 0.7, so should not appear.
    expect(report!.contributingSignals).not.toContain('confidenceCalibration');
  });
});

// ---------------------------------------------------------------------------
// CAL-10: diagnosis line appears when calibration signal < 0.5
// ---------------------------------------------------------------------------

describe('CAL-10: diagnosis includes calibration warning when signal < 0.5', () => {
  it('includes Brier and drift info when calibration signal is below 0.5', () => {
    // drift = 0.30 exactly: signal = 0.6 - ((0.30-0.15)/0.15)*0.3 = 0.6 - 0.3 = 0.3 < 0.5
    const tracker = makeTracker({
      totalSamples: 20,
      brierScore: 0.25,
      overallAvgPredicted: 0.90,
      overallSuccessRate: 0.60, // drift = 0.30
    });

    const agg = new AlignmentAggregator(undefined, undefined, tracker);
    const result = agg.evaluate(baseSignals());

    expect(result.diagnosis).toContain('confidence calibration drift detected');
    expect(result.diagnosis).toContain('Brier=');
    expect(result.diagnosis).toContain('drift=');
  });
});

// ---------------------------------------------------------------------------
// CAL-11: no diagnosis line when calibration signal >= 0.5
// ---------------------------------------------------------------------------

describe('CAL-11: no calibration warning in diagnosis when signal >= 0.5', () => {
  it('omits calibration line when drift = 0.10 (signal ≈ 0.8)', () => {
    // drift = 0.10 → signal = 1.0 - (0.10-0.05)/0.10 * 0.4 = 1.0 - 0.2 = 0.8 >= 0.5
    const tracker = makeTracker({
      totalSamples: 10,
      brierScore: 0.1,
      overallAvgPredicted: 0.75,
      overallSuccessRate: 0.65, // drift = 0.10
    });

    const agg = new AlignmentAggregator(undefined, undefined, tracker);
    const result = agg.evaluate(baseSignals());

    expect(result.diagnosis).not.toContain('confidence calibration drift detected');
  });

  it('omits calibration line when no tracker (signal = 1.0)', () => {
    const agg = new AlignmentAggregator();
    const result = agg.evaluate(baseSignals());
    expect(result.diagnosis).not.toContain('confidence calibration drift detected');
  });
});
