/**
 * @file content-filter-retry.test.ts
 * @description Provider content-filter stub handling in GoalPlanner semantic
 * planning: a safeguard-truncated response (few tokens, not a JSON array)
 * triggers ONE retry with the raw user context stripped from the prompt;
 * a second stub falls back to template planning. Also covers the brain.ts
 * content-filter hit counter.
 */

import { describe, it, expect, vi } from 'vitest';
import { GoalPlanner, type BrainForPlanning } from '../../src/core/autonomy/goal-planner.js';
import type { GoalClassification } from '../../src/core/autonomy/goal-pipeline.js';
import { getContentFilterHits, _resetContentFilterHits, _recordContentFilterHit } from '../../src/core/brain/brain.js';

function makeClassification(overrides?: Partial<GoalClassification>): GoalClassification {
  return {
    type: 'bug_fix',
    complexity: 'moderate',
    confidence: 0.85,
    evidence: ['test evidence'],
    estimatedSteps: 4,
    suggestedApproach: 'Test approach',
    ...overrides,
  };
}

const VALID_PLAN = JSON.stringify([
  { description: 'Reproduce the issue', estimatedTime: '5 min', complexity: 'low', risks: ['may not reproduce'] },
  { description: 'Fix it', estimatedTime: '10 min', complexity: 'medium', risks: ['regression'] },
]);

describe('GoalPlanner content-filter stub retry', () => {
  it('retries once WITHOUT user context when the first response is a filtered stub', async () => {
    const prompts: string[] = [];
    let call = 0;
    const brain: BrainForPlanning = {
      chat: async (messages) => {
        prompts.push(messages[1]!.content);
        call++;
        // First call: safeguard stub (3-4 tokens). Second call: valid plan.
        return call === 1 ? 'I ca' : VALID_PLAN;
      },
    };

    const planner = new GoalPlanner(brain);
    const context = 'Fix the crash when password is empty UNIQUE_CONTEXT_MARKER';
    const plan = await planner.plan(makeClassification(), context);

    expect(call).toBe(2);
    // First prompt contains the raw context; retry prompt must NOT.
    expect(prompts[0]).toContain('UNIQUE_CONTEXT_MARKER');
    expect(prompts[1]).not.toContain('UNIQUE_CONTEXT_MARKER');
    expect(prompts[1]).not.toContain('<user_request>');
    // Retry succeeded → semantic steps, not templates.
    expect(plan.steps.map(s => s.description)).toContain('Reproduce the issue');
  });

  it('falls back to template planning when the retry is ALSO a stub (no infinite loop)', async () => {
    let call = 0;
    const brain: BrainForPlanning = {
      chat: async () => {
        call++;
        return '...';
      },
    };

    const planner = new GoalPlanner(brain);
    const plan = await planner.plan(makeClassification(), 'some context');

    // Exactly 2 brain calls (original + one retry), then template fallback.
    expect(call).toBe(2);
    expect(plan.steps.length).toBeGreaterThanOrEqual(4);
    expect(plan.steps[0]!.description.toLowerCase()).toContain('reproduce');
  });

  it('does NOT retry when the response is a valid JSON array', async () => {
    let call = 0;
    const brain: BrainForPlanning = {
      chat: async () => {
        call++;
        return VALID_PLAN;
      },
    };

    const planner = new GoalPlanner(brain);
    const plan = await planner.plan(makeClassification(), 'some context');

    expect(call).toBe(1);
    expect(plan.steps.map(s => s.description)).toContain('Fix it');
  });

  it('does NOT treat a short-but-valid JSON array as a stub', async () => {
    let call = 0;
    const brain: BrainForPlanning = {
      chat: async () => {
        call++;
        // 14 chars, under the 20-char stub threshold, but starts a JSON array.
        return '[{"description":"x"}]'.slice(0, 21);
      },
    };

    const planner = new GoalPlanner(brain);
    await planner.plan(makeClassification(), 'ctx');
    expect(call).toBe(1);
  });
});

describe('brain content-filter hit counter', () => {
  it('increments and resets', () => {
    _resetContentFilterHits();
    expect(getContentFilterHits()).toBe(0);
    expect(_recordContentFilterHit()).toBe(1);
    expect(_recordContentFilterHit()).toBe(2);
    expect(getContentFilterHits()).toBe(2);
    _resetContentFilterHits();
    expect(getContentFilterHits()).toBe(0);
  });
});
