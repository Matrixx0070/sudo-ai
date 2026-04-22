/**
 * @file tests/consciousness/sleep-cycle/consolidator-pattern-analysis.test.ts
 * @description Wave 6K: MistakePatternRecognizer integration in SleepCycle.
 *
 * Tests:
 *   1. analyze() is called with correct opts post-Phase-5; summary attached to session.
 *   2. patternAnalysis is undefined when recognizer is absent.
 *   3. Fail-open: analyze() throw is swallowed; patternAnalysis stays undefined.
 *   4. Warn log emitted when running on a degraded cycle.
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

interface MistakePatternRecognizerLike {
  analyze(opts?: { windowDays?: number; minOccurrences?: number }): {
    totalMistakes: number;
    uniquePatterns: number;
    recurringPatterns: { length: number };
    analyzedAt: string;
  };
}

function makeStubSleepCycle(
  recognizer?: MistakePatternRecognizerLike,
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
    mistakePatternRecognizer: recognizer,
  });
  // Force degraded state to test DEGRADED cycle behaviour
  if (forceDegraded) {
    // Trigger degraded by calling _runIntegrityCheck indirectly — we use the
    // public clearDegraded as sentinel, but to set it we need a failed run first.
    // Instead, bypass by patching the private field via casting.
    (cycle as unknown as { _degraded: boolean })._degraded = true;
  }
  return cycle;
}

function makeAnalyzeResult(
  totalMistakes = 5,
  uniquePatterns = 3,
  recurringCount = 2,
): ReturnType<MistakePatternRecognizerLike['analyze']> {
  return {
    totalMistakes,
    uniquePatterns,
    recurringPatterns: { length: recurringCount },
    analyzedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SleepCycle MistakePatternRecognizer hooks (6K)', () => {
  beforeEach(() => {
    mockSaveSleepSession.mockClear();
    mockWarnFn.mockClear();
    mockErrorFn.mockClear();
    mockInfoFn.mockClear();
    mockDebugFn.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. analyze() called, summary attached
  // -------------------------------------------------------------------------
  it('calls analyze with correct opts and attaches summary to session', async () => {
    const analyzeResult = makeAnalyzeResult(7, 4, 3);
    const mockRecognizer: MistakePatternRecognizerLike = {
      analyze: vi.fn().mockReturnValue(analyzeResult),
    };

    const cycle = makeStubSleepCycle(mockRecognizer);
    const session: SleepSession = await cycle.startSleep();

    // analyze called once with correct opts
    expect(mockRecognizer.analyze).toHaveBeenCalledOnce();
    expect(mockRecognizer.analyze).toHaveBeenCalledWith({ windowDays: 30, minOccurrences: 2 });

    // patternAnalysis summary attached to session
    expect(session.patternAnalysis).toBeDefined();
    expect(session.patternAnalysis?.totalMistakes).toBe(7);
    expect(session.patternAnalysis?.uniquePatterns).toBe(4);
    expect(session.patternAnalysis?.recurringCount).toBe(3);
    expect(typeof session.patternAnalysis?.analyzedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 2. patternAnalysis undefined when recognizer absent
  // -------------------------------------------------------------------------
  it('does not attach patternAnalysis when recognizer is not provided', async () => {
    const cycle = makeStubSleepCycle(/* no recognizer */);
    const session: SleepSession = await cycle.startSleep();

    expect(session.patternAnalysis).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. Fail-open: analyze() throw is swallowed
  // -------------------------------------------------------------------------
  it('swallows errors thrown by analyze() and leaves patternAnalysis undefined', async () => {
    const throwingRecognizer: MistakePatternRecognizerLike = {
      analyze: () => { throw new Error('DB error from pattern recognizer'); },
    };

    const cycle = makeStubSleepCycle(throwingRecognizer);

    // Should not throw despite recognizer failure
    await expect(cycle.startSleep()).resolves.not.toThrow();

    const session: SleepSession = await cycle.startSleep();
    expect(session.patternAnalysis).toBeUndefined();

    // error should be logged
    expect(mockErrorFn).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Warn log on degraded cycle
  // -------------------------------------------------------------------------
  it('logs a warn when running on a degraded cycle', async () => {
    const analyzeResult = makeAnalyzeResult(2, 1, 1);
    const mockRecognizer: MistakePatternRecognizerLike = {
      analyze: vi.fn().mockReturnValue(analyzeResult),
    };

    const cycle = makeStubSleepCycle(mockRecognizer, /* forceDegraded */ true);
    await cycle.startSleep();

    // Warn about degraded-cycle pattern analysis
    const warnCalls = mockWarnFn.mock.calls as Array<[unknown, string]>;
    const degradedWarn = warnCalls.find(c =>
      typeof c[1] === 'string' && c[1].includes('Pattern analysis ran on degraded cycle'),
    );
    expect(degradedWarn).toBeDefined();
  });
});
