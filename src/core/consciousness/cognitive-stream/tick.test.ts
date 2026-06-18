/**
 * @file tick.test.ts
 * @description Tests for the CognitiveStream tick logic, focused on the
 * differential gate cost lever.
 *
 * Coverage:
 * - computeStateSignature: stable across own-output / body-float drift,
 *   sensitive to concept + emotion changes.
 * - executeTick gate: skips the brain call when external state is unchanged,
 *   fires when it changes, forces a heartbeat after the skip ceiling.
 * - medium/deep tiers are never gated.
 * - SUDO_CONSCIOUSNESS_GATE=0 disables the gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Neutralize DB persistence — saveThought touches the consciousness DB.
vi.mock('./store.js', () => ({ saveThought: vi.fn() }));

import { computeStateSignature, executeTick, type GateState, type TickContext } from './tick.js';
import type { ThoughtConfig, ThoughtContext, StreamThought } from './types.js';
import type { BodyState, EmotionalValence } from '../types.js';

const CONFIG: ThoughtConfig = {
  microIntervalMs: 60_000,
  mediumEveryN: 10,
  deepEveryN: 120,
  microModel: '',
  mediumModel: '',
  deepModel: '',
  maxMicroTokens: 80,
  maxMediumTokens: 300,
  maxDeepTokens: 1_500,
};

function bodyState(energy = 0.5): BodyState {
  return { energy, clarity: 0.5, fullness: 0.5, connectivity: 0.5, continuity: 0.5, sampledAt: '2026-01-01T00:00:00.000Z' };
}

function valence(dominantEmotion: EmotionalValence['dominantEmotion'] = 'joy', intensity = 0.3): EmotionalValence {
  return { tags: [dominantEmotion], dominantEmotion, intensity };
}

function thoughtContext(over: Partial<ThoughtContext> = {}): ThoughtContext {
  return {
    tier: 'micro',
    bodyState: bodyState(),
    activeConcepts: ['alpha', 'beta'],
    emotionalState: valence(),
    recentThoughts: [],
    ...over,
  };
}

/** Build a TickContext whose mock deps return fixed (gate-stable) state. */
function tickCtx(opts: {
  tickCount: number;
  gate: GateState;
  concepts?: string[];
  emotion?: EmotionalValence;
  energy?: number;
  brainCall: ReturnType<typeof vi.fn>;
}): TickContext {
  const { tickCount, gate, concepts = ['alpha', 'beta'], emotion = valence(), energy = 0.5, brainCall } = opts;
  return {
    tickCount,
    cache: [],
    cdb: {} as unknown as TickContext['cdb'],
    brain: { call: brainCall } as unknown as TickContext['brain'],
    embodied: { getState: () => bodyState(energy) },
    spreading: {
      activate: vi.fn(),
      getTopActive: (n: number) => concepts.slice(0, n).map((id) => ({ id, activation: 1 })),
    },
    emotional: { getCurrentState: () => emotion, updateFromThought: vi.fn() as never },
    config: CONFIG,
    currentThought: null,
    gate,
  };
}

function makeBrain(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ content: 'a fresh thought\nCONCEPTS: alpha,beta' }));
}

describe('computeStateSignature', () => {
  it('is stable for identical concepts + emotion', () => {
    expect(computeStateSignature(thoughtContext())).toBe(computeStateSignature(thoughtContext()));
  });

  it('ignores the stream\'s own recentThoughts', () => {
    const a = computeStateSignature(thoughtContext({ recentThoughts: [] }));
    const b = computeStateSignature(
      thoughtContext({ recentThoughts: [{ content: 'x' } as unknown as StreamThought] }),
    );
    expect(a).toBe(b);
  });

  it('ignores body-energy drift', () => {
    const a = computeStateSignature(thoughtContext({ bodyState: bodyState(0.1) }));
    const b = computeStateSignature(thoughtContext({ bodyState: bodyState(0.9) }));
    expect(a).toBe(b);
  });

  it('changes when active concepts change', () => {
    const a = computeStateSignature(thoughtContext({ activeConcepts: ['alpha'] }));
    const b = computeStateSignature(thoughtContext({ activeConcepts: ['gamma'] }));
    expect(a).not.toBe(b);
  });

  it('changes when the dominant emotion changes', () => {
    const a = computeStateSignature(thoughtContext({ emotionalState: valence('joy') }));
    const b = computeStateSignature(thoughtContext({ emotionalState: valence('frustration') }));
    expect(a).not.toBe(b);
  });

  it('buckets intensity to one decimal (tiny drift does not count)', () => {
    const a = computeStateSignature(thoughtContext({ emotionalState: valence('joy', 0.31) }));
    const b = computeStateSignature(thoughtContext({ emotionalState: valence('joy', 0.34) }));
    expect(a).toBe(b);
  });
});

describe('executeTick differential gate', () => {
  let gate: GateState;
  const OLD_ENV = process.env['SUDO_CONSCIOUSNESS_GATE'];

  beforeEach(() => {
    gate = { lastSignature: null, skipStreak: 0 };
    delete process.env['SUDO_CONSCIOUSNESS_GATE'];
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env['SUDO_CONSCIOUSNESS_GATE'];
    else process.env['SUDO_CONSCIOUSNESS_GATE'] = OLD_ENV;
  });

  it('fires the first micro tick, then skips while state is unchanged', async () => {
    const brain = makeBrain();

    const first = await executeTick(tickCtx({ tickCount: 1, gate, brainCall: brain }));
    expect(first).not.toBeNull();
    expect(brain).toHaveBeenCalledTimes(1);

    const second = await executeTick(tickCtx({ tickCount: 2, gate, brainCall: brain }));
    expect(second).toBeNull();
    expect(brain).toHaveBeenCalledTimes(1); // no new call
    expect(gate.skipStreak).toBe(1);
  });

  it('fires again when active concepts change', async () => {
    const brain = makeBrain();
    await executeTick(tickCtx({ tickCount: 1, gate, concepts: ['alpha'], brainCall: brain }));
    expect(brain).toHaveBeenCalledTimes(1);

    const changed = await executeTick(tickCtx({ tickCount: 2, gate, concepts: ['omega'], brainCall: brain }));
    expect(changed).not.toBeNull();
    expect(brain).toHaveBeenCalledTimes(2);
    expect(gate.skipStreak).toBe(0);
  });

  it('forces a heartbeat tick after the skip ceiling', async () => {
    const brain = makeBrain();
    // tickCount 3 is a micro tier (3 % 10 !== 0, 3 % 120 !== 0); the gate keys
    // off tier, not the tick number, so a fixed micro tick exercises it cleanly.
    const MICRO_TICK = 3;
    await executeTick(tickCtx({ tickCount: MICRO_TICK, gate, brainCall: brain })); // fires
    expect(brain).toHaveBeenCalledTimes(1);

    // Drive 20 unchanged skips, then the next unchanged tick is forced through.
    while (gate.skipStreak < 20) {
      const r = await executeTick(tickCtx({ tickCount: MICRO_TICK, gate, brainCall: brain }));
      expect(r).toBeNull();
    }
    expect(brain).toHaveBeenCalledTimes(1);

    const forced = await executeTick(tickCtx({ tickCount: MICRO_TICK, gate, brainCall: brain }));
    expect(forced).not.toBeNull();
    expect(brain).toHaveBeenCalledTimes(2);
    expect(gate.skipStreak).toBe(0);
  });

  it('never gates medium ticks (tickCount % mediumEveryN === 0)', async () => {
    const brain = makeBrain();
    await executeTick(tickCtx({ tickCount: 1, gate, brainCall: brain })); // micro fires, sets signature
    expect(brain).toHaveBeenCalledTimes(1);

    // tick 10 → medium tier; identical external state, but medium is exempt.
    const medium = await executeTick(tickCtx({ tickCount: 10, gate, brainCall: brain }));
    expect(medium).not.toBeNull();
    expect(brain).toHaveBeenCalledTimes(2);
  });

  it('disables the gate when SUDO_CONSCIOUSNESS_GATE=0', async () => {
    process.env['SUDO_CONSCIOUSNESS_GATE'] = '0';
    const brain = makeBrain();
    await executeTick(tickCtx({ tickCount: 1, gate, brainCall: brain }));
    const second = await executeTick(tickCtx({ tickCount: 2, gate, brainCall: brain }));
    expect(second).not.toBeNull(); // unchanged state still fires
    expect(brain).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no gate is provided (back-compat)', async () => {
    const brain = makeBrain();
    const ctx = tickCtx({ tickCount: 2, gate, brainCall: brain });
    delete (ctx as { gate?: GateState }).gate;
    const r = await executeTick(ctx);
    expect(r).not.toBeNull();
    expect(brain).toHaveBeenCalledTimes(1);
  });
});
