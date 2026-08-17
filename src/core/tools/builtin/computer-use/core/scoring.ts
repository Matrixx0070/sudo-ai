/**
 * @file core/scoring.ts
 * @description PRM-style trajectory scoring for the Computer Use Backend.
 *
 * Research (GUI-Shepherd / process-reward models, Agent S3 behaviour-Best-of-N):
 * for long horizons a PROCESS reward — scoring the trajectory step by step —
 * beats an outcome-only signal. This scorer turns a run's StepResults into a
 * scalar the best-of-N judge ranks by, rewarding completion + structured
 * (API-first) actions and penalising recovery churn and failure.
 */

import type { PlanResult, StepResult } from './types.js';

export interface TrajectoryScore {
  /** Overall scalar (higher is better). */
  score: number;
  /** Fraction of steps that reached verdict 'ok'. */
  completion: number;
  /** Fraction of pointer steps performed via the structured (AX/DOM) path. */
  structuredFraction: number;
  /** Total recovery rungs used across the trajectory. */
  recoveryCount: number;
  /** True when every step succeeded. */
  fullySucceeded: boolean;
}

const W = {
  okStep: 1.0,
  structured: 0.3,
  recoveryRung: -0.4,
  failedTerminal: -2.0,
  completionBonus: 2.0,
};

export function scoreTrajectory(steps: StepResult[]): TrajectoryScore {
  if (steps.length === 0) {
    return { score: 0, completion: 0, structuredFraction: 0, recoveryCount: 0, fullySucceeded: false };
  }
  let score = 0;
  let ok = 0;
  let pointer = 0;
  let structured = 0;
  let recovery = 0;
  for (const s of steps) {
    if (s.verdict === 'ok') {
      ok++;
      score += W.okStep;
    } else {
      score += W.failedTerminal;
    }
    if (['click', 'double_click', 'move', 'scroll'].includes(s.action.kind)) {
      pointer++;
      if (s.structured) {
        structured++;
        score += W.structured;
      }
    }
    recovery += s.recovery.length;
    score += s.recovery.length * W.recoveryRung;
  }
  const completion = ok / steps.length;
  const fullySucceeded = ok === steps.length;
  if (fullySucceeded) score += W.completionBonus;
  return {
    score,
    completion,
    structuredFraction: pointer > 0 ? structured / pointer : 0,
    recoveryCount: recovery,
    fullySucceeded,
  };
}

export function scorePlan(result: PlanResult): TrajectoryScore {
  const s = scoreTrajectory(result.steps);
  // A plan that reported failure can never outrank a completed one of equal steps.
  if (!result.success) s.score -= 1;
  return s;
}
