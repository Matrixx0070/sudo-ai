/**
 * @file tests/agent/auto-plan.test.ts
 * @description Theme 2 (first slice) — SUDO_AUTO_PLAN task decomposition injected
 * as a turn-start plan checklist. Default-OFF, fail-open, heuristic-gated.
 *
 *   PLAN-1  flag on + complex message  → plan injected into the main brain call
 *   PLAN-2  flag off + complex message → no plan injected, no decomposition call
 *   PLAN-3  flag on + simple message   → no plan, no extra brain call (heuristic)
 *   PLAN-4  flag on + decomposition throws → fail-open, loop completes, no plan
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
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
  return new AgentLoop(
    brain,
    createMockToolRegistry(),
    createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

function resp(content: string): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

const COMPLEX = 'build a CLI tool, then test all the modules, and finally write the docs';
const SIMPLE = 'hi there';

/** True when any brain.call() carried a system message containing `needle`. */
function planInMessages(brain: ReturnType<typeof createMockBrain>, needle: string): boolean {
  return brain.call.mock.calls.some((c: any[]) => {
    const msgs = (c[0]?.messages ?? []) as Array<{ role: string; content: string }>;
    return msgs.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes(needle));
  });
}

describe('Theme 2: SUDO_AUTO_PLAN task decomposition', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_AUTO_PLAN']; delete process.env['SUDO_AUTO_PLAN']; });
  afterEach(() => { if (saved === undefined) delete process.env['SUDO_AUTO_PLAN']; else process.env['SUDO_AUTO_PLAN'] = saved; });

  it('PLAN-1: flag on + complex message injects a decomposed plan', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce(resp('1. Build the CLI\n2. Test all modules\n3. Write the docs')) // decomposition
      .mockResolvedValue(resp('done')); // main turn

    const result = await makeLoop(brain).run('test-session-id', COMPLEX);

    expect(brain.call.mock.calls.length).toBeGreaterThanOrEqual(2); // decomp + main
    expect(planInMessages(brain, 'PLAN FOR THIS TASK')).toBe(true);
    expect(planInMessages(brain, 'Build the CLI')).toBe(true);
    expect(result.text).toBe('done');
  });

  it('PLAN-2: flag off → no plan injected, no decomposition call', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(resp('done'));

    await makeLoop(brain).run('test-session-id', COMPLEX);

    expect(planInMessages(brain, 'PLAN FOR THIS TASK')).toBe(false);
  });

  it('PLAN-3: flag on + simple message → no plan, heuristic skips the micro-call', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(resp('done'));

    await makeLoop(brain).run('test-session-id', SIMPLE);

    expect(planInMessages(brain, 'PLAN FOR THIS TASK')).toBe(false);
    // No decomposition micro-call: only the single main-loop brain call.
    expect(brain.call.mock.calls.length).toBe(1);
  });

  it('PLAN-4: decomposition error is fail-open — loop completes, no plan', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    const brain = createMockBrain();
    brain.call
      .mockRejectedValueOnce(new Error('decompose boom')) // decomposition throws
      .mockResolvedValue(resp('done')); // main turn

    const result = await makeLoop(brain).run('test-session-id', COMPLEX);

    expect(result.text).toBe('done');
    expect(planInMessages(brain, 'PLAN FOR THIS TASK')).toBe(false);
  });

  it('PLAN-5: injected subtasks are length-bounded (token + injection guard)', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce(resp(`1. ${'A'.repeat(300)}\n2. short step`))
      .mockResolvedValue(resp('done'));

    await makeLoop(brain).run('test-session-id', COMPLEX);

    // Find the injected plan message and check every line is bounded.
    const planMsg = brain.call.mock.calls
      .flatMap((c: any[]) => (c[0]?.messages ?? []) as Array<{ role: string; content: string }>)
      .find((m) => m.role === 'system' && m.content.includes('PLAN FOR THIS TASK'));
    expect(planMsg).toBeDefined();
    const longestStepLine = planMsg!.content.split('\n').filter((l) => /^\d+\./.test(l)).reduce((a, b) => (a.length > b.length ? a : b), '');
    expect(longestStepLine.length).toBeLessThanOrEqual(210); // 200 chars + "N. "
    expect(planMsg!.content).toContain('short step');
  });

  it('PLAN-6: unparseable decomposition output injects no plan', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce(resp('Sure, I think you should just wing it however you like')) // no numbered steps
      .mockResolvedValue(resp('done'));

    const result = await makeLoop(brain).run('test-session-id', COMPLEX);

    expect(result.text).toBe('done');
    expect(planInMessages(brain, 'PLAN FOR THIS TASK')).toBe(false);
  });
});
