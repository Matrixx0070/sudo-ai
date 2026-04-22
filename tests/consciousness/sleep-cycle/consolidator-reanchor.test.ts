/**
 * @file tests/consciousness/sleep-cycle/consolidator-reanchor.test.ts
 * @description Wave 6P: ReAnchorMonitor integration in SleepCycle.
 *
 * Tests:
 *   REANCHOR-SL-1  getStats() called with correct opts; summary attached to session.
 *   REANCHOR-SL-2  reanchor undefined when reanchorMonitor is absent.
 *   REANCHOR-SL-3  Fail-open: getStats() throw swallowed; reanchor stays undefined.
 *   REANCHOR-SL-4  Warn log emitted when running on a degraded cycle.
 *   REANCHOR-SL-5  lastReAnchorAt only set when stats include it.
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

vi.mock('../../../src/core/consciousness/sleep-cycle/store.js', () => ({
  saveSleepSession: mockSaveSleepSession,
  getDreamJournal: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: mockInfoFn,
    warn: mockWarnFn,
    debug: mockDebugFn,
    error: mockErrorFn,
  }),
}));

vi.mock('../../../src/core/consciousness/sleep-cycle/phases.js', () => ({
  runPhase1ExperienceReplay: vi.fn(),
  runPhase2PatternFinding: vi.fn().mockResolvedValue(undefined),
  runPhase3Counterfactuals: vi.fn().mockResolvedValue(undefined),
  runPhase4SelfUpdate: vi.fn().mockResolvedValue(undefined),
  runPhase5DreamGeneration: vi.fn().mockResolvedValue(undefined),
}));

import { SleepCycle } from '../../../src/core/consciousness/sleep-cycle/consolidator.js';
import type { SleepSession } from '../../../src/core/consciousness/sleep-cycle/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ReAnchorStatsMock {
  total: number;
  byTrigger: Record<string, number>;
  windowDays: number;
  computedAt: string;
  lastReAnchorAt?: number;
}

interface ReAnchorMonitorLike {
  getStats(opts?: { windowDays?: number }): ReAnchorStatsMock;
}

function makeStats(opts: {
  total?: number;
  byTrigger?: Record<string, number>;
  lastReAnchorAt?: number;
} = {}): ReAnchorStatsMock {
  const result: ReAnchorStatsMock = {
    total: opts.total ?? 3,
    byTrigger: opts.byTrigger ?? { 'explicit': 1, 'post-veto': 2 },
    windowDays: 30,
    computedAt: new Date().toISOString(),
  };
  if (opts.lastReAnchorAt !== undefined) {
    result.lastReAnchorAt = opts.lastReAnchorAt;
  }
  return result;
}

function makeStubSleepCycle(
  reanchorMonitor?: ReAnchorMonitorLike,
  forceDegraded = false,
): SleepCycle {
  const stubDb = {} as import('better-sqlite3').Database;
  const cycle = new SleepCycle({
    cdb: { getDb: () => stubDb } as unknown as import('../../../src/core/consciousness/consciousness-db.js').ConsciousnessDB,
    brain: { call: vi.fn().mockResolvedValue({ content: 'dream text' }) } as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepBrainLike,
    episodicMemory: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepEpisodicLike,
    counterfactualEngine: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepCounterfactualLike,
    selfModel: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepSelfModelLike,
    temporalSelf: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepTemporalSelfLike,
    metacognition: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepMetacognitionLike,
    wisdomStore: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepWisdomLike,
    reanchorMonitor,
  });
  if (forceDegraded) {
    (cycle as unknown as { _degraded: boolean })._degraded = true;
  }
  return cycle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SleepCycle ReAnchorMonitor hooks (6P)', () => {
  beforeEach(() => {
    mockSaveSleepSession.mockClear();
    mockWarnFn.mockClear();
    mockErrorFn.mockClear();
    mockInfoFn.mockClear();
    mockDebugFn.mockClear();
  });

  // -------------------------------------------------------------------------
  // REANCHOR-SL-1: getStats() called with correct opts; summary attached
  // -------------------------------------------------------------------------
  it('REANCHOR-SL-1: calls getStats with windowDays:30 and attaches reanchor summary to session', async () => {
    const lastTs = Date.now() - 1000;
    const stats = makeStats({ total: 3, byTrigger: { explicit: 1, 'post-veto': 2 }, lastReAnchorAt: lastTs });
    const monitor: ReAnchorMonitorLike = {
      getStats: vi.fn().mockReturnValue(stats),
    };

    const cycle = makeStubSleepCycle(monitor);
    const session: SleepSession = await cycle.startSleep();

    expect(monitor.getStats).toHaveBeenCalledOnce();
    expect(monitor.getStats).toHaveBeenCalledWith({ windowDays: 30 });

    expect(session.reanchor).toBeDefined();
    expect(session.reanchor?.total).toBe(3);
    expect(session.reanchor?.byTrigger).toEqual({ explicit: 1, 'post-veto': 2 });
    expect(session.reanchor?.lastReAnchorAt).toBe(lastTs);
    expect(typeof session.reanchor?.analyzedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // REANCHOR-SL-2: reanchor undefined when dep absent
  // -------------------------------------------------------------------------
  it('REANCHOR-SL-2: does not attach reanchor when reanchorMonitor is not provided', async () => {
    const cycle = makeStubSleepCycle(/* no monitor */);
    const session: SleepSession = await cycle.startSleep();

    expect(session.reanchor).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // REANCHOR-SL-3: Fail-open: getStats() throw swallowed
  // -------------------------------------------------------------------------
  it('REANCHOR-SL-3: swallows errors thrown by getStats() and leaves reanchor undefined', async () => {
    const throwingMonitor: ReAnchorMonitorLike = {
      getStats: () => { throw new Error('DB failure in reanchor monitor'); },
    };

    const cycle = makeStubSleepCycle(throwingMonitor);

    // Should not throw despite reanchor failure
    await expect(cycle.startSleep()).resolves.not.toThrow();

    const session: SleepSession = await cycle.startSleep();
    expect(session.reanchor).toBeUndefined();

    // warn (not error) should be logged per fail-open convention
    expect(mockWarnFn).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // REANCHOR-SL-4: Warn log on degraded cycle
  // -------------------------------------------------------------------------
  it('REANCHOR-SL-4: logs a warn when running on a degraded cycle', async () => {
    const stats = makeStats({ total: 1 });
    const monitor: ReAnchorMonitorLike = {
      getStats: vi.fn().mockReturnValue(stats),
    };

    const cycle = makeStubSleepCycle(monitor, /* forceDegraded */ true);
    await cycle.startSleep();

    const warnCalls = mockWarnFn.mock.calls as Array<[unknown, string]>;
    const degradedWarn = warnCalls.find(c =>
      typeof c[1] === 'string' && c[1].includes('Re-anchor analysis ran on degraded cycle'),
    );
    expect(degradedWarn).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // REANCHOR-SL-5: lastReAnchorAt only set when stats include it
  // -------------------------------------------------------------------------
  it('REANCHOR-SL-5: lastReAnchorAt omitted from summary when stats.lastReAnchorAt is undefined', async () => {
    const stats = makeStats({ total: 0, byTrigger: {} /* no lastReAnchorAt */ });
    const monitor: ReAnchorMonitorLike = {
      getStats: vi.fn().mockReturnValue(stats),
    };

    const cycle = makeStubSleepCycle(monitor);
    const session: SleepSession = await cycle.startSleep();

    expect(session.reanchor).toBeDefined();
    expect(session.reanchor?.lastReAnchorAt).toBeUndefined();
    expect(session.reanchor?.total).toBe(0);
  });
});
