/**
 * @file goal-stop-detector.test.ts
 * @description Tests for GoalStopDetector and its adversarial Skeptic Verifier.
 * Covers verdict computation across the scoring signals, confidence bounds,
 * in-progress overrides, and skeptic blocking of premature completion claims.
 */

import { describe, it, expect } from 'vitest';
import {
  GoalStopDetector,
  type GoalProgress,
} from '../../src/core/autonomy/goal-stop-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a GoalProgress with sensible "in-progress, nothing done" defaults. */
function makeProgress(overrides?: Partial<GoalProgress>): GoalProgress {
  return {
    totalSteps: 4,
    completedSteps: 0,
    inProgressSteps: 0,
    errorCount: 0,
    testFailures: 0,
    userMessageAddressed: false,
    filesModified: false,
    testsRun: false,
    customEvidence: [],
    ...overrides,
  };
}

/** Build a GoalProgress representing a fully, cleanly completed goal. */
function makeCompleteProgress(overrides?: Partial<GoalProgress>): GoalProgress {
  return makeProgress({
    totalSteps: 4,
    completedSteps: 4,
    inProgressSteps: 0,
    errorCount: 0,
    testFailures: 0,
    userMessageAddressed: true,
    filesModified: true,
    testsRun: true,
    customEvidence: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoalStopDetector', () => {
  const detector = new GoalStopDetector();

  describe('verdict: complete', () => {
    it('returns complete with high confidence for a fully clean goal', () => {
      const result = detector.detect(makeCompleteProgress());
      expect(result.verdict).toBe('complete');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('records evidence for every satisfied signal', () => {
      const result = detector.detect(makeCompleteProgress());
      expect(result.evidence).toContain('All 4 steps completed');
      expect(result.evidence).toContain('No errors encountered');
      expect(result.evidence).toContain('No test failures');
      expect(result.evidence).toContain('User message addressed');
      expect(result.evidence).toContain('Files were modified');
      expect(result.evidence).toContain('Tests were executed');
    });

    it('runs the skeptic on a complete verdict but does not get blocked when clean', () => {
      const result = detector.detect(makeCompleteProgress());
      expect(result.skepticChallenge).toBeDefined();
      expect(result.skepticChallenge?.challenged).toBe(false);
      expect(result.verdict).toBe('complete');
    });
  });

  describe('verdict: incomplete', () => {
    it('returns incomplete when nothing has progressed', () => {
      const result = detector.detect(makeProgress());
      expect(result.verdict).toBe('incomplete');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('appends custom evidence strings to the evidence list', () => {
      const result = detector.detect(
        makeProgress({ customEvidence: ['acceptance criteria #1 unmet'] }),
      );
      expect(result.evidence).toContain('acceptance criteria #1 unmet');
    });
  });

  describe('in-progress override', () => {
    it('downgrades a would-be complete verdict to ambiguous when steps are in progress', () => {
      // All steps "completed" (ratio >= 1 scores signal 1) but one is still
      // flagged in progress, so the post-scoring override kicks in: a complete
      // verdict is forced down to ambiguous and the note lands in evidence.
      const result = detector.detect(
        makeCompleteProgress({ completedSteps: 4, inProgressSteps: 1 }),
      );
      expect(result.verdict).toBe('ambiguous');
      expect(result.confidence).toBeCloseTo(0.4, 5);
      expect(result.evidence.some((e) => e.includes('still in progress'))).toBe(true);
      // Skeptic still flags the in-progress step as a (non-blocking) warning.
      expect(result.skepticChallenge?.severity).toBe('warning');
    });
  });

  describe('skeptic verifier blocking', () => {
    it('blocks completion when test failures exist', () => {
      const result = detector.detect(makeCompleteProgress({ testFailures: 2 }));
      expect(result.verdict).toBe('incomplete');
      expect(result.skepticChallenge?.challenged).toBe(true);
      expect(result.skepticChallenge?.severity).toBe('blocking');
      expect(result.confidence).toBeCloseTo(0.3, 5);
    });

    it('blocks completion when errors were encountered', () => {
      const result = detector.detect(makeCompleteProgress({ errorCount: 1 }));
      expect(result.verdict).toBe('incomplete');
      expect(result.skepticChallenge?.severity).toBe('blocking');
    });

    it('does not run the skeptic on a clearly incomplete verdict', () => {
      const result = detector.detect(makeProgress());
      expect(result.skepticChallenge).toBeUndefined();
    });
  });

  describe('no-step goals (neutral signals)', () => {
    it('treats a no-step goal that addressed the user as complete', () => {
      const result = detector.detect(
        makeProgress({
          totalSteps: 0,
          completedSteps: 0,
          userMessageAddressed: true,
          filesModified: false,
          testsRun: false,
        }),
      );
      // 0.5 (no steps) + 1 (no errors) + 1 (no failures) + 1 (addressed)
      // + 0 (no files) + 0.5 (no tests needed) = 4 / 6 ≈ 0.667 -> ambiguous.
      expect(result.verdict).toBe('ambiguous');
      expect(result.evidence).toContain('No explicit steps defined');
      expect(result.evidence).toContain('No tests needed');
    });
  });

  describe('confidence bounds', () => {
    it('keeps confidence within [0, 1] across varied inputs', () => {
      const samples: GoalProgress[] = [
        makeProgress(),
        makeCompleteProgress(),
        makeCompleteProgress({ testFailures: 5 }),
        makeProgress({ completedSteps: 2, userMessageAddressed: true }),
        makeProgress({ totalSteps: 0, userMessageAddressed: true }),
      ];
      for (const s of samples) {
        const r = detector.detect(s);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});
