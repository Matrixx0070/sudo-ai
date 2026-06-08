/**
 * @file tests/agent/preferred-model-validation.test.ts
 * @description Theme 1.2 follow-up — validate a TraceDrivenPolicy's preferredModel
 * against the brain's ACTIVE (configured) model profiles before routing to it. A
 * stale learned/manual rule can name a model that is no longer configured; routing
 * there wastes a call + triggers failover.
 *
 *   PMV-1  an ACTIVE preferredModel is applied (brain.call gets it)
 *   PMV-2  a STALE preferredModel is ignored (brain.call does NOT get it)
 *   PMV-3  no getFailoverStatus → fail-open, applied (prior behavior preserved)
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { TraceDrivenPolicy } from '../../src/core/learning/trace-driven-policy.js';
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
function stop(): BrainResponse {
  return { content: 'done', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}
// A policy stub that always recommends `preferredModel`.
function policyStub(preferredModel: string) {
  return {
    evaluate: () => ({ decision: { action: { preferredModel }, ruleId: 'r1', confidence: 0.9, source: 'trace' } }),
    recordOutcome: () => { /* no-op */ },
  } as unknown as TraceDrivenPolicy;
}
function withActiveModels(brain: ReturnType<typeof createMockBrain>, profiles: Array<{ id?: string; modelId?: string }>) {
  (brain as unknown as { getFailoverStatus: () => unknown[] }).getFailoverStatus = () => profiles;
}
function firstCallModel(brain: ReturnType<typeof createMockBrain>): unknown {
  return brain.call.mock.calls[0]?.[0]?.model;
}

describe('Theme 1.2: preferredModel validation', () => {
  it('PMV-1: an active preferredModel is applied', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    withActiveModels(brain, [{ id: 'active/model', modelId: 'model' }]);
    const loop = makeLoop(brain);
    loop.setTraceDrivenPolicy(policyStub('active/model'));
    await loop.run('test-session-id', 'hi');
    expect(firstCallModel(brain)).toBe('active/model');
  });

  it('PMV-2: a stale preferredModel (not in active set) is ignored', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    withActiveModels(brain, [{ id: 'active/model', modelId: 'model' }]); // 'stale/model' not present
    const loop = makeLoop(brain);
    loop.setTraceDrivenPolicy(policyStub('stale/model'));
    await loop.run('test-session-id', 'hi');
    expect(firstCallModel(brain)).not.toBe('stale/model');
  });

  it('PMV-3: no getFailoverStatus → fail-open (applied, prior behavior)', async () => {
    const brain = createMockBrain(); // no getFailoverStatus
    brain.call.mockResolvedValue(stop());
    const loop = makeLoop(brain);
    loop.setTraceDrivenPolicy(policyStub('whatever/model'));
    await loop.run('test-session-id', 'hi');
    expect(firstCallModel(brain)).toBe('whatever/model');
  });

  it('PMV-4: matches the raw modelId form too (robust to id/modelId)', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop());
    withActiveModels(brain, [{ id: 'xai/grok-3-fast', modelId: 'grok-3-fast' }]);
    const loop = makeLoop(brain);
    loop.setTraceDrivenPolicy(policyStub('grok-3-fast')); // raw modelId
    await loop.run('test-session-id', 'hi');
    expect(firstCallModel(brain)).toBe('grok-3-fast');
  });
});
