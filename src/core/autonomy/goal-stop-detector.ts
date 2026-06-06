/**
 * @file goal-stop-detector.ts
 * @description Goal Stop Detector — detects when a goal is complete and the
 * agent should stop working. Also includes the Skeptic Verifier that challenges
 * premature completion claims. Grok Build CLI parity.
 *
 * The stop detector examines execution signals to determine if the goal is met:
 *   - All planned steps completed
 *   - No remaining errors or test failures
 *   - User's original request fully addressed
 *
 * The Skeptic Verifier acts as an adversarial check — it tries to find reasons
 * why the goal might NOT be complete, preventing premature termination.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('autonomy:goal-stop-detector');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopVerdict = 'complete' | 'incomplete' | 'ambiguous';

export interface StopDetectionResult {
  /** Whether the goal appears to be complete. */
  verdict: StopVerdict;
  /** Confidence in the verdict (0-1). */
  confidence: number;
  /** Reasons supporting the verdict. */
  evidence: string[];
  /** If skeptic was run, its challenge result. */
  skepticChallenge?: SkepticResult;
}

export interface SkepticResult {
  /** Whether the skeptic successfully challenged the completion claim. */
  challenged: boolean;
  /** Issues found by the skeptic. */
  issues: string[];
  /** Severity: 'blocking' means the goal is definitely incomplete. */
  severity: 'blocking' | 'warning' | 'minor';
}

export interface GoalProgress {
  /** Total planned steps. */
  totalSteps: number;
  /** Steps completed so far. */
  completedSteps: number;
  /** Steps currently in progress. */
  inProgressSteps: number;
  /** Number of errors encountered. */
  errorCount: number;
  /** Number of test failures (if applicable). */
  testFailures: number;
  /** Whether the user's last message was acknowledged/answered. */
  userMessageAddressed: boolean;
  /** Whether files were modified during this session. */
  filesModified: boolean;
  /** Whether tests were run during this session. */
  testsRun: boolean;
  /** Custom evidence strings (e.g., "all 3 acceptance criteria met"). */
  customEvidence: string[];
}

// ---------------------------------------------------------------------------
// GoalStopDetector
// ---------------------------------------------------------------------------

/**
 * Detects goal completion by analyzing execution progress signals.
 *
 * Inspired by Grok Build CLI's GoalStopDetector which uses a combination of:
 *   - Step completion tracking
 *   - Error/failure counting
 *   - User message acknowledgment
 *   - Skeptic verification
 */
export class GoalStopDetector {
  /**
   * Analyze goal progress and determine if the goal is complete.
   *
   * @param progress - The current goal progress signals.
   * @returns StopDetectionResult with verdict and evidence.
   */
  detect(progress: GoalProgress): StopDetectionResult {
    const evidence: string[] = [];
    let score = 0;
    const maxScore = 6; // 6 signal categories

    // Signal 1: Step completion
    if (progress.totalSteps > 0) {
      const stepRatio = progress.completedSteps / progress.totalSteps;
      if (stepRatio >= 1) {
        score++;
        evidence.push(`All ${progress.totalSteps} steps completed`);
      } else if (stepRatio >= 0.8) {
        evidence.push(`${progress.completedSteps}/${progress.totalSteps} steps completed (partial)`);
      } else {
        evidence.push(`Only ${progress.completedSteps}/${progress.totalSteps} steps completed`);
      }
    } else {
      // No steps defined — neutral signal
      score += 0.5;
      evidence.push('No explicit steps defined');
    }

    // Signal 2: No errors
    if (progress.errorCount === 0) {
      score++;
      evidence.push('No errors encountered');
    } else {
      evidence.push(`${progress.errorCount} errors encountered`);
    }

    // Signal 3: No test failures
    if (progress.testFailures === 0) {
      score++;
      evidence.push('No test failures');
    } else {
      evidence.push(`${progress.testFailures} test failures`);
    }

    // Signal 4: User message addressed
    if (progress.userMessageAddressed) {
      score++;
      evidence.push('User message addressed');
    } else {
      evidence.push('User message not yet addressed');
    }

    // Signal 5: Files modified (shows work was done)
    if (progress.filesModified) {
      score++;
      evidence.push('Files were modified');
    } else {
      evidence.push('No files modified');
    }

    // Signal 6: Tests run
    if (progress.testsRun) {
      score++;
      evidence.push('Tests were executed');
    } else if (progress.totalSteps > 0) {
      evidence.push('Tests were not run');
    } else {
      score += 0.5; // neutral for no-step goals
      evidence.push('No tests needed');
    }

    // Add custom evidence
    for (const ce of progress.customEvidence) {
      evidence.push(ce);
    }

    // Calculate verdict
    const ratio = score / maxScore;
    let verdict: StopVerdict;
    let confidence: number;

    if (ratio >= 0.85) {
      verdict = 'complete';
      confidence = Math.min(1, ratio);
    } else if (ratio >= 0.5) {
      verdict = 'ambiguous';
      confidence = 0.5;
    } else {
      verdict = 'incomplete';
      confidence = 1 - ratio;
    }

    // If in-progress steps remain, can't be complete
    if (progress.inProgressSteps > 0 && verdict === 'complete') {
      verdict = 'ambiguous';
      confidence = 0.4;
      evidence.push(`${progress.inProgressSteps} steps still in progress`);
    }

    const result: StopDetectionResult = { verdict, confidence, evidence };

    // Run skeptic verifier if we think the goal might be complete
    if (verdict === 'complete' || verdict === 'ambiguous') {
      result.skepticChallenge = this._runSkeptic(progress, verdict);
      if (result.skepticChallenge.challenged && result.skepticChallenge.severity === 'blocking') {
        // Skeptic overruled — goal is NOT complete
        result.verdict = 'incomplete';
        result.confidence = 0.3;
        log.info({ issues: result.skepticChallenge.issues }, 'Skeptic blocked premature goal completion');
      }
    }

    log.info(
      { verdict: result.verdict, confidence: result.confidence.toFixed(2), evidenceCount: evidence.length },
      'Goal stop detection result',
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Skeptic Verifier (adversarial)
  // -------------------------------------------------------------------------

  /**
   * The Skeptic Verifier challenges the completion claim.
   * It looks for common reasons a "complete" goal might actually be incomplete:
   *   - Steps completed but tests not run
   *   - User's question not directly answered
   *   - Errors were ignored, not fixed
   *   - Only partial implementation (e.g., core logic but no error handling)
   */
  private _runSkeptic(progress: GoalProgress, currentVerdict: StopVerdict): SkepticResult {
    const issues: string[] = [];
    let severity: SkepticResult['severity'] = 'minor';

    // Check 1: Were tests actually run?
    if (progress.filesModified && !progress.testsRun && progress.totalSteps > 2) {
      issues.push('Files were modified but no tests were run — changes may be unverified');
      severity = 'warning';
    }

    // Check 2: Errors present but not resolved
    if (progress.errorCount > 0) {
      issues.push(`${progress.errorCount} error(s) encountered during execution — goal may not be fully met`);
      severity = 'blocking';
    }

    // Check 3: Test failures
    if (progress.testFailures > 0) {
      issues.push(`${progress.testFailures} test failure(s) — goal cannot be complete with failing tests`);
      severity = 'blocking';
    }

    // Check 4: Steps in progress
    if (progress.inProgressSteps > 0) {
      issues.push(`${progress.inProgressSteps} step(s) still in progress`);
      if (severity === 'minor') severity = 'warning';
    }

    // Check 5: User message not addressed
    if (!progress.userMessageAddressed) {
      issues.push('The user\'s original message has not been directly addressed');
      if (severity !== 'blocking') severity = 'warning';
    }

    // Check 6: Steps completed but not all
    if (progress.totalSteps > 0 && progress.completedSteps < progress.totalSteps) {
      const remaining = progress.totalSteps - progress.completedSteps - progress.inProgressSteps;
      if (remaining > 0) {
        issues.push(`${remaining} step(s) remain pending (not started)`);
        if (severity === 'minor') severity = 'warning';
      }
    }

    const challenged = issues.length > 0;

    if (challenged) {
      log.info(
        { issues, severity, currentVerdict },
        'Skeptic verifier challenged goal completion',
      );
    }

    return { challenged, issues, severity };
  }
}