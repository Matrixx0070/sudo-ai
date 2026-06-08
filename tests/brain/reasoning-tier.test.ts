/**
 * @file tests/brain/reasoning-tier.test.ts
 * @description C9 — couple reasoningLevel to model-tier selection.
 *
 *  1. RTIER-1: reasoningLevel='xhigh' + premium configured → routes to premium, skips consensus.
 *  2. RTIER-2: reasoningLevel='high' takes precedence over the cheap fast-path.
 *  3. RTIER-3: reasoningLevel='low'/'medium' → NO premium routing.
 *  4. RTIER-4: no premium configured → inert, consensus runs.
 *  5. RTIER-5: SUDO_REASONING_TIER_DISABLE=1 disables it.
 *  6. RTIER-6: explicit request.model pin overrides reasoning-tier.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

const PRIMARY = 'ollama/deepseek-v4-pro:cloud';
const PREMIUM = 'anthropic/claude-opus-4-8';
const CHEAP = 'xai/grok-3-mini';

function entry(id: string) {
  return { id, contextWindow: 8192, maxOutputTokens: 4096, temperature: 0.5 };
}
function cfg(models: Record<string, unknown>): any {
  return { models: { embedding: { id: 'openai/text-embedding-3-small', dims: 1536 }, ...models } };
}
function profile(id: string): ModelProfile {
  const slash = id.indexOf('/');
  return { id, provider: id.slice(0, slash) as ModelProfile['provider'], modelId: id.slice(slash + 1), priority: 0, lastUsed: 0, cooldownUntil: 0, consecutiveErrors: 0, disabled: false };
}

function makeBrain(config: any) {
  const brain = new Brain(config);
  const getCloudProfiles = vi.fn().mockReturnValue([profile('ollama/kimi-k2.6:cloud')]);
  (brain as any).failover.getCloudProfiles = getCloudProfiles;
  const callSingleModel = vi.fn().mockImplementation(async (p: ModelProfile) => ({
    content: `r-${p.id}`, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCost: 0 }, model: p.id, finishReason: 'stop' as const,
  }));
  (brain as any)._callSingleModel = callSingleModel;
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValue(profile(PRIMARY));
  (brain as any).failover.recordError = vi.fn();
  (brain as any).failover.recordSuccess = vi.fn();
  return { brain, getCloudProfiles, callSingleModel };
}

describe('C9: reasoning-tier model routing', () => {
  const ENV = ['SUDO_PREMIUM_MODEL', 'SUDO_CHEAP_MODEL', 'SUDO_REASONING_TIER_DISABLE', 'SUDO_SMART_ROUTE_DISABLE', 'SUDO_BRAIN_CONSENSUS_DISABLE'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    vi.clearAllMocks();
  });
  afterEach(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it('RTIER-1: xhigh + premium → routes to premium, skips consensus', async () => {
    const { brain, getCloudProfiles, callSingleModel } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest'), premium: PREMIUM }));
    const res = await brain.call({ messages: [{ role: 'user', content: 'reason deeply about this' }], reasoningLevel: 'xhigh' });
    expect(res.model).toBe(PREMIUM);
    expect((callSingleModel.mock.calls[0][0] as ModelProfile).id).toBe(PREMIUM);
    expect(getCloudProfiles).not.toHaveBeenCalled();
  });

  it('RTIER-2: high reasoning beats the cheap fast-path', async () => {
    process.env['SUDO_CHEAP_MODEL'] = CHEAP; // would otherwise cheap-route a simple turn
    const { brain, callSingleModel } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest'), premium: PREMIUM }));
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'high' });
    expect(res.model).toBe(PREMIUM);
    expect((callSingleModel.mock.calls[0][0] as ModelProfile).id).toBe(PREMIUM);
  });

  it('RTIER-3: low/medium reasoning does NOT route to premium', async () => {
    const { brain, getCloudProfiles } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest'), premium: PREMIUM }));
    await brain.call({ messages: [{ role: 'user', content: 'write me an essay about clouds' }], reasoningLevel: 'low' });
    expect(getCloudProfiles).toHaveBeenCalled();
  });

  it('RTIER-4: no premium configured → inert, consensus runs', async () => {
    const { brain, getCloudProfiles } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest') }));
    await brain.call({ messages: [{ role: 'user', content: 'reason deeply' }], reasoningLevel: 'xhigh' });
    expect(getCloudProfiles).toHaveBeenCalled();
  });

  it('RTIER-5: SUDO_REASONING_TIER_DISABLE=1 disables it', async () => {
    process.env['SUDO_REASONING_TIER_DISABLE'] = '1';
    const { brain, getCloudProfiles } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest'), premium: PREMIUM }));
    await brain.call({ messages: [{ role: 'user', content: 'reason deeply' }], reasoningLevel: 'xhigh' });
    expect(getCloudProfiles).toHaveBeenCalled();
  });

  it('RTIER-6: explicit model pin overrides reasoning-tier', async () => {
    const { brain, getCloudProfiles, callSingleModel } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest'), premium: PREMIUM }));
    await brain.call({ messages: [{ role: 'user', content: 'reason deeply' }], reasoningLevel: 'xhigh', model: 'xai/grok-4-0709' });
    // pin means _smartRoute returns null → consensus path runs, premium not forced
    expect(getCloudProfiles).toHaveBeenCalled();
    const ids = callSingleModel.mock.calls.map((c) => (c[0] as ModelProfile).id);
    expect(ids).not.toContain(PREMIUM);
  });
});
