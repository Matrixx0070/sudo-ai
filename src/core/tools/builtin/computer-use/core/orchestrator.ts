/**
 * @file core/orchestrator.ts
 * @description Best-of-N orchestration with a PRM judge (Agent S3 behaviour-BoN).
 *
 * Runs the same plan across N ISOLATED sessions in parallel, scores each
 * trajectory with the process-reward scorer, and returns the best. Because the
 * attempts are independent, best-of-N lifts success on flaky/hard tasks: the run
 * succeeds if ANY attempt does, and among successes the judge prefers the
 * cleanest trajectory (most complete, most structured, least recovery churn).
 *
 * The orchestrator is decoupled from sessions and drivers via injected
 * `provision` + `makeExecutor`, so it is unit-testable without a display and
 * reusable for multi-VM fan-out later.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { ActionPlan, PlanResult } from './types.js';
import type { ActionExecutor } from './executor.js';
import { scorePlan, type TrajectoryScore } from './scoring.js';

const log = createLogger('computer:orchestrator');

export interface ProvisionedAttempt {
  display: string;
  dispose: () => Promise<void>;
}

export interface BestOfNDeps {
  n: number;
  plan: ActionPlan;
  /** Provision attempt `index`: an isolated session with any app set up. */
  provision: (index: number) => Promise<ProvisionedAttempt>;
  /** Build an executor bound to the attempt's display. */
  makeExecutor: (display: string, index: number) => ActionExecutor;
  /** Use batch mode for each attempt (faster). Default false (verified). */
  batch?: boolean;
}

export interface AttemptOutcome {
  index: number;
  display: string;
  result: PlanResult;
  score: TrajectoryScore;
  error?: string;
}

export interface BestOfNResult {
  best?: AttemptOutcome;
  attempts: AttemptOutcome[];
  /** True when at least one attempt fully succeeded. */
  anySucceeded: boolean;
}

export async function runBestOfN(deps: BestOfNDeps): Promise<BestOfNResult> {
  const indices = Array.from({ length: Math.max(1, deps.n) }, (_, i) => i);

  const attempts = await Promise.all(
    indices.map(async (index): Promise<AttemptOutcome> => {
      let provisioned: ProvisionedAttempt | undefined;
      try {
        provisioned = await deps.provision(index);
        const exec = deps.makeExecutor(provisioned.display, index);
        const result = deps.batch ? await exec.runBatch(deps.plan) : await exec.run(deps.plan);
        const score = scorePlan(result);
        return { index, display: provisioned.display, result, score };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log.warn({ index, error }, 'best-of-N attempt failed');
        return {
          index,
          display: provisioned?.display ?? '',
          result: { subgoal: deps.plan.subgoal, success: false, steps: [], reason: error },
          score: { score: -Infinity, completion: 0, structuredFraction: 0, recoveryCount: 0, fullySucceeded: false },
          error,
        };
      } finally {
        if (provisioned) await provisioned.dispose().catch(() => {});
      }
    }),
  );

  // Judge: prefer a fully-successful attempt; break ties by process score.
  const ranked = [...attempts].sort((a, b) => {
    if (a.score.fullySucceeded !== b.score.fullySucceeded) return a.score.fullySucceeded ? -1 : 1;
    return b.score.score - a.score.score;
  });
  const best = ranked[0];
  return { best, attempts, anySucceeded: attempts.some((a) => a.score.fullySucceeded) };
}
