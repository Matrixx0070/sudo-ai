/**
 * Hard iteration cap graceful fallback: when the loop exhausts
 * agents.maxIterations it used to throw PipelineError('pipeline_max_iterations')
 * — a hard failure surfaced to the user. It now finishes the turn with the
 * same style of fallback the consecutive-tool-iteration cap uses: prefer the
 * model's own last assistant text, else buildLoopFallbackReply. Kill-switch
 * SUDO_MAX_ITER_FALLBACK=0 restores the legacy throw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { LOOP_FALLBACK_FIRST_HIT } from '../../src/core/agent/loop-fallback.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainRequest, BrainResponse } from '../../src/core/brain/types.js';

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

function makeLoop(brain: ReturnType<typeof createMockBrain>, maxIterations: number) {
  const registry = createMockToolRegistry();
  registry.execute.mockResolvedValue({ success: true, output: 'ok', data: {} });
  return new AgentLoop(
    brain, registry, createMockSessionManager(),
    { maxIterations }, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

/** Brain that returns tool calls forever (varying args so loop guards on
 *  identical calls never fire) — the loop can only stop at the hard cap. */
function endlessToolBrain(content: (n: number) => string) {
  const brain = createMockBrain();
  let n = 0;
  brain.call.mockImplementation(async (_req: BrainRequest): Promise<BrainResponse> => {
    n++;
    return {
      content: content(n),
      toolCalls: [{ id: `tc-${n}`, name: 'system.hello', arguments: { step: n } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
      model: 'xai/grok-3-fast',
      finishReason: 'tool-calls',
    } as BrainResponse;
  });
  return brain;
}

describe('hard max-iterations fallback', () => {
  afterEach(() => { delete process.env['SUDO_MAX_ITER_FALLBACK']; });

  it('finishes the turn with the last assistant text instead of throwing', async () => {
    const brain = endlessToolBrain(n => `working on it (step ${n})`);
    const result = await makeLoop(brain, 3).run('test-session-id', 'do the thing');
    expect(result.text).toBe('working on it (step 3)'); // model's own last text preferred
  });

  it('falls back to the canned LoopGuard reply when no assistant text exists', async () => {
    const brain = endlessToolBrain(() => '');
    const result = await makeLoop(brain, 3).run('test-session-id', 'do the thing');
    expect(result.text).toBe(LOOP_FALLBACK_FIRST_HIT);
  });

  it('kill-switch=0 restores the legacy PipelineError throw', async () => {
    process.env['SUDO_MAX_ITER_FALLBACK'] = '0';
    const brain = endlessToolBrain(n => `working on it (step ${n})`);
    await expect(makeLoop(brain, 3).run('test-session-id', 'do the thing'))
      .rejects.toThrow(/max iterations/);
  });

  it('a turn that finishes normally is unaffected', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue({
      content: 'plain answer',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
      model: 'xai/grok-3-fast',
      finishReason: 'stop',
    } as BrainResponse);
    const result = await makeLoop(brain, 3).run('test-session-id', 'hi');
    expect(result.text).toBe('plain answer');
  });
});
