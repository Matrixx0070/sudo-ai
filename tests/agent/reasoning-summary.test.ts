/**
 * @file tests/agent/reasoning-summary.test.ts
 * @description Theme 2.2 — reasoning-summary: a transparent recap of the turn's
 * actions, attached to AgentRunResult when SUDO_REASONING_SUMMARY=1. Additive,
 * opt-in, fail-open.
 *
 *   RS-unit  buildReasoningSummary / formatReasoningSummary behave correctly
 *   RS-1     flag on + a tool turn → result.reasoningSummary is populated
 *   RS-2     flag off → reasoningSummary undefined (no behavior change)
 *   RS-3     flag on + a no-tool turn → reasoningSummary undefined (no actions)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { buildReasoningSummary, formatReasoningSummary } from '../../src/core/agent/reasoning-summary.js';
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
function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

describe('Theme 2.2: reasoning-summary module', () => {
  it('RS-unit: builds steps + confidence and formats markdown', () => {
    const actions = [
      { tool: 'web.search', result: 'found 3 results', timestamp: 't1' },
      { tool: 'web.fetch', result: 'page body', timestamp: 't2' },
    ];
    const s = buildReasoningSummary(actions, 'research the topic');
    expect(s.stepsCompleted).toHaveLength(2);
    expect(s.confidence).toBe('medium'); // 2 steps → medium
    expect(s.approach).toContain('research the topic');

    const md = formatReasoningSummary(s);
    expect(md).toContain('**Approach:**');
    expect(md).toContain('**Confidence:** medium');
    expect(md).toContain('web.search');
  });

  it('RS-unit: confidence bands by step count', () => {
    const a = (n: number) => Array.from({ length: n }, (_, i) => ({ tool: `t${i}`, result: 'r', timestamp: '' }));
    expect(buildReasoningSummary(a(1), 'x').confidence).toBe('low');
    expect(buildReasoningSummary(a(2), 'x').confidence).toBe('medium');
    expect(buildReasoningSummary(a(5), 'x').confidence).toBe('high');
  });
});

describe('Theme 2.2: reasoning-summary loop wiring', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_REASONING_SUMMARY']; delete process.env['SUDO_REASONING_SUMMARY']; });
  afterEach(() => { if (saved === undefined) delete process.env['SUDO_REASONING_SUMMARY']; else process.env['SUDO_REASONING_SUMMARY'] = saved; });

  it('RS-1: flag on + a tool turn populates result.reasoningSummary', async () => {
    process.env['SUDO_REASONING_SUMMARY'] = '1';
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce({
        content: 'calling a tool',
        toolCalls: [{ id: 'tc-1', name: 'system.hello', arguments: {} }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
        model: 'xai/grok-3-fast', finishReason: 'tool-calls',
      } as BrainResponse)
      .mockResolvedValue(stop());
    const registry = createMockToolRegistry();
    registry.execute.mockResolvedValue({ success: true, output: 'hello output', data: {} });

    const result = await makeLoop(brain, registry).run('test-session-id', 'say hello');

    expect(result.reasoningSummary).toBeDefined();
    expect(result.reasoningSummary).toContain('system.hello');
    expect(result.reasoningSummary).toContain('Confidence');
  });

  it('RS-2: flag off → no reasoningSummary (unchanged result)', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const result = await makeLoop(brain).run('test-session-id', 'hi');
    expect(result.reasoningSummary).toBeUndefined();
  });

  it('RS-3: flag on + a no-tool turn → no reasoningSummary', async () => {
    process.env['SUDO_REASONING_SUMMARY'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const result = await makeLoop(brain).run('test-session-id', 'hi');
    expect(result.reasoningSummary).toBeUndefined();
  });
});
