/**
 * @file tests/cognition/auto-threshold-tuner.test.ts
 * @description Wave 7C: AutoThresholdTuner unit tests.
 *
 * Tests:
 *   ATT-1   Brier <= 0.10 → no adjustment (return baseThreshold)
 *   ATT-2   Brier in (0.10, 0.25] → linear reduction up to 0.10
 *   ATT-3   Brier in (0.25, 0.40] → linear reduction 0.10 to 0.20
 *   ATT-4   Brier > 0.40 → cap at -0.25
 *   ATT-5   totalSamples < 5 → no adjustment (return baseThreshold)
 *   ATT-6   tracker throws → fail-open (return baseThreshold)
 *   ATT-7   result clamped to [0.3, 0.95] lower bound
 *   ATT-8   result clamped to [0.3, 0.95] upper bound (high base)
 *   ATT-9   getLastComputation returns null before first call
 *   ATT-10  getLastComputation reflects last computation
 *   ATT-11  Brier exactly 0.10 → no adjustment (boundary)
 *   ATT-12  Brier exactly 0.25 → max partial adjustment (boundary)
 *   ATT-13  Brier exactly 0.40 → max full adjustment (boundary)
 *   ATT-14  Insufficient samples → adjustment is 0 in lastComputation
 *   ATT-15  Tracker error → lastComputation reflects fail-open state
 */

import { describe, it, expect } from 'vitest';
import {
  AutoThresholdTuner,
  type CalibrationTrackerLike,
} from '../../src/core/cognition/auto-threshold-tuner.js';

// ---------------------------------------------------------------------------
// Helper: build a mock tracker returning given brier + samples
// ---------------------------------------------------------------------------

function makeTracker(brierScore: number, totalSamples: number): CalibrationTrackerLike {
  return {
    getReport: () => ({ brierScore, totalSamples }),
  };
}

function makeThrowingTracker(): CalibrationTrackerLike {
  return {
    getReport: () => {
      throw new Error('DB unavailable');
    },
  };
}

const BASE = 0.5; // standard base threshold used in tests

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AutoThresholdTuner', () => {
  // ATT-1: Brier <= 0.10 → no adjustment
  it('ATT-1: Brier=0.05 (<=0.10) → returns baseThreshold unchanged', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.05, 20));
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(BASE, 6);
  });

  // ATT-2: Brier in (0.10, 0.25] → linear reduction up to 0.10
  it('ATT-2: Brier=0.175 (midpoint of 0.10–0.25) → reduction of ~0.05', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.175, 20));
    // fraction = (0.175 - 0.10) / (0.25 - 0.10) = 0.075/0.15 = 0.5
    // adjustment = 0.5 * 0.10 = 0.05
    // effective = 0.5 - 0.05 = 0.45
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(0.45, 5);
  });

  // ATT-3: Brier in (0.25, 0.40] → linear from 0.10 to 0.20
  it('ATT-3: Brier=0.325 (midpoint of 0.25–0.40) → reduction of ~0.15', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.325, 20));
    // fraction = (0.325 - 0.25) / (0.40 - 0.25) = 0.075/0.15 = 0.5
    // adjustment = 0.10 + 0.5 * (0.20 - 0.10) = 0.10 + 0.05 = 0.15
    // effective = 0.5 - 0.15 = 0.35
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(0.35, 5);
  });

  // ATT-4: Brier > 0.40 → cap at 0.25
  it('ATT-4: Brier=0.80 (>0.40) → capped reduction of 0.25', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.80, 20));
    // adjustment = 0.25 (cap)
    // effective = 0.5 - 0.25 = 0.25 → clamped to 0.30
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(0.30, 5);
  });

  // ATT-5: totalSamples < 5 → no adjustment
  it('ATT-5: totalSamples=3 (insufficient) → returns baseThreshold unchanged', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.50, 3));
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(BASE, 6);
  });

  // ATT-6: tracker throws → fail-open, return baseThreshold
  it('ATT-6: tracker throws → fail-open, returns baseThreshold', () => {
    const tuner = new AutoThresholdTuner(makeThrowingTracker());
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(BASE, 6);
  });

  // ATT-7: clamp to lower bound [0.30]
  it('ATT-7: large brier with low base → clamped to 0.30', () => {
    // base=0.50, Brier=0.99 → adjustment=0.25, effective=0.25 → clamped to 0.30
    const tuner = new AutoThresholdTuner(makeTracker(0.99, 20));
    const result = tuner.computeVetoThreshold(0.5);
    expect(result).toBeGreaterThanOrEqual(0.30);
    expect(result).toBeCloseTo(0.30, 5);
  });

  // ATT-8: clamp to upper bound [0.95] — base too high
  it('ATT-8: base=0.99 with no adjustment → clamped to 0.95', () => {
    // Brier <= 0.10 → no adjustment, rawEffective = 0.99 - 0 = 0.99
    // Clamp: Math.max(0.30, Math.min(0.95, 0.99)) = 0.95
    const tuner = new AutoThresholdTuner(makeTracker(0.05, 20));
    const result = tuner.computeVetoThreshold(0.99);
    expect(result).toBeCloseTo(0.95, 5);
  });

  // ATT-9: getLastComputation null before any call
  it('ATT-9: getLastComputation() returns null before first computeVetoThreshold()', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.20, 20));
    expect(tuner.getLastComputation()).toBeNull();
  });

  // ATT-10: getLastComputation reflects last call
  it('ATT-10: getLastComputation() returns data from last computation', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.20, 20));
    tuner.computeVetoThreshold(BASE);
    const comp = tuner.getLastComputation();
    expect(comp).not.toBeNull();
    expect(comp!.baseThreshold).toBe(BASE);
    expect(comp!.totalSamples).toBe(20);
    expect(comp!.brierScore).toBeCloseTo(0.20, 6);
    expect(typeof comp!.computedAt).toBe('string');
    expect(comp!.adjustment).toBeGreaterThan(0);
  });

  // ATT-11: Brier exactly 0.10 → no adjustment (boundary)
  it('ATT-11: Brier=0.10 (exact boundary) → no adjustment', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.10, 20));
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(BASE, 6);
  });

  // ATT-12: Brier exactly 0.25 → max partial zone adjustment (0.10)
  it('ATT-12: Brier=0.25 (upper boundary of partial zone) → reduction of 0.10', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.25, 20));
    // fraction = (0.25 - 0.10) / (0.25 - 0.10) = 1.0
    // adjustment = 1.0 * 0.10 = 0.10
    // effective = 0.5 - 0.10 = 0.40
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(0.40, 5);
  });

  // ATT-13: Brier exactly 0.40 → max full zone adjustment (0.20)
  it('ATT-13: Brier=0.40 (upper boundary of full zone) → reduction of 0.20', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.40, 20));
    // fraction = (0.40 - 0.25) / (0.40 - 0.25) = 1.0
    // adjustment = 0.10 + 1.0 * (0.20 - 0.10) = 0.20
    // effective = 0.5 - 0.20 = 0.30
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(0.30, 5);
  });

  // ATT-14: Insufficient samples → adjustment is 0 in lastComputation
  it('ATT-14: insufficient samples → getLastComputation shows adjustment=0', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.50, 4));
    tuner.computeVetoThreshold(BASE);
    const comp = tuner.getLastComputation();
    expect(comp).not.toBeNull();
    expect(comp!.adjustment).toBe(0);
    expect(comp!.effectiveThreshold).toBeCloseTo(BASE, 6);
    expect(comp!.totalSamples).toBe(4);
  });

  // ATT-15: Tracker error → lastComputation reflects fail-open state
  it('ATT-15: tracker throws → lastComputation shows brierScore=0, totalSamples=0', () => {
    const tuner = new AutoThresholdTuner(makeThrowingTracker());
    tuner.computeVetoThreshold(BASE);
    const comp = tuner.getLastComputation();
    expect(comp).not.toBeNull();
    expect(comp!.adjustment).toBe(0);
    expect(comp!.brierScore).toBe(0);
    expect(comp!.totalSamples).toBe(0);
    expect(comp!.effectiveThreshold).toBeCloseTo(BASE, 6);
  });

  // ATT-16: Multiple calls update lastComputation each time
  it('ATT-16: repeated calls update getLastComputation()', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.15, 20));
    tuner.computeVetoThreshold(BASE);
    const comp1 = tuner.getLastComputation();

    // Second call with different base
    tuner.computeVetoThreshold(0.6);
    const comp2 = tuner.getLastComputation();

    expect(comp1!.baseThreshold).toBe(BASE);
    expect(comp2!.baseThreshold).toBe(0.6);
  });

  // ATT-17: Brier=0 (perfect calibration) → no adjustment
  it('ATT-17: Brier=0.0 (perfect calibration) → no adjustment', () => {
    const tuner = new AutoThresholdTuner(makeTracker(0.0, 100));
    expect(tuner.computeVetoThreshold(BASE)).toBeCloseTo(BASE, 6);
  });
});
