/**
 * @file tests/brain/cache-affinity.test.ts
 * @description Per-session cache-affinity opt-in (S1) — resolves the beat-openclaw
 * tradeoff without regressing the S16 smart-routing lead. See
 * docs/SPEC_SESSION_CACHE_AFFINITY.md.
 *
 * Coverage:
 *  (a) OFF = no-op — _smartRoute returns byte-identical decisions with the flag off,
 *      and the store never records a pin.
 *  (b) ON + explicit provider → every conversational turn returns that model.
 *  (c) ON + first-turn winner → turn 1 routes normally, turns 2+ pinned to it.
 *  (d) no-sessionId calls (RAG/judge/consciousness) never pin.
 *  (e) hard-fail doesn't repin (first-writer-wins keeps the pin stable).
 *  (f) store eviction (bounded + TTL) with an injected clock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/core/brain/model-router.js', () => ({
  routeModel: vi.fn(),
  isAutoModel: (m?: string) => !m || m === 'auto' || m === '',
}));

import { Brain } from '../../src/core/brain/brain.js';
import { routeModel } from '../../src/core/brain/model-router.js';
import {
  sessionCacheAffinityEnabled,
  getSessionAffinity,
  setSessionAffinity,
  clearSessionAffinity,
  affinityStoreSize,
  _resetAffinityStoreForTest,
} from '../../src/core/brain/cache-affinity.js';
import type { ModelProfile, BrainRequest } from '../../src/core/brain/types.js';

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

/** Brain wired so every path resolves through a mocked _callSingleModel that
 *  echoes the profile it was handed as the winning model. */
function makeBrain(cloud: ModelProfile[], opts?: { failSingle?: boolean }) {
  const brain = new Brain(null);
  const getCloudProfiles = vi.fn().mockReturnValue(cloud);
  (brain as any).failover.getCloudProfiles = getCloudProfiles;
  const callSingleModel = vi.fn().mockImplementation(async (p: ModelProfile) => {
    if (opts?.failSingle && p.id !== PRIMARY) {
      const err: any = new Error('permanent auth failure');
      err.status = 401;
      throw err;
    }
    return {
      content: `response-from-${p.id}`,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCost: 0 },
      model: p.id,
      finishReason: 'stop' as const,
    };
  });
  (brain as any)._callSingleModel = callSingleModel;
  (brain as any).failover.getNextProfile = vi.fn().mockReturnValue(profile(PRIMARY));
  (brain as any).failover.recordError = vi.fn();
  (brain as any).failover.recordSuccess = vi.fn();
  (brain as any).failover.categorizeError = vi.fn().mockReturnValue('auth');
  return { brain, getCloudProfiles, callSingleModel };
}

const AFFINITY_ENV = [
  'SUDO_SESSION_CACHE_AFFINITY',
  'SUDO_CACHE_AFFINITY_PROVIDER',
  'SUDO_CACHE_AFFINITY_MAX_SESSIONS',
  'SUDO_CACHE_AFFINITY_TTL_MS',
  'SUDO_CHEAP_MODEL',
  'SUDO_SMART_ROUTE_DISABLE',
  'SUDO_BRAIN_CONSENSUS_DISABLE',
];

describe('cache-affinity: per-session cache-affinity opt-in (S1)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of AFFINITY_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    _resetAffinityStoreForTest();
    vi.clearAllMocks();
    mockedRouteModel.mockReturnValue({
      model: PRIMARY,
      category: 'fast',
      scores: { coding: 0, analysis: 0, research: 0, fast: 0 },
    });
  });

  afterEach(() => {
    for (const k of AFFINITY_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAffinityStoreForTest();
  });

  // -------------------------------------------------------------------------
  // (a) OFF = no-op — byte-identical routing + no pinning.
  // -------------------------------------------------------------------------
  it('OFF: flag disabled ⇒ _smartRoute is byte-identical with/without a sessionId, and never pins', () => {
    expect(sessionCacheAffinityEnabled()).toBe(false);
    // Even set an explicit provider — it must be ignored while the flag is OFF.
    process.env['SUDO_CACHE_AFFINITY_PROVIDER'] = 'xai-oauth/grok-4-fast-non-reasoning';
    process.env['SUDO_CHEAP_MODEL'] = 'xai/grok-cheap';

    const { brain } = makeBrain([profile('ollama/kimi:cloud')]);
    const base: BrainRequest = { messages: [{ role: 'user', content: 'hello there simple turn' }] };

    const withoutSession = (brain as any)._smartRoute(base);
    const withSession = (brain as any)._smartRoute({ ...base, sessionId: 'sess-off' });

    // Identical routing decision regardless of sessionId when OFF.
    expect(withSession).toEqual(withoutSession);
    // And nothing was pinned.
    expect(affinityStoreSize()).toBe(0);
    expect(getSessionAffinity('sess-off')).toBeNull();
  });

  it('OFF: brain.call never records a pin even with a sessionId', async () => {
    const { brain } = makeBrain([]); // no cloud ⇒ straight to failover(PRIMARY)
    process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1';
    const res = await brain.call({ messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-x' });
    expect(res.model).toBe(PRIMARY);
    expect(affinityStoreSize()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (b) ON + explicit provider → every conversational turn returns that model.
  // -------------------------------------------------------------------------
  it('ON + explicit provider: every conversational turn returns the pinned model', () => {
    process.env['SUDO_SESSION_CACHE_AFFINITY'] = '1';
    process.env['SUDO_CACHE_AFFINITY_PROVIDER'] = 'xai-oauth/grok-4-fast-non-reasoning';
    const { brain } = makeBrain([profile('ollama/kimi:cloud')]);

    for (let turn = 1; turn <= 5; turn++) {
      const r = (brain as any)._smartRoute({
        messages: [{ role: 'user', content: `turn ${turn}` }],
        sessionId: 'sess-explicit',
      });
      expect(r).toEqual({
        model: 'xai-oauth/grok-4-fast-non-reasoning',
        reason: 'cache-affinity',
        complexity: 0,
        kind: 'affinity',
      });
    }
    const pin = getSessionAffinity('sess-explicit');
    expect(pin?.provider).toBe('xai-oauth');
  });

  it('ON + explicit provider: brain.call routes every turn to that model (single route)', async () => {
    process.env['SUDO_SESSION_CACHE_AFFINITY'] = '1';
    process.env['SUDO_CACHE_AFFINITY_PROVIDER'] = 'xai-oauth/grok-4-fast-non-reasoning';
    const { brain, getCloudProfiles } = makeBrain([profile('ollama/kimi:cloud')]);

    const models: string[] = [];
    for (let turn = 1; turn <= 4; turn++) {
      const res = await brain.call({
        messages: [{ role: 'user', content: `turn ${turn}` }],
        sessionId: 'sess-drive',
      });
      models.push(res.model);
    }
    expect(models).toEqual([
      'xai-oauth/grok-4-fast-non-reasoning',
      'xai-oauth/grok-4-fast-non-reasoning',
      'xai-oauth/grok-4-fast-non-reasoning',
      'xai-oauth/grok-4-fast-non-reasoning',
    ]);
    // Consensus (the multi-model race) never ran — affinity bypassed it every turn.
    expect(getCloudProfiles).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (c) ON + first-turn winner → turn 1 routes normally, turns 2+ pinned.
  // -------------------------------------------------------------------------
  it('ON + first-turn-winner: turn 1 routes normally, turns 2+ pin to the turn-1 winner', async () => {
    process.env['SUDO_SESSION_CACHE_AFFINITY'] = '1';
    // No explicit provider ⇒ discovery. Cheap model differs from primary so the
    // smart router picks it on turn 1 (a genuine routing decision, not affinity).
    process.env['SUDO_CHEAP_MODEL'] = 'xai/grok-cheap';
    mockedRouteModel.mockReturnValue({
      model: 'xai/grok-cheap',
      category: 'fast',
      scores: { coding: 0, analysis: 0, research: 0, fast: 9 },
    });
    const { brain } = makeBrain([profile('ollama/kimi:cloud')]);

    // Turn 1: no pin yet → normal routing chooses the cheap model.
    const r1 = (brain as any)._smartRoute({
      messages: [{ role: 'user', content: 'simple hello' }],
      sessionId: 'sess-fw',
    });
    // Whatever turn-1 chose, it is NOT the affinity path.
    expect(r1?.kind).not.toBe('affinity');
    // No pin was created by _smartRoute alone (winner captured in call()).
    expect(getSessionAffinity('sess-fw')).toBeNull();

    // Drive a real call so the winner is captured as the pin.
    const winner = await brain.call({
      messages: [{ role: 'user', content: 'simple hello' }],
      sessionId: 'sess-fw',
    });
    const pinnedModel = winner.model;
    expect(getSessionAffinity('sess-fw')?.model).toBe(pinnedModel);

    // Turns 2+: affinity returns the pinned turn-1 winner, skipping routing.
    for (let turn = 2; turn <= 4; turn++) {
      const rn = (brain as any)._smartRoute({
        messages: [{ role: 'user', content: `turn ${turn}` }],
        sessionId: 'sess-fw',
      });
      expect(rn).toEqual({ model: pinnedModel, reason: 'cache-affinity', complexity: 0, kind: 'affinity' });
    }
  });

  // -------------------------------------------------------------------------
  // (d) no-sessionId calls never pin.
  // -------------------------------------------------------------------------
  it('ON: calls with no sessionId (RAG/judge/consciousness) never pin', async () => {
    process.env['SUDO_SESSION_CACHE_AFFINITY'] = '1';
    process.env['SUDO_CACHE_AFFINITY_PROVIDER'] = 'xai-oauth/grok-4-fast-non-reasoning';
    const { brain } = makeBrain([]);
    process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1';

    // _smartRoute with no sessionId ⇒ affinity branch skipped.
    const r = (brain as any)._smartRoute({ messages: [{ role: 'user', content: 'judge this' }] });
    expect(r?.kind).not.toBe('affinity');

    // A full call with no sessionId ⇒ no pin recorded.
    await brain.call({ messages: [{ role: 'user', content: 'judge this' }] });
    expect(affinityStoreSize()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (e) hard-fail doesn't repin.
  // -------------------------------------------------------------------------
  it('ON: a hard-fail on the pinned provider does NOT repin the session', async () => {
    process.env['SUDO_SESSION_CACHE_AFFINITY'] = '1';
    process.env['SUDO_CACHE_AFFINITY_PROVIDER'] = 'xai-oauth/grok-4-fast-non-reasoning';
    // _callSingleModel hard-fails for any non-PRIMARY id (i.e. the pinned grok),
    // so the turn falls through to the failover chain which answers as PRIMARY.
    const { brain } = makeBrain([], { failSingle: true });
    process.env['SUDO_BRAIN_CONSENSUS_DISABLE'] = '1';

    const res = await brain.call({
      messages: [{ role: 'user', content: 'turn 1 with a broken pin' }],
      sessionId: 'sess-hardfail',
    });
    // Failover produced the answer (PRIMARY), NOT the pinned grok.
    expect(res.model).toBe(PRIMARY);
    // But the pin is unchanged — a transient/permanent blip must not switch the
    // session's affinity target (first-writer-wins).
    expect(getSessionAffinity('sess-hardfail')?.model).toBe('xai-oauth/grok-4-fast-non-reasoning');
  });

  it('setSessionAffinity is first-writer-wins unless forced', () => {
    setSessionAffinity('s1', 'a/one', { now: 1000 });
    setSessionAffinity('s1', 'b/two', { now: 2000 });
    expect(getSessionAffinity('s1', 3000)?.model).toBe('a/one');
    setSessionAffinity('s1', 'c/three', { force: true, now: 4000 });
    expect(getSessionAffinity('s1', 5000)?.model).toBe('c/three');
    clearSessionAffinity('s1');
    expect(getSessionAffinity('s1', 6000)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (f) store eviction — bounded + TTL, injected clock.
  // -------------------------------------------------------------------------
  it('store evicts oldest entries beyond the cap', () => {
    process.env['SUDO_CACHE_AFFINITY_MAX_SESSIONS'] = '3';
    setSessionAffinity('e1', 'p/m', { now: 100 });
    setSessionAffinity('e2', 'p/m', { now: 200 });
    setSessionAffinity('e3', 'p/m', { now: 300 });
    expect(affinityStoreSize()).toBe(3);
    setSessionAffinity('e4', 'p/m', { now: 400 }); // over cap ⇒ evict oldest (e1)
    expect(affinityStoreSize()).toBe(3);
    expect(getSessionAffinity('e1', 400)).toBeNull();
    expect(getSessionAffinity('e4', 400)?.model).toBe('p/m');
  });

  it('store drops entries past the TTL (lazy on read)', () => {
    process.env['SUDO_CACHE_AFFINITY_TTL_MS'] = '1000';
    setSessionAffinity('t1', 'p/m', { now: 0 });
    expect(getSessionAffinity('t1', 500)?.model).toBe('p/m'); // within TTL
    expect(getSessionAffinity('t1', 2000)).toBeNull(); // expired
    expect(affinityStoreSize()).toBe(0); // dropped on the expired read
  });
});
