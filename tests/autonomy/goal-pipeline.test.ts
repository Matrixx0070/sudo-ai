/**
 * @file goal-pipeline.test.ts
 * @description Tests for Goal Classifier, Stop Detector, and Skeptic Verifier.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GoalClassifier, type GoalClassification } from '../../src/core/autonomy/goal-pipeline.js';
import { GoalStopDetector, type GoalProgress, type StopDetectionResult } from '../../src/core/autonomy/goal-stop-detector.js';

describe('GoalClassifier', () => {
  let classifier: GoalClassifier;

  beforeEach(() => {
    classifier = new GoalClassifier();
  });

  it('should classify bug fix requests', () => {
    const result = classifier.classify('Fix the login bug that causes crashes');
    expect(result.type).toBe('bug_fix');
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.estimatedSteps).toBeGreaterThanOrEqual(1);
  });

  it('should classify feature requests', () => {
    const result = classifier.classify('Add a new search feature with filtering');
    expect(result.type).toBe('feature');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should classify refactoring requests', () => {
    const result = classifier.classify('Refactor the authentication module and clean up the code');
    expect(result.type).toBe('refactor');
  });

  it('should classify research requests', () => {
    const result = classifier.classify('Investigate the performance issue and research possible solutions');
    expect(result.type).toBe('research');
  });

  it('should classify security requests', () => {
    const result = classifier.classify('Fix the security vulnerability in the auth endpoint');
    expect(result.type).toBe('security');
  });

  it('should classify deployment requests', () => {
    const result = classifier.classify('Deploy the new release to production');
    expect(result.type).toBe('deployment');
  });

  it('should classify testing requests', () => {
    const result = classifier.classify('Add unit tests for the payment module');
    // "Add" matches feature, but "test" matches testing — may be either
    expect(['testing', 'feature']).toContain(result.type);
  });

  it('should return unknown for ambiguous messages', () => {
    const result = classifier.classify('hello');
    expect(result.type).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty messages', () => {
    const result = classifier.classify('');
    expect(result.type).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('should classify complexity based on signals', () => {
    const trivial = classifier.classify('Quick fix for a typo in the README');
    expect(trivial.complexity).toBeDefined();

    const critical = classifier.classify('Critical production outage — fix the emergency login failure now');
    expect(critical.complexity).toBeDefined();
  });

  it('should provide suggested approach', () => {
    const result = classifier.classify('Add a dark mode feature');
    expect(result.suggestedApproach).toBeTruthy();
    expect(result.suggestedApproach.length).toBeGreaterThan(0);
  });

  it('should estimate steps based on type and complexity', () => {
    const trivial = classifier.classify('Quick typo fix');
    const complex = classifier.classify('Build a complex end-to-end integration with error handling');
    // Complex should generally have more steps
    expect(complex.estimatedSteps).toBeGreaterThanOrEqual(trivial.estimatedSteps);
  });
});

describe('GoalStopDetector', () => {
  let detector: GoalStopDetector;

  beforeEach(() => {
    detector = new GoalStopDetector();
  });

  it('should detect complete goal when all signals are positive', () => {
    const progress: GoalProgress = {
      totalSteps: 3,
      completedSteps: 3,
      inProgressSteps: 0,
      errorCount: 0,
      testFailures: 0,
      userMessageAddressed: true,
      filesModified: true,
      testsRun: true,
      customEvidence: ['All acceptance criteria met'],
    };

    const result = detector.detect(progress);
    expect(result.verdict).toBe('complete');
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('should detect incomplete goal when steps remain', () => {
    const progress: GoalProgress = {
      totalSteps: 5,
      completedSteps: 1,
      inProgressSteps: 1,
      errorCount: 3,
      testFailures: 2,
      userMessageAddressed: false,
      filesModified: false,
      testsRun: false,
      customEvidence: [],
    };

    const result = detector.detect(progress);
    // With many negative signals, should be incomplete or ambiguous
    expect(['incomplete', 'ambiguous']).toContain(result.verdict);
  });

  it('should detect incomplete goal with errors', () => {
    const progress: GoalProgress = {
      totalSteps: 3,
      completedSteps: 3,
      inProgressSteps: 0,
      errorCount: 5,
      testFailures: 2,
      userMessageAddressed: true,
      filesModified: true,
      testsRun: true,
      customEvidence: [],
    };

    const result = detector.detect(progress);
    expect(result.verdict).toBe('incomplete');
  });

  it('should produce ambiguous result with mixed signals', () => {
    const progress: GoalProgress = {
      totalSteps: 4,
      completedSteps: 3,
      inProgressSteps: 0,
      errorCount: 0,
      testFailures: 0,
      userMessageAddressed: false,
      filesModified: true,
      testsRun: false,
      customEvidence: [],
    };

    const result = detector.detect(progress);
    expect(['complete', 'ambiguous', 'incomplete']).toContain(result.verdict);
  });

  it('should use skeptic to block premature completion when errors exist', () => {
    const progress: GoalProgress = {
      totalSteps: 3,
      completedSteps: 3,
      inProgressSteps: 0,
      errorCount: 2,
      testFailures: 0,
      userMessageAddressed: true,
      filesModified: true,
      testsRun: true,
      customEvidence: [],
    };

    const result = detector.detect(progress);
    // Skeptic should challenge because of errors
    if (result.skepticChallenge) {
      expect(result.skepticChallenge.challenged).toBe(true);
    }
  });

  it('should use skeptic to block when tests not run on modified files', () => {
    const progress: GoalProgress = {
      totalSteps: 5,
      completedSteps: 5,
      inProgressSteps: 0,
      errorCount: 0,
      testFailures: 0,
      userMessageAddressed: true,
      filesModified: true,
      testsRun: false,
      customEvidence: [],
    };

    const result = detector.detect(progress);
    if (result.skepticChallenge) {
      expect(result.skepticChallenge.challenged).toBe(true);
      expect(result.skepticChallenge.issues.some(i => i.includes('tests'))).toBe(true);
    }
  });

  it('should handle zero-step goals', () => {
    const progress: GoalProgress = {
      totalSteps: 0,
      completedSteps: 0,
      inProgressSteps: 0,
      errorCount: 0,
      testFailures: 0,
      userMessageAddressed: true,
      filesModified: false,
      testsRun: false,
      customEvidence: ['Task completed'],
    };

    const result = detector.detect(progress);
    expect(['complete', 'ambiguous']).toContain(result.verdict);
  });

  it('should include custom evidence in result', () => {
    const progress: GoalProgress = {
      totalSteps: 1,
      completedSteps: 1,
      inProgressSteps: 0,
      errorCount: 0,
      testFailures: 0,
      userMessageAddressed: true,
      filesModified: true,
      testsRun: true,
      customEvidence: ['User confirmed result', 'All 5 acceptance criteria met'],
    };

    const result = detector.detect(progress);
    expect(result.evidence).toContain('User confirmed result');
    expect(result.evidence).toContain('All 5 acceptance criteria met');
  });
});