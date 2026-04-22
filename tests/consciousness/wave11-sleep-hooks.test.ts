/**
 * @file tests/consciousness/wave11-sleep-hooks.test.ts
 * @description Wave 11 Item 3: SkillDiscovery + AgentConfigEvolver hooks in SleepCycle.
 *
 * Tests:
 *   SKILL-SL-1  SleepCycle constructs with both new opts — no throw.
 *   SKILL-SL-2  SleepCycle constructs WITHOUT new opts — backward compatible.
 *   SKILL-SL-3  After startSleep(): skillDiscovery.mine called once with 86400000.
 *   SKILL-SL-4  After startSleep(): agentConfigEvolver.emit called with 'sleep-cycle-complete'.
 *   SKILL-SL-5  agentConfigEvolver.emit argument contains sessionId string.
 *   SKILL-SL-6  skillDiscovery.mine throws → sleep cycle still returns SleepSession (fail-open).
 *   SKILL-SL-7  agentConfigEvolver.emit throws → sleep cycle still returns SleepSession (fail-open).
 *   SKILL-SL-8  agentConfigEvolver.listenerCount returns 0 → emit is NOT called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockSaveSleepSession, mockWarnFn, mockInfoFn, mockDebugFn, mockErrorFn } = vi.hoisted(() => {
  return {
    mockSaveSleepSession: vi.fn(),
    mockWarnFn: vi.fn(),
    mockInfoFn: vi.fn(),
    mockDebugFn: vi.fn(),
    mockErrorFn: vi.fn(),
  };
});

vi.mock('../../src/core/consciousness/sleep-cycle/store.js', () => ({
  saveSleepSession: mockSaveSleepSession,
  getDreamJournal: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: mockInfoFn,
    warn: mockWarnFn,
    debug: mockDebugFn,
    error: mockErrorFn,
  }),
}));

vi.mock('../../src/core/consciousness/sleep-cycle/phases.js', () => ({
  runPhase1ExperienceReplay: vi.fn(),
  runPhase2PatternFinding: vi.fn().mockResolvedValue(undefined),
  runPhase3Counterfactuals: vi.fn().mockResolvedValue(undefined),
  runPhase4SelfUpdate: vi.fn().mockResolvedValue(undefined),
  runPhase5DreamGeneration: vi.fn().mockResolvedValue(undefined),
}));

import { SleepCycle } from '../../src/core/consciousness/sleep-cycle/consolidator.js';
import type { SleepSession } from '../../src/core/consciousness/sleep-cycle/types.js';

// ---------------------------------------------------------------------------
// Shared mock interfaces (duck-typed, matching consolidator's internal types)
// ---------------------------------------------------------------------------

interface SkillDiscoveryLike {
  mine(windowMs?: number): unknown[];
}

interface AgentConfigEvolverLike {
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeBaseOpts() {
  const stubDb = {} as import('better-sqlite3').Database;
  return {
    cdb: { getDb: () => stubDb } as unknown as import('../../src/core/consciousness/consciousness-db.js').ConsciousnessDB,
    brain: { call: vi.fn().mockResolvedValue({ content: 'dream text' }) } as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepBrainLike,
    episodicMemory: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepEpisodicLike,
    counterfactualEngine: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepCounterfactualLike,
    selfModel: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepSelfModelLike,
    temporalSelf: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepTemporalSelfLike,
    metacognition: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepMetacognitionLike,
    wisdomStore: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepWisdomLike,
  };
}

function makeDiscovery(returnVal: unknown[] = []): SkillDiscoveryLike {
  return { mine: vi.fn().mockReturnValue(returnVal) };
}

function makeEvolver(listenerCountVal = 1): AgentConfigEvolverLike {
  return {
    emit: vi.fn().mockReturnValue(true),
    listenerCount: vi.fn().mockReturnValue(listenerCountVal),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SleepCycle SkillDiscovery + AgentConfigEvolver hooks (Wave 11)', () => {
  beforeEach(() => {
    mockSaveSleepSession.mockClear();
    mockWarnFn.mockClear();
    mockInfoFn.mockClear();
    mockDebugFn.mockClear();
    mockErrorFn.mockClear();
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-1: Construct with both new opts — no throw
  // -------------------------------------------------------------------------
  it('SKILL-SL-1: constructs SleepCycle with skillDiscovery and agentConfigEvolver without throwing', () => {
    const discovery = makeDiscovery();
    const evolver = makeEvolver();

    expect(() => {
      new SleepCycle({
        ...makeBaseOpts(),
        skillDiscovery: discovery,
        agentConfigEvolver: evolver,
      });
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-2: Backward compatible — construct without new opts
  // -------------------------------------------------------------------------
  it('SKILL-SL-2: constructs SleepCycle without new opts (backward compatible)', () => {
    expect(() => {
      new SleepCycle(makeBaseOpts());
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-3: mine() called once with 86400000 (24h window)
  // -------------------------------------------------------------------------
  it('SKILL-SL-3: calls skillDiscovery.mine once with windowMs=86400000 after startSleep', async () => {
    const discovery = makeDiscovery([{ id: 'p1', toolSequence: ['a', 'b'] }]);
    const cycle = new SleepCycle({
      ...makeBaseOpts(),
      skillDiscovery: discovery,
    });

    await cycle.startSleep();

    expect(discovery.mine).toHaveBeenCalledOnce();
    expect(discovery.mine).toHaveBeenCalledWith(24 * 60 * 60 * 1000);
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-4: agentConfigEvolver.emit called with 'sleep-cycle-complete'
  // -------------------------------------------------------------------------
  it('SKILL-SL-4: calls agentConfigEvolver.emit with sleep-cycle-complete after startSleep', async () => {
    const evolver = makeEvolver(1);
    const cycle = new SleepCycle({
      ...makeBaseOpts(),
      agentConfigEvolver: evolver,
    });

    await cycle.startSleep();

    expect(evolver.emit).toHaveBeenCalledOnce();
    const [event] = (evolver.emit as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    expect(event).toBe('sleep-cycle-complete');
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-5: emit argument contains sessionId string
  // -------------------------------------------------------------------------
  it('SKILL-SL-5: emit is called with an object containing a sessionId string', async () => {
    const evolver = makeEvolver(1);
    const cycle = new SleepCycle({
      ...makeBaseOpts(),
      agentConfigEvolver: evolver,
    });

    await cycle.startSleep();

    const calls = (evolver.emit as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>;
    expect(calls).toHaveLength(1);
    const payload = calls[0][1] as Record<string, unknown>;
    expect(typeof payload.sessionId).toBe('string');
    expect(payload.sessionId).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-6: mine() throws → sleep cycle still returns SleepSession (fail-open)
  // -------------------------------------------------------------------------
  it('SKILL-SL-6: swallows errors thrown by skillDiscovery.mine and returns a valid SleepSession', async () => {
    const throwingDiscovery: SkillDiscoveryLike = {
      mine: vi.fn().mockImplementation(() => { throw new Error('DB failure in skill discovery'); }),
    };
    const cycle = new SleepCycle({
      ...makeBaseOpts(),
      skillDiscovery: throwingDiscovery,
    });

    const session: SleepSession = await cycle.startSleep();

    // Session must be returned despite the failure
    expect(session).toBeDefined();
    expect(typeof session.id).toBe('string');

    // warn must be logged (fail-open convention)
    expect(mockWarnFn).toHaveBeenCalled();
    const warnCalls = mockWarnFn.mock.calls as Array<[unknown, string]>;
    const skillWarn = warnCalls.find(c =>
      typeof c[1] === 'string' && c[1].includes('SkillDiscovery.mine threw'),
    );
    expect(skillWarn).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-7: emit() throws → sleep cycle still returns SleepSession (fail-open)
  // -------------------------------------------------------------------------
  it('SKILL-SL-7: swallows errors thrown by agentConfigEvolver.emit and returns a valid SleepSession', async () => {
    const throwingEvolver: AgentConfigEvolverLike = {
      emit: vi.fn().mockImplementation(() => { throw new Error('evolver emit failure'); }),
      listenerCount: vi.fn().mockReturnValue(1),
    };
    const cycle = new SleepCycle({
      ...makeBaseOpts(),
      agentConfigEvolver: throwingEvolver,
    });

    const session: SleepSession = await cycle.startSleep();

    expect(session).toBeDefined();
    expect(typeof session.id).toBe('string');

    const warnCalls = mockWarnFn.mock.calls as Array<[unknown, string]>;
    const evolverWarn = warnCalls.find(c =>
      typeof c[1] === 'string' && c[1].includes('AgentConfigEvolver emit threw'),
    );
    expect(evolverWarn).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // SKILL-SL-8: listenerCount returns 0 → emit NOT called
  // -------------------------------------------------------------------------
  it('SKILL-SL-8: does NOT call emit when listenerCount returns 0', async () => {
    const evolver = makeEvolver(0); // no listeners
    const cycle = new SleepCycle({
      ...makeBaseOpts(),
      agentConfigEvolver: evolver,
    });

    await cycle.startSleep();

    expect(evolver.listenerCount).toHaveBeenCalledWith('sleep-cycle-complete');
    expect(evolver.emit).not.toHaveBeenCalled();
  });
});
