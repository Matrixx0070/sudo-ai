/**
 * @file tests/brain/fallback-chain.test.ts
 * @description B5 — user-configurable fallback chains (models.fallbacks) and the
 * config-driven cheap tier (models.cheap).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

function entry(id: string) {
  return { id, contextWindow: 8192, maxOutputTokens: 4096, temperature: 0.5 };
}

// Minimal config shape — Brain only reads models.{primary,fallbacks,fallback,cheap}.
function cfg(models: Record<string, unknown>): any {
  return { models: { embedding: { id: 'openai/text-embedding-3-small', dims: 1536 }, ...models } };
}

function chainOf(brain: Brain): string[] {
  return ((brain as any).failover.getStatus() as ModelProfile[])
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((p) => p.id);
}

describe('B5: user-configurable fallback chains', () => {
  it('CHAIN-1: order = primary ++ fallbacks ++ legacy fallback, deduped', () => {
    const brain = new Brain(
      cfg({
        primary: [entry('ollama/deepseek-v4-pro:cloud')],
        fallbacks: ['xai/grok-4-0709', 'anthropic/claude-sonnet-4-5'],
        fallback: entry('ollama/qwen3.5:latest'),
      }),
    );
    expect(chainOf(brain)).toEqual([
      'ollama/deepseek-v4-pro:cloud',
      'xai/grok-4-0709',
      'anthropic/claude-sonnet-4-5',
      'ollama/qwen3.5:latest',
    ]);
  });

  it('CHAIN-2: a malformed ref (no "/") is skipped, not crashed on', () => {
    const brain = new Brain(
      cfg({
        primary: [entry('ollama/deepseek-v4-pro:cloud')],
        fallbacks: ['not-a-valid-ref', 'xai/grok-4-0709'],
        fallback: entry('ollama/qwen3.5:latest'),
      }),
    );
    expect(chainOf(brain)).toEqual([
      'ollama/deepseek-v4-pro:cloud',
      'xai/grok-4-0709',
      'ollama/qwen3.5:latest',
    ]);
  });

  it('CHAIN-3: a fallback equal to a primary/legacy ref is de-duplicated', () => {
    const brain = new Brain(
      cfg({
        primary: [entry('ollama/deepseek-v4-pro:cloud')],
        fallbacks: ['ollama/deepseek-v4-pro:cloud', 'xai/grok-4-0709'],
        fallback: entry('xai/grok-4-0709'),
      }),
    );
    expect(chainOf(brain)).toEqual(['ollama/deepseek-v4-pro:cloud', 'xai/grok-4-0709']);
  });
});

describe('B5: config-driven cheap tier (models.cheap)', () => {
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

  it('CHEAP-1: models.cheap drives the fast-path with no SUDO_CHEAP_MODEL env', async () => {
    const brain = new Brain(
      cfg({
        primary: [entry('ollama/deepseek-v4-pro:cloud')],
        fallback: entry('ollama/qwen3.5:latest'),
        cheap: 'xai/grok-3-mini',
      }),
    );
    const getCloudProfiles = vi.fn().mockReturnValue([
      { id: 'ollama/kimi-k2.6:cloud', provider: 'ollama', modelId: 'kimi-k2.6:cloud', priority: 0, lastUsed: 0, cooldownUntil: 0, consecutiveErrors: 0, disabled: false },
    ]);
    (brain as any).failover.getCloudProfiles = getCloudProfiles;
    const callSingleModel = vi.fn().mockImplementation(async (p: ModelProfile) => ({
      content: `response-from-${p.id}`,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCost: 0 },
      model: p.id,
      finishReason: 'stop' as const,
    }));
    (brain as any)._callSingleModel = callSingleModel;
    (brain as any).failover.recordSuccess = vi.fn();

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.model).toBe('xai/grok-3-mini');
    expect((callSingleModel.mock.calls[0][0] as ModelProfile).id).toBe('xai/grok-3-mini');
    expect(getCloudProfiles).not.toHaveBeenCalled();
  });
});
