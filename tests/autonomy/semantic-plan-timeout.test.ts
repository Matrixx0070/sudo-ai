/**
 * @file tests/autonomy/semantic-plan-timeout.test.ts
 * @description Covers the env-tunable semantic-planning timeout (B8.3). The flat
 * 10s was too aggressive on the loaded box (27 timeouts/13h); the default is now
 * 30s and overridable via SUDO_SEMANTIC_PLAN_TIMEOUT_MS. Asserts the override is
 * honoured and that a brain call slower than the timeout falls back to template
 * planning (the fallback path is unchanged). Uses a fresh module import so the
 * module-load-time env read is exercised.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GoalClassification } from '../../src/core/autonomy/goal-pipeline.js';

function makeClassification(): GoalClassification {
  return {
    type: 'bug_fix',
    complexity: 'moderate',
    confidence: 0.85,
    evidence: ['e'],
    estimatedSteps: 4,
    suggestedApproach: 'approach',
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('semantic planning timeout (B8.3)', () => {
  it('honours SUDO_SEMANTIC_PLAN_TIMEOUT_MS and falls back to template on a slow brain', async () => {
    vi.stubEnv('SUDO_SEMANTIC_PLAN_TIMEOUT_MS', '20'); // tiny → trips fast
    vi.resetModules();
    const { GoalPlanner } = await import('../../src/core/autonomy/goal-planner.js');

    // A brain whose chat never resolves — only the timeout can end the race.
    const chat = vi.fn(() => new Promise<string>(() => { /* never resolves */ }));
    const planner = new GoalPlanner({ chat } as unknown as ConstructorParameters<typeof GoalPlanner>[0]);

    const plan = await planner.plan(makeClassification(), 'App crashes on null password');

    // Fell back to deterministic template planning (the brain call was started
    // then abandoned at the 20ms timeout).
    expect(chat).toHaveBeenCalledTimes(1);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.title).toContain('Bug Fix');
  });

  it('a fast brain still returns the semantic plan (timeout does not interfere)', async () => {
    vi.stubEnv('SUDO_SEMANTIC_PLAN_TIMEOUT_MS', '5000');
    vi.resetModules();
    const { GoalPlanner } = await import('../../src/core/autonomy/goal-planner.js');

    const semanticSteps = [
      { description: 'Repro the crash', estimatedTime: '5 min', complexity: 'low', risks: ['none'] },
      { description: 'Patch the null deref', estimatedTime: '10 min', complexity: 'medium', risks: ['regression'] },
    ];
    const chat = vi.fn().mockResolvedValue(JSON.stringify(semanticSteps));
    const planner = new GoalPlanner({ chat } as unknown as ConstructorParameters<typeof GoalPlanner>[0]);

    const plan = await planner.plan(makeClassification(), 'fix it');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.description).toBe('Repro the crash');
  });

  it('defaults to a generous timeout when the env is unset (no 10s regression)', async () => {
    vi.stubEnv('SUDO_SEMANTIC_PLAN_TIMEOUT_MS', '');
    vi.resetModules();
    // The module read uses Number('') → NaN → default branch. A fast brain proves
    // the default path is wired and non-zero (a 0/NaN timeout would instantly fail).
    const { GoalPlanner } = await import('../../src/core/autonomy/goal-planner.js');
    const chat = vi.fn().mockResolvedValue(JSON.stringify([
      { description: 'Step', estimatedTime: '5 min', complexity: 'low', risks: ['r'] },
    ]));
    const planner = new GoalPlanner({ chat } as unknown as ConstructorParameters<typeof GoalPlanner>[0]);
    const plan = await planner.plan(makeClassification(), 'ctx');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});
