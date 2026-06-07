/**
 * @file tests/agent/trace-policy.test.ts
 * @description Theme 1 (learning flywheel, slice 2) — once a TraceDrivenPolicy is
 * wired, the loop evaluates it to (conservatively) override the model, feeds back
 * outcomes, and stays fail-open. cli.ts does the boot wiring (opt-in + ZDR-gated).
 *
 *   POLICY-1  a learned rule overrides the model + outcomes are fed back
 *   POLICY-2  a no-decision evaluation leaves the model unchanged
 *   POLICY-3  a throwing policy is fail-open (turn still completes)
 *   POLICY-4  setTraceDrivenPolicy rejects an invalid duck-type
 */

import { describe, it, expect, vi } from 'vitest';
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
  return new AgentLoop(
    brain, registry, createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

const OVERRIDE = 'anthropic/claude-opus-4-8';

function brainCalledWithModel(brain: ReturnType<typeof createMockBrain>, model: string): boolean {
  return brain.call.mock.calls.some((c: any[]) => c[0]?.model === model);
}

describe('Theme 1: TraceDrivenPolicy routing influence', () => {
  it('POLICY-1: a learned rule overrides the model and outcomes feed back', async () => {
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
    registry.execute.mockResolvedValue({ success: true, output: 'ok', data: {} });

    const policy = {
      evaluate: vi.fn(() => ({
        decision: { action: { preferredModel: OVERRIDE }, ruleId: 'r1', confidence: 0.9, source: 'trace' },
        reason: 'matched', evaluatedAt: 0,
      })),
      recordOutcome: vi.fn(),
    };
    const loop = makeLoop(brain, registry);
    loop.setTraceDrivenPolicy(policy as any);

    await loop.run('test-session-id', 'do the thing');

    expect(policy.evaluate).toHaveBeenCalled();
    expect(brainCalledWithModel(brain, OVERRIDE)).toBe(true); // model overridden
    expect(policy.recordOutcome).toHaveBeenCalled();          // outcome fed back
  });

  it('POLICY-2: a null decision leaves the model unchanged', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    const policy = {
      evaluate: vi.fn(() => ({ decision: null, reason: 'no rule', evaluatedAt: 0 })),
      recordOutcome: vi.fn(),
    };
    const loop = makeLoop(brain);
    loop.setTraceDrivenPolicy(policy as any);

    await loop.run('test-session-id', 'hi');

    expect(policy.evaluate).toHaveBeenCalled();
    expect(brainCalledWithModel(brain, OVERRIDE)).toBe(false); // no override
  });

  it('POLICY-3: a throwing policy is fail-open', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop('still works'));
    const policy = {
      evaluate: vi.fn(() => { throw new Error('policy boom'); }),
      recordOutcome: vi.fn(),
    };
    const loop = makeLoop(brain);
    loop.setTraceDrivenPolicy(policy as any);

    const result = await loop.run('test-session-id', 'hi');

    expect(policy.evaluate).toHaveBeenCalled();
    expect(result.text).toBe('still works');
  });

  it('POLICY-4: setTraceDrivenPolicy rejects an invalid duck-type', () => {
    const loop = makeLoop(createMockBrain());
    loop.setTraceDrivenPolicy({ evaluate: vi.fn() } as any); // missing recordOutcome
    expect(loop.getTraceDrivenPolicy()).toBeUndefined();
  });

  it('POLICY-5: outcomes are attributed to the ACTUAL model, not the suggested one', async () => {
    // Policy suggests OVERRIDE, but the brain answers as xai/grok-3-fast.
    // The flywheel must learn against the model that actually ran.
    const brain = createMockBrain();
    brain.call
      .mockResolvedValueOnce({
        content: 'calling a tool',
        toolCalls: [{ id: 'tc-1', name: 'system.hello', arguments: {} }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
        model: 'xai/grok-3-fast', finishReason: 'tool-calls',
      } as BrainResponse)
      .mockResolvedValue(stop()); // model: 'xai/grok-3-fast'
    const registry = createMockToolRegistry();
    registry.execute.mockResolvedValue({ success: true, output: 'ok', data: {} });

    const policy = {
      evaluate: vi.fn(() => ({
        decision: { action: { preferredModel: OVERRIDE }, ruleId: 'r1', confidence: 0.9, source: 'trace' },
        reason: '', evaluatedAt: 0,
      })),
      recordOutcome: vi.fn(),
    };
    const ts = { recordToolCall: vi.fn(), recordBrainCall: vi.fn(), recordRouting: vi.fn() };
    const loop = makeLoop(brain, registry);
    loop.setTraceStore(ts as any);
    loop.setTraceDrivenPolicy(policy as any);

    await loop.run('test-session-id', 'do it');

    // recordBrainCall's model arg (index 1) = actual answering model, never the suggested OVERRIDE.
    expect(ts.recordBrainCall).toHaveBeenCalled();
    expect(ts.recordBrainCall.mock.calls.every((c: any[]) => c[1] !== OVERRIDE)).toBe(true);
    expect(ts.recordBrainCall.mock.calls.some((c: any[]) => c[1] === 'xai/grok-3-fast')).toBe(true);

    // recordOutcome's model arg (index 3) = actual model, never the suggested OVERRIDE.
    expect(policy.recordOutcome).toHaveBeenCalled();
    expect(policy.recordOutcome.mock.calls.every((c: any[]) => c[3] !== OVERRIDE)).toBe(true);
    expect(policy.recordOutcome.mock.calls.some((c: any[]) => c[3] === 'xai/grok-3-fast')).toBe(true);
  });
});
