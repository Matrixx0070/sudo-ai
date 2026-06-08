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
import { GoalPlanner, type BrainForPlanning } from '../../src/core/autonomy/goal-planner.js';
import { resolveSemanticPlanCap, semanticPlanAllowed } from '../../src/core/agent/loop-helpers.js';
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

describe('Theme 2 heavy: GoalPlanner semantic (LLM) mode', () => {
  const cls = () => new GoalClassifier().classify('fix the login bug that crashes on empty password');

  it('GP-sem-unit: LLM-generated steps flow into the plan', async () => {
    const brain: BrainForPlanning = {
      chat: async () => '[{"description":"reproduce the failing case","complexity":"low","estimatedTime":"5 min","risks":[]}]',
    };
    const plan = await new GoalPlanner(brain).plan(cls(), 'fix it');
    expect(plan.steps.some((s) => s.description.includes('reproduce the failing case'))).toBe(true);
  });

  it('GP-sem-fallback: invalid LLM JSON → falls back to a (non-empty) template plan', async () => {
    const brain: BrainForPlanning = { chat: async () => 'not json at all' };
    const plan = await new GoalPlanner(brain).plan(cls(), 'fix it');
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.every((s) => !s.description.includes('not json'))).toBe(true);
  });

  it('GP-sem-throws: brain.chat throwing → still falls back to template', async () => {
    const brain: BrainForPlanning = { chat: async () => { throw new Error('llm down'); } };
    const plan = await new GoalPlanner(brain).plan(cls(), 'fix it');
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});

describe('Theme 2 heavy: GoalPlanner semantic loop wiring', () => {
  const KEYS = ['SUDO_GOAL_PLANNER', 'SUDO_GOAL_PLANNER_SEMANTIC'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('GP-sem-loop: both flags → the LLM-derived step is injected via brain.chat', async () => {
    process.env['SUDO_GOAL_PLANNER'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    (brain as unknown as { chat: () => Promise<string> }).chat = vi.fn(
      async () => '[{"description":"SEMANTIC-STEP reproduce it","complexity":"low","estimatedTime":"5m","risks":[]}]',
    );
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.9));
    await loop.run('test-session-id', 'fix the login bug');

    const msgs = (brain.call.mock.calls[0]?.[0]?.messages ?? []) as Array<{ content?: unknown }>;
    const strategy = msgs.find((m) => typeof m.content === 'string' && m.content.includes('# STRATEGY'));
    expect(strategy?.content as string).toContain('SEMANTIC-STEP reproduce it');
  });
});

describe('Theme 2 follow-up: semantic per-run cap helpers', () => {
  it('resolveSemanticPlanCap: unset / blank / signed / fractional / hex / junk => undefined (no cap)', () => {
    expect(resolveSemanticPlanCap(undefined)).toBeUndefined();
    expect(resolveSemanticPlanCap('')).toBeUndefined();
    expect(resolveSemanticPlanCap('   ')).toBeUndefined();
    expect(resolveSemanticPlanCap('abc')).toBeUndefined();
    expect(resolveSemanticPlanCap('-1')).toBeUndefined();
    expect(resolveSemanticPlanCap('-42')).toBeUndefined();
    expect(resolveSemanticPlanCap('+5')).toBeUndefined();   // leading sign rejected
    expect(resolveSemanticPlanCap('2.9')).toBeUndefined();  // fractional rejected
    expect(resolveSemanticPlanCap('3x')).toBeUndefined();   // trailing junk rejected
    expect(resolveSemanticPlanCap('0x10')).toBeUndefined(); // hex rejected (lenient parseInt would have collapsed it to 0)
  });

  it('resolveSemanticPlanCap: clean non-negative integers parse, including 0 and surrounding whitespace', () => {
    expect(resolveSemanticPlanCap('0')).toBe(0); // 0 is a valid cap (template-only)
    expect(resolveSemanticPlanCap('1')).toBe(1);
    expect(resolveSemanticPlanCap('3')).toBe(3);
    expect(resolveSemanticPlanCap('  2  ')).toBe(2); // surrounding whitespace tolerated
  });

  it('semanticPlanAllowed: undefined cap => always allowed', () => {
    expect(semanticPlanAllowed(undefined, 0)).toBe(true);
    expect(semanticPlanAllowed(undefined, 9999)).toBe(true);
  });

  it('semanticPlanAllowed: cap=0 => never allowed', () => {
    expect(semanticPlanAllowed(0, 0)).toBe(false);
  });

  it('semanticPlanAllowed: cap=N allows the first N, blocks the rest', () => {
    expect(semanticPlanAllowed(2, 0)).toBe(true);
    expect(semanticPlanAllowed(2, 1)).toBe(true);
    expect(semanticPlanAllowed(2, 2)).toBe(false);
    expect(semanticPlanAllowed(2, 3)).toBe(false);
  });
});

describe('Theme 2 follow-up: semantic per-run cap (loop wiring)', () => {
  const KEYS = ['SUDO_GOAL_PLANNER', 'SUDO_GOAL_PLANNER_SEMANTIC', 'SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  function semanticBrain() {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    (brain as unknown as { chat: ReturnType<typeof vi.fn> }).chat = vi.fn(
      async () => '[{"description":"SEMANTIC-STEP reproduce it","complexity":"low","estimatedTime":"5m","risks":[]}]',
    );
    return brain;
  }
  function chatFn(brain: ReturnType<typeof createMockBrain>) {
    return (brain as unknown as { chat: ReturnType<typeof vi.fn> }).chat;
  }
  function strategyText(brain: ReturnType<typeof createMockBrain>): string {
    const msgs = (brain.call.mock.calls[0]?.[0]?.messages ?? []) as Array<{ content?: unknown }>;
    const s = msgs.find((m) => typeof m.content === 'string' && m.content.includes('# STRATEGY'));
    return (s?.content as string) ?? '';
  }

  it('GP-cap-0: cap=0 => semantic blocked, template strategy injected, no brain.chat (zero LLM cost)', async () => {
    process.env['SUDO_GOAL_PLANNER'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN'] = '0';
    const brain = semanticBrain();
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.9));
    await loop.run('test-session-id', 'fix the login bug');
    expect(chatFn(brain)).not.toHaveBeenCalled();
    const strat = strategyText(brain);
    expect(strat.length).toBeGreaterThan(0);          // template strategy still injected
    expect(strat).not.toContain('SEMANTIC-STEP');     // but not the LLM-derived step
  });

  it('GP-cap-1: cap=1 => the single per-run semantic plan is allowed', async () => {
    process.env['SUDO_GOAL_PLANNER'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN'] = '1';
    const brain = semanticBrain();
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.9));
    await loop.run('test-session-id', 'fix the login bug');
    expect(chatFn(brain)).toHaveBeenCalledTimes(1);
    // Tie the call to GoalPlanner specifically (its semantic system prompt) so the
    // count assertion can't pass for the wrong reason if some other brain.chat
    // caller is ever auto-initialized in the loop.
    expect(chatFn(brain)).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('precise task planner') }),
      ]),
    );
    expect(strategyText(brain)).toContain('SEMANTIC-STEP reproduce it');
  });

  it('GP-cap-unset: no cap => semantic runs (backward compatibility)', async () => {
    process.env['SUDO_GOAL_PLANNER'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC'] = '1';
    // SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN intentionally left unset
    const brain = semanticBrain();
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.9));
    await loop.run('test-session-id', 'fix the login bug');
    expect(chatFn(brain)).toHaveBeenCalledTimes(1);
    expect(strategyText(brain)).toContain('SEMANTIC-STEP reproduce it');
  });

  it('GP-cap-invalid: malformed cap => fail-open, semantic runs', async () => {
    process.env['SUDO_GOAL_PLANNER'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC'] = '1';
    process.env['SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN'] = 'not-a-number';
    const brain = semanticBrain();
    const loop = makeLoop(brain);
    loop.setGoalClassifier(stubClassifier(0.9));
    await loop.run('test-session-id', 'fix the login bug');
    expect(chatFn(brain)).toHaveBeenCalledTimes(1);
    expect(strategyText(brain)).toContain('SEMANTIC-STEP reproduce it');
  });
});
