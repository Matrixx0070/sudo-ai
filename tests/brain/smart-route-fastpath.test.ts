/**
 * @file tests/brain/smart-route-fastpath.test.ts
 * @description Tests for the smart-route fast-path in brain.ts that wires the
 * cost-optimizer (task-difficulty + cheap-tier pick) and dispatch-router
 * (cheap-vs-primary decision) into Brain.call().
 *
 * Tests:
 *  1. FASTPATH-1: Simple turn + a genuinely cheaper SUDO_CHEAP_MODEL → fast-path
 *     fires, calls the cheap model, and SKIPS the cloud-consensus race.
 *  2. FASTPATH-2: Complex turn (complexity keyword) → fast-path does NOT fire;
 *     consensus runs as before.
 *  3. FASTPATH-3: SUDO_SMART_ROUTE_DISABLE=1 → fast-path disabled; consensus runs.
 *  4. FASTPATH-4: No cheaper model than the primary configured → fast-path inert;
 *     consensus runs (default behavior preserved).
 *  5. FASTPATH-5: Fast-path model errors → falls through to consensus + failover.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import type { ModelProfile } from '../../src/core/brain/types.js';

const PRIMARY = 'ollama/deepseek-v4-pro:cloud'; // === DEFAULT_MODEL for Brain(null)
const CHEAP = 'xai/grok-3-mini';

function profile(id: string, priority = 0): ModelProfile {
  const slash = id.indexOf('/');
  return {
    id,
    provider: id.slice(0, slash) as ModelProfile['provider'],
    modelId: id.slice(slash + 1),
    priority,
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

describe('Brain smart-route fast-path (cost-optimizer + dispatch-router)', () => {
  const ENV_KEYS = ['SUDO_CHEAP_MODEL', 'SUDO_SMART_ROUTE_DISABLE', 'SUDO_BRAIN_CONSENSUS_DISABLE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('FASTPATH-1: simple turn + cheaper model → uses cheap model and skips consensus', async () => {
    process.env['SUDO_CHEAP_MODEL'] = CHEAP;
    const { brain, getCloudProfiles, callSingleModel } = makeBrain([
      profile('ollama/kimi-k2.6:cloud'),
      profile('ollama/glm-5.1:cloud'),
    ]);

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.model).toBe(CHEAP);
    expect(callSingleModel).toHaveBeenCalledTimes(1);
    expect((callSingleModel.mock.calls[0][0] as ModelProfile).id).toBe(CHEAP);
    // Consensus must be bypassed entirely.
    expect(getCloudProfiles).not.toHaveBeenCalled();
  });

  it('FASTPATH-2: complex turn → fast-path skipped, consensus runs', async () => {
    process.env['SUDO_CHEAP_MODEL'] = CHEAP;
    const { brain, getCloudProfiles, callSingleModel } = makeBrain([
      profile('ollama/kimi-k2.6:cloud'),
      profile('ollama/glm-5.1:cloud'),
    ]);

    const res = await brain.call({
      messages: [{ role: 'user', content: 'Please debug and refactor this module' }],
    });

    expect(getCloudProfiles).toHaveBeenCalled();
    // Winner is a cloud model, never the cheap one.
    expect(res.model).not.toBe(CHEAP);
    const usedIds = callSingleModel.mock.calls.map((c) => (c[0] as ModelProfile).id);
    expect(usedIds).not.toContain(CHEAP);
  });

  it('FASTPATH-3: SUDO_SMART_ROUTE_DISABLE=1 disables the fast-path', async () => {
    process.env['SUDO_CHEAP_MODEL'] = CHEAP;
    process.env['SUDO_SMART_ROUTE_DISABLE'] = '1';
    const { brain, getCloudProfiles } = makeBrain([profile('ollama/kimi-k2.6:cloud')]);

    await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(getCloudProfiles).toHaveBeenCalled();
  });

  it('FASTPATH-4: no model cheaper than primary → fast-path inert, consensus runs', async () => {
    // No SUDO_CHEAP_MODEL: cost-optimizer resolves the cheapest tier to the
    // primary itself, so there is nothing to optimize.
    const { brain, getCloudProfiles } = makeBrain([profile('ollama/kimi-k2.6:cloud')]);

    await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(getCloudProfiles).toHaveBeenCalled();
  });

  it('FASTPATH-5: fast-path model error falls through to consensus + failover', async () => {
    process.env['SUDO_CHEAP_MODEL'] = CHEAP;
    const { brain, getCloudProfiles, callSingleModel } = makeBrain([
      profile('ollama/kimi-k2.6:cloud'),
    ]);
    // Cheap target throws; cloud models succeed.
    callSingleModel.mockImplementation(async (p: ModelProfile) => {
      if (p.id === CHEAP) throw new Error('cheap model unavailable');
      return {
        content: `response-from-${p.id}`,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0 },
        model: p.id,
        finishReason: 'stop' as const,
      };
    });

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    // Fast-path was attempted (cheap) then fell through to the consensus path.
    const usedIds = callSingleModel.mock.calls.map((c) => (c[0] as ModelProfile).id);
    expect(usedIds).toContain(CHEAP);
    expect(getCloudProfiles).toHaveBeenCalled();
    expect(res.model).not.toBe(CHEAP);
  });
});
