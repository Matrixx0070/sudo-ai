/**
 * @file tests/agent/plan-tracking.test.ts
 * @description Theme 2 step-tracking — APPROXIMATE coverage of the auto-plan's
 * steps by the turn's tool actions, surfaced on AgentRunResult.planProgress.
 * Soft anti-"phantom-completion" signal; rides the SUDO_AUTO_PLAN gate.
 *
 *   PTRACK-1  an unaddressed plan step is flagged; an addressed one is not
 *   PTRACK-2  no plan (flag off) → planProgress undefined
 *   PTRACK-3  flag on + simple message (no plan) → planProgress undefined
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
function makeLoop(brain: ReturnType<typeof createMockBrain>, registry = createMockToolRegistry()) {
  return new AgentLoop(brain, registry, createMockSessionManager(), undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());
}
function resp(content: string): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

describe('Theme 2: plan step-tracking (approximate coverage)', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_AUTO_PLAN']; delete process.env['SUDO_AUTO_PLAN']; });
  afterEach(() => { if (saved === undefined) delete process.env['SUDO_AUTO_PLAN']; else process.env['SUDO_AUTO_PLAN'] = saved; });

  it('PTRACK-1: flags the step not covered by tool actions, keeps the covered one', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce(resp('1. search the web for cats\n2. write a report file')) // decomposition
      .mockResolvedValueOnce({
        content: 'searching now',
        toolCalls: [{ id: 'tc-1', name: 'web.search', arguments: {} }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
        model: 'xai/grok-3-fast', finishReason: 'tool-calls',
      } as BrainResponse)
      .mockResolvedValue(resp('done')); // after tool → stop
    const registry = createMockToolRegistry();
    registry.execute.mockResolvedValue({ success: true, output: 'found cats on the web', data: {} });

    const result = await makeLoop(brain, registry).run('test-session-id', 'search the web for cats then write a report file');

    expect(result.planProgress).toBeDefined();
    expect(result.planProgress!.totalSteps).toBe(2);
    // "write a report file" — no tool touched it → unaddressed (anti-phantom signal).
    expect(result.planProgress!.unaddressed).toContain('write a report file');
    // "search the web for cats" — covered by the web.search tool → NOT flagged.
    expect(result.planProgress!.unaddressed).not.toContain('search the web for cats');
    expect(result.planProgress!.addressedCount).toBe(1);
  });

  it('PTRACK-2: flag off → no plan, no planProgress', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(resp('done'));
    const result = await makeLoop(brain).run('test-session-id', 'search the web for cats then write a report file');
    expect(result.planProgress).toBeUndefined();
  });

  it('PTRACK-3: flag on + simple message (no plan) → no planProgress', async () => {
    process.env['SUDO_AUTO_PLAN'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(resp('done'));
    const result = await makeLoop(brain).run('test-session-id', 'hi');
    expect(result.planProgress).toBeUndefined();
  });
});
