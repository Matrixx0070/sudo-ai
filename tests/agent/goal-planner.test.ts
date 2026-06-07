/**
 * @file tests/agent/goal-planner.test.ts
 * @description Theme 2 heavy — GoalPlanner. In TEMPLATE mode (no Brain) it turns
 * a goal classification into a type-aware strategy (zero LLM cost). The loop
 * injects that strategy as an advisory system message when SUDO_GOAL_PLANNER=1
 * and the goal was classified with confidence >= 0.5.
 *
 *   GP-unit  template mode produces a type-aware, non-empty plan (no LLM)
 *   GP-1     flag on + confident classification → '# STRATEGY' injected
 *   GP-2     flag off → no strategy injected
 *   GP-3     flag on + low confidence → no strategy injected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { GoalClassifier } from '../../src/core/autonomy/goal-pipeline.js';
import { GoalPlanner } from '../../src/core/autonomy/goal-planner.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});
function makeLoop(brain: ReturnType<typeof createMockBrain>) {
  return new AgentLoop(brain, createMockToolRegistry(), createMockSessionManager(), undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());
}
function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}
// Stub classifier: a real classification with a forced confidence.
function stubClassifier(confidence: number) {
  const real = new GoalClassifier().classify('fix the login bug that crashes on empty password');
  return { classify: () => ({ ...real, confidence }) } as unknown as GoalClassifier;
}
function injectedStrategy(brain: ReturnType<typeof createMockBrain>): boolean {
  const msgs = (brain.call.mock.calls[0]?.[0]?.messages ?? []) as Array<{ content?: unknown }>;
  return msgs.some((m) => typeof m.content === 'string' && m.content.includes('# STRATEGY'));
}

describe('Theme 2 heavy: GoalPlanner (template mode)', () => {
  it('GP-unit: template mode produces a type-aware, non-empty plan (no LLM)', async () => {
    const classification = new GoalClassifier().classify('fix the login bug that crashes on empty password');
    const plan = await new GoalPlanner().plan(classification, 'fix the bug'); // no brain → template
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.every((s) => typeof s.description === 'string' && s.description.length > 0)).toBe(true);
  });
});

describe('Theme 2 heavy: GoalPlanner loop wiring', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_GOAL_PLANNER']; delete process.env['SUDO_GOAL_PLANNER']; });
  afterEach(() => { if (saved === undefined) delete process.env['SUDO_GOAL_PLANNER']; else process.env['SUDO_GOAL_PLANNER'] = saved; });

  it('GP-1: flag on + confident classification injects a STRATEGY system message', async () => {
    process.env['SUDO_GOAL_PLANNER'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.9));
    await loop.run('test-session-id', 'fix the login bug');
    expect(injectedStrategy(brain)).toBe(true);
  });

  it('GP-2: flag off → no strategy injected', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.9));
    await loop.run('test-session-id', 'fix the login bug');
    expect(injectedStrategy(brain)).toBe(false);
  });

  it('GP-3: flag on + low confidence → no strategy injected', async () => {
    process.env['SUDO_GOAL_PLANNER'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.3));
    await loop.run('test-session-id', 'fix the login bug');
    expect(injectedStrategy(brain)).toBe(false);
  });
});
