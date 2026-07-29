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
import { ModelFailover } from '../../src/core/brain/failover.js';
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

// ---------------------------------------------------------------------------
// Fast-path <-> failover-registry integration (ADR 0003 tie-in).
// Previously the fast-path used a synthetic profile and NEVER consulted or fed
// the registry — every smart-routed turn re-burned a wire call on a credential
// the registry already knew was dead (live-observed 2026-07-29: one fable 403
// per turn while the Anthropic org block was active).
// ---------------------------------------------------------------------------
describe('Brain smart-route fast-path — failover registry integration', () => {
  const PRIMARY_R = 'ollama/deepseek-v4-pro:cloud'; // === DEFAULT_MODEL for Brain(null)
  const CHEAP_R = 'claude-oauth/claude-fable-5';
  const SIBLING_R = 'claude-oauth/claude-haiku-4-5-20251001';

  const ENV_KEYS = ['SUDO_CHEAP_MODEL', 'SUDO_SMART_ROUTE_DISABLE', 'SUDO_BRAIN_CONSENSUS_DISABLE', 'SUDO_FAILOVER_DOMAINS'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env['SUDO_CHEAP_MODEL'] = CHEAP_R;
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const FORBIDDEN_403 = Object.assign(new Error('HTTP 403 permission_error'), {
    statusCode: 403,
    responseBody:
      '{"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}',
  });

  function makeBrainWithRegistry(chain: string[]) {
    const brain = new Brain(null);
    const failover = new ModelFailover(chain);
    (brain as unknown as { failover: ModelFailover }).failover = failover;
    // Empty cloud set → consensus is skipped and the sequential failover walk
    // (real getNextProfile over the real registry) serves the fall-through.
    (failover as unknown as { getCloudProfiles: () => ModelProfile[] }).getCloudProfiles = vi
      .fn()
      .mockReturnValue([]);
    const callSingleModel = vi.fn().mockImplementation(async (p: ModelProfile) => {
      if (p.id === CHEAP_R) throw FORBIDDEN_403;
      return {
        content: `response-from-${p.id}`,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0 },
        model: p.id,
        finishReason: 'stop' as const,
      };
    });
    (brain as unknown as { _callSingleModel: unknown })._callSingleModel = callSingleModel;
    return { brain, failover, callSingleModel };
  }

  it('FASTPATH-6: a disabled registered target is skipped without a wire call', async () => {
    const { brain, failover, callSingleModel } = makeBrainWithRegistry([PRIMARY_R, CHEAP_R]);
    failover.recordError(CHEAP_R, 'auth_permanent', { rng: () => 0 });

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    const usedIds = callSingleModel.mock.calls.map((c) => (c[0] as ModelProfile).id);
    expect(usedIds).not.toContain(CHEAP_R);
    expect(res.model).toBe(PRIMARY_R);
  });

  it('FASTPATH-7: a cooling registered target is skipped without a wire call', async () => {
    const { brain, failover, callSingleModel } = makeBrainWithRegistry([PRIMARY_R, CHEAP_R]);
    failover.recordError(CHEAP_R, 'auth', { rng: () => 0 });

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    const usedIds = callSingleModel.mock.calls.map((c) => (c[0] as ModelProfile).id);
    expect(usedIds).not.toContain(CHEAP_R);
    expect(res.model).toBe(PRIMARY_R);
  });

  it('FASTPATH-8: a fast-path 403 on a registered target disables it and parks its domain (ADR 0003)', async () => {
    const { brain, failover, callSingleModel } = makeBrainWithRegistry([PRIMARY_R, CHEAP_R, SIBLING_R]);

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    // The turn still succeeded via fall-through.
    expect(res.model).toBe(PRIMARY_R);
    // Fast-path attempted the cheap target once…
    const usedIds = callSingleModel.mock.calls.map((c) => (c[0] as ModelProfile).id);
    expect(usedIds).toContain(CHEAP_R);
    // …and the registry learned from it: target disabled, domain sibling parked.
    const status = new Map(failover.getStatus().map((p) => [p.id, p]));
    expect(status.get(CHEAP_R)!.disabled).toBe(true);
    expect(status.get(SIBLING_R)!.cooldownClass).toBe('auth');
    expect(failover.getCooldownRemaining(SIBLING_R)).toBeGreaterThan(0);
  });

  it('FASTPATH-9: fast-path success on a registered target records recordSuccess', async () => {
    const { brain, failover, callSingleModel } = makeBrainWithRegistry([PRIMARY_R, CHEAP_R]);
    callSingleModel.mockImplementation(async (p: ModelProfile) => ({
      content: `response-from-${p.id}`,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0 },
      model: p.id,
      finishReason: 'stop' as const,
    }));
    const successSpy = vi.spyOn(failover, 'recordSuccess');

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.model).toBe(CHEAP_R);
    expect(successSpy).toHaveBeenCalledWith(CHEAP_R);
  });

  it('FASTPATH-10: an UNREGISTERED (synthetic) target never touches the registry', async () => {
    process.env['SUDO_CHEAP_MODEL'] = 'xai/grok-3-mini'; // not in the chain
    const { brain, failover, callSingleModel } = makeBrainWithRegistry([PRIMARY_R]);
    callSingleModel.mockImplementation(async (p: ModelProfile) => {
      if (p.id === 'xai/grok-3-mini') throw FORBIDDEN_403;
      return {
        content: `response-from-${p.id}`,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0 },
        model: p.id,
        finishReason: 'stop' as const,
      };
    });
    const errorSpy = vi.spyOn(failover, 'recordError');
    const successSpy = vi.spyOn(failover, 'recordSuccess');

    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.model).toBe(PRIMARY_R);
    expect(errorSpy).not.toHaveBeenCalledWith('xai/grok-3-mini', expect.anything(), expect.anything());
    expect(successSpy).not.toHaveBeenCalledWith('xai/grok-3-mini');
  });
});
