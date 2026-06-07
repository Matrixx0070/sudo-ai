/**
 * @file tests/brain/auto-route.test.ts
 * @description A3 — model-router category routing for request.model === 'auto'.
 *
 *  1. AUTO-1: model='auto' routes to the keyword-category model and skips consensus.
 *  2. AUTO-2: category model === primary → inert, consensus runs.
 *  3. AUTO-3: model unset (not 'auto') → category routing is NOT applied.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// model-router is mocked so we can drive routeModel() deterministically — its
// real ROUTING_MODELS all resolve to the primary today, which would be inert.
vi.mock('../../src/core/brain/model-router.js', () => ({
  routeModel: vi.fn(),
  isAutoModel: (m?: string) => !m || m === 'auto' || m === '',
}));

import { Brain } from '../../src/core/brain/brain.js';
import { routeModel } from '../../src/core/brain/model-router.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

const PRIMARY = 'ollama/deepseek-v4-pro:cloud';
const mockedRouteModel = vi.mocked(routeModel);

function profile(id: string): ModelProfile {
  const slash = id.indexOf('/');
  return {
    id,
    provider: id.slice(0, slash) as ModelProfile['provider'],
    modelId: id.slice(slash + 1),
    priority: 0,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    disabled: false,
  };
}

function makeBrain(cloud: ModelProfile[]) {
  const brain = new Brain(null);
  const getCloudProfiles = vi.fn().mockReturnValue(cloud);
  (brain as any).failover.getCloudProfiles = getCloudProfiles;
  const callSingleModel = vi.fn().mockImplementation(async (p: ModelProfile) => ({
    content: `response-from-${p.id}`,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0 },
    model: p.id,
    finishReason: 'stop' as const,
  }));
  (brain as any)._callSingleModel = callSingleModel;
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValue(profile(PRIMARY));
  (brain as any).failover.recordError = vi.fn();
  (brain as any).failover.recordSuccess = vi.fn();
  return { brain, getCloudProfiles, callSingleModel };
}

describe('Brain A3: model-router category routing for model="auto"', () => {
  const ENV = ['SUDO_CHEAP_MODEL', 'SUDO_SMART_ROUTE_DISABLE', 'SUDO_BRAIN_CONSENSUS_DISABLE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('AUTO-1: model="auto" routes to the category model and skips consensus', async () => {
    mockedRouteModel.mockReturnValue({
      model: 'xai/grok-4-routed',
      category: 'coding',
      scores: { coding: 9, analysis: 0, research: 0, fast: 0 },
    });
    const { brain, getCloudProfiles, callSingleModel } = makeBrain([profile('ollama/kimi-k2.6:cloud')]);

    const res = await brain.call({
      messages: [{ role: 'user', content: 'fix this bug in my code' }],
      model: 'auto',
    });

    expect(mockedRouteModel).toHaveBeenCalledWith('', 'fix this bug in my code');
    expect(res.model).toBe('xai/grok-4-routed');
    expect((callSingleModel.mock.calls[0][0] as ModelProfile).id).toBe('xai/grok-4-routed');
    expect(getCloudProfiles).not.toHaveBeenCalled();
  });

  it('AUTO-2: category model === primary → inert, consensus runs', async () => {
    mockedRouteModel.mockReturnValue({
      model: PRIMARY,
      category: 'fast',
      scores: { coding: 0, analysis: 0, research: 0, fast: 0 },
    });
    const { brain, getCloudProfiles } = makeBrain([profile('ollama/kimi-k2.6:cloud')]);

    await brain.call({ messages: [{ role: 'user', content: 'hello there' }], model: 'auto' });

    expect(getCloudProfiles).toHaveBeenCalled();
  });

  it('AUTO-3: model unset (not "auto") → category routing not applied', async () => {
    mockedRouteModel.mockReturnValue({
      model: 'xai/grok-4-routed',
      category: 'coding',
      scores: { coding: 9, analysis: 0, research: 0, fast: 0 },
    });
    const { brain, getCloudProfiles } = makeBrain([profile('ollama/kimi-k2.6:cloud')]);

    await brain.call({ messages: [{ role: 'user', content: 'fix this bug' }] });

    expect(mockedRouteModel).not.toHaveBeenCalled();
    expect(getCloudProfiles).toHaveBeenCalled();
  });
});
