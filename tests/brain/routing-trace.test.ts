/**
 * @file tests/brain/routing-trace.test.ts
 * @description Phase D — observability: describeRouting formatter + the RoutingTrace
 * attached to every BrainResponse per decision path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import { describeRouting, type RoutingTrace } from '../../src/core/brain/routing-trace.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

const PRIMARY = 'ollama/deepseek-v4-pro:cloud';
const CHEAP = 'xai/grok-3-mini';
const PREMIUM = 'anthropic/claude-opus-4-8';

function entry(id: string) { return { id, contextWindow: 8192, maxOutputTokens: 4096, temperature: 0.5 }; }
function cfg(models: Record<string, unknown>): any {
  return { models: { embedding: { id: 'openai/text-embedding-3-small', dims: 1536 }, ...models } };
}
function profile(id: string): ModelProfile {
  const slash = id.indexOf('/');
  return { id, provider: id.slice(0, slash) as ModelProfile['provider'], modelId: id.slice(slash + 1), priority: 0, lastUsed: 0, cooldownUntil: 0, consecutiveErrors: 0, disabled: false };
}
function makeBrain(config: any, cloud: ModelProfile[]) {
  const brain = new Brain(config);
  const getCloudProfiles = vi.fn().mockReturnValue(cloud);
  (brain as any).failover.getCloudProfiles = getCloudProfiles;
  const callSingleModel = vi.fn().mockImplementation(async (p: ModelProfile) => ({
    content: `r-${p.id}`, toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0.0021 }, model: p.id, finishReason: 'stop' as const,
  }));
  (brain as any)._callSingleModel = callSingleModel;
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValue(profile(PRIMARY));
  (brain as any).failover.recordError = vi.fn();
  (brain as any).failover.recordSuccess = vi.fn();
  return { brain, callSingleModel };
}

describe('Phase D: describeRouting formatter', () => {
  const base: RoutingTrace = { path: 'cheap', reason: 'simple', selectedModel: PRIMARY, activeModel: CHEAP, switched: true, costUSD: 0.0012 };

  it('TRACE-1: cheap path shows model, cost, and the switched notice', () => {
    const s = describeRouting(base);
    expect(s).toContain('cheap-route');
    expect(s).toContain(CHEAP);
    expect(s).toContain('$0.0012');
    expect(s).toContain('selected'); // switched notice
  });

  it('TRACE-2: consensus shows method + agreement percent', () => {
    const s = describeRouting({ path: 'consensus', reason: 'consensus:fastest', selectedModel: PRIMARY, activeModel: PRIMARY, switched: false, costUSD: 0.003, consensus: { agreement: 0.82, method: 'fastest' } });
    expect(s).toContain('consensus(fastest 82%)');
    expect(s).not.toContain('selected'); // not switched
  });

  it('TRACE-3: failover shows attempt count; blocked shows reason', () => {
    expect(describeRouting({ path: 'failover', reason: 'x', selectedModel: PRIMARY, activeModel: 'ollama/qwen3.5:latest', switched: true, costUSD: 0.001, failoverAttempts: 2 })).toContain('failover(#2)');
    expect(describeRouting({ path: 'blocked', reason: 'negative-router:hacking', selectedModel: 'blocked', activeModel: 'blocked', switched: false, costUSD: 0 })).toContain('blocked: negative-router:hacking');
  });
});

describe('Phase D: BrainResponse.routing per path', () => {
  const ENV = ['SUDO_CHEAP_MODEL', 'SUDO_PREMIUM_MODEL', 'SUDO_BRAIN_CONSENSUS_DISABLE', 'SUDO_SMART_ROUTE_DISABLE', 'SUDO_REASONING_TIER_DISABLE'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } vi.clearAllMocks(); });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('TRACE-4: cheap fast-path trace', async () => {
    process.env['SUDO_CHEAP_MODEL'] = CHEAP;
    const { brain } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest') }), [profile('ollama/kimi-k2.6:cloud')]);
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.routing?.path).toBe('cheap');
    expect(res.routing?.activeModel).toBe(CHEAP);
    expect(res.routing?.switched).toBe(true);
    expect(res.routing?.costUSD).toBe(0.0021);
  });

  it('TRACE-5: consensus trace carries agreement + method', async () => {
    const { brain } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest') }), [profile('ollama/kimi-k2.6:cloud'), profile('ollama/glm-5.1:cloud')]);
    const res = await brain.call({ messages: [{ role: 'user', content: 'compare these options carefully' }] });
    expect(res.routing?.path).toBe('consensus');
    expect(res.routing?.consensus?.method).toBeDefined();
    expect(typeof res.routing?.consensus?.agreement).toBe('number');
  });

  it('TRACE-6: failover trace records the attempt count', async () => {
    const { brain } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest') }), []); // no cloud → Phase 2
    const res = await brain.call({ messages: [{ role: 'user', content: 'do the thing' }] });
    expect(res.routing?.path).toBe('failover');
    expect(res.routing?.failoverAttempts).toBe(1);
    expect(res.routing?.activeModel).toBe(PRIMARY);
  });

  it('TRACE-7: reasoning-tier trace on xhigh + premium', async () => {
    process.env['SUDO_PREMIUM_MODEL'] = PREMIUM;
    const { brain } = makeBrain(cfg({ primary: [entry(PRIMARY)], fallback: entry('ollama/qwen3.5:latest') }), [profile('ollama/kimi-k2.6:cloud')]);
    const res = await brain.call({ messages: [{ role: 'user', content: 'reason deeply' }], reasoningLevel: 'xhigh' });
    expect(res.routing?.path).toBe('reasoning-tier');
    expect(res.routing?.activeModel).toBe(PREMIUM);
  });
});
