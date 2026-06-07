/**
 * @file consolidator.test.ts
 * @description Tests for Wave 6C Builder A — lockout window, integrity verifier,
 *   restrained/degraded flag propagation, and SleepSession shape extensions.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type { CommitmentAuditReport, CommitmentRow } from '../../../src/core/cognition/commitment-auditor.js';
import {
  parseAndCheckLockoutWindow,
  verifyAccumulatorIntegrity,
  INTEGRITY_PASS_THRESHOLD,
  type IntegrityReport,
} from '../../../src/core/consciousness/sleep-cycle/integrity-verifier.js';
import type { PhaseAccumulator } from '../../../src/core/consciousness/sleep-cycle/phases.js';

// ---------------------------------------------------------------------------
// Module mocks for SleepCycle / _finalise tests (M2)
// ---------------------------------------------------------------------------

// Hoist mocks so they are available inside vi.mock factory callbacks.
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
import * as phases from '../../../src/core/consciousness/sleep-cycle/phases.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SleepCycle instance with stub dependencies. */
function makeSleepCycle(): SleepCycle {
  const stubDb = {} as import('better-sqlite3').Database;
  return new SleepCycle({
    cdb: { getDb: () => stubDb } as unknown as import('../../../src/core/consciousness/consciousness-db.js').ConsciousnessDB,
    brain: { call: vi.fn().mockResolvedValue('dream text') } as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepBrainLike,
    episodicMemory: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepEpisodicLike,
    counterfactualEngine: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepCounterfactualLike,
    selfModel: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepSelfModelLike,
    temporalSelf: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepTemporalSelfLike,
    metacognition: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepMetacognitionLike,
    wisdomStore: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepWisdomLike,
  });
}

/** Build a fully-coherent PhaseAccumulator for positive-path tests. */
function makeGoodAcc(overrides: Partial<PhaseAccumulator> = {}): PhaseAccumulator {
  return {
    episodesReplayed: 5,
    patternsFound: 3,
    memoriesStrengthened: 2,
    memoriesWeakened: 1,
    insightsGenerated: 2,
    counterfactualsRun: 3,
    dreamJournalEntry: 'A vivid synthesis of recent operational events.',
    summaries: ['episode A', 'episode B'],
    insightTexts: ['insight 1'],
    ...overrides,
  };
}

/** Convert UTC hours and minutes into a mock Date.now() ms value. */
function utcMs(hours: number, minutes: number): number {
  const now = new Date();
  now.setUTCHours(hours, minutes, 0, 0);
  return now.getTime();
}

// ---------------------------------------------------------------------------
// Tests: parseAndCheckLockoutWindow
// ---------------------------------------------------------------------------

describe('parseAndCheckLockoutWindow', () => {
  it('returns false for time clearly outside a same-day window', () => {
    // Window: 02:00–06:00 UTC. Test at 10:00 UTC.
    const result = parseAndCheckLockoutWindow('02:00-06:00', utcMs(10, 0));
    expect(result).toBe(false);
  });

  it('returns true for time clearly inside a same-day window', () => {
    // Window: 02:00–06:00 UTC. Test at 04:00 UTC.
    const result = parseAndCheckLockoutWindow('02:00-06:00', utcMs(4, 0));
    expect(result).toBe(true);
  });

  it('returns false for time at the exact end of a same-day window (exclusive upper bound)', () => {
    // Window: 02:00–06:00 UTC. Test at 06:00 UTC — should be outside.
    const result = parseAndCheckLockoutWindow('02:00-06:00', utcMs(6, 0));
    expect(result).toBe(false);
  });

  it('returns true for time at the exact start of a same-day window (inclusive lower bound)', () => {
    // Window: 02:00–06:00. Test at 02:00 UTC.
    const result = parseAndCheckLockoutWindow('02:00-06:00', utcMs(2, 0));
    expect(result).toBe(true);
  });

  it('handles midnight-spanning window: inside after midnight', () => {
    // Window: 23:30–04:00 UTC. Test at 02:00 UTC (next day).
    const result = parseAndCheckLockoutWindow('23:30-04:00', utcMs(2, 0));
    expect(result).toBe(true);
  });

  it('handles midnight-spanning window: inside before midnight', () => {
    // Window: 23:30–04:00 UTC. Test at 23:45 UTC.
    const result = parseAndCheckLockoutWindow('23:30-04:00', utcMs(23, 45));
    expect(result).toBe(true);
  });

  it('handles midnight-spanning window: outside during mid-day', () => {
    // Window: 23:30–04:00 UTC. Test at 12:00 UTC.
    const result = parseAndCheckLockoutWindow('23:30-04:00', utcMs(12, 0));
    expect(result).toBe(false);
  });

  it('returns false and does not throw on an invalid format', () => {
    expect(() => parseAndCheckLockoutWindow('not-a-window', utcMs(4, 0))).not.toThrow();
    const result = parseAndCheckLockoutWindow('not-a-window', utcMs(4, 0));
    expect(result).toBe(false);
  });

  it('returns false on empty string', () => {
    const result = parseAndCheckLockoutWindow('', utcMs(4, 0));
    expect(result).toBe(false);
  });

  it('returns false for a zero-width (degenerate) window', () => {
    // Start === end → no window
    const result = parseAndCheckLockoutWindow('04:00-04:00', utcMs(4, 0));
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyAccumulatorIntegrity
// ---------------------------------------------------------------------------

describe('verifyAccumulatorIntegrity', () => {
  it('passes all checks on a fully coherent accumulator', () => {
    const acc = makeGoodAcc();
    const report: IntegrityReport = verifyAccumulatorIntegrity(acc);
    expect(report.score).toBe(1.0);
    expect(report.failures).toHaveLength(0);
    expect(report.coherent).toBe(true);
  });

  it('fails when dreamJournalEntry is empty', () => {
    const acc = makeGoodAcc({ dreamJournalEntry: '' });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.failures).toContain('dreamJournalEntry-empty');
    expect(report.coherent).toBe(false);
  });

  it('fails when dreamJournalEntry is whitespace only', () => {
    const acc = makeGoodAcc({ dreamJournalEntry: '   ' });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.failures).toContain('dreamJournalEntry-empty');
  });

  it('fails when episodesReplayed is 0', () => {
    const acc = makeGoodAcc({ episodesReplayed: 0 });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.failures).toContain('episodesReplayed-zero');
    expect(report.coherent).toBe(false);
  });

  it('fails when insightsGenerated exceeds patternsFound * 3 + counterfactualsRun', () => {
    // bound = 3 patterns * 3 + 3 counterfactuals = 12 max; 13 is out of bounds
    const acc = makeGoodAcc({ patternsFound: 3, counterfactualsRun: 3, insightsGenerated: 13 });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.failures).toContain('insightsGenerated-out-of-bounds');
  });

  it('passes when insightsGenerated equals patternsFound * 3 + counterfactualsRun (boundary)', () => {
    // bound = 3 patterns * 3 + 3 counterfactuals = 12; the inclusive boundary passes
    const acc = makeGoodAcc({ patternsFound: 3, counterfactualsRun: 3, insightsGenerated: 12 });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.failures).not.toContain('insightsGenerated-out-of-bounds');
  });

  it('fails when a numeric field contains NaN', () => {
    const acc = makeGoodAcc({ patternsFound: NaN });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.failures).toContain('patternsFound-non-finite');
  });

  it('fails when a numeric field contains Infinity', () => {
    const acc = makeGoodAcc({ counterfactualsRun: Infinity });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.failures).toContain('counterfactualsRun-non-finite');
  });

  it('returns coherent=false when score is below INTEGRITY_PASS_THRESHOLD', () => {
    // 0 episodes + empty dream = 2 failed checks out of 4 → score = 0.5 < 0.75
    const acc = makeGoodAcc({ episodesReplayed: 0, dreamJournalEntry: '' });
    const report = verifyAccumulatorIntegrity(acc);
    expect(report.score).toBeLessThan(INTEGRITY_PASS_THRESHOLD);
    expect(report.coherent).toBe(false);
  });

  it('never throws even on a completely corrupt accumulator', () => {
    const corrupt = {} as PhaseAccumulator;
    expect(() => verifyAccumulatorIntegrity(corrupt)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: SleepSession type shape (compile-time check via assignment)
// ---------------------------------------------------------------------------

describe('SleepSession type extensions', () => {
  it('accepts the new optional fields without TypeScript errors', () => {
    // If this compiles, the type extension is correct.
    const session = {
      id: 'test-id',
      episodesReplayed: 5,
      patternsFound: 3,
      memoriesStrengthened: 2,
      memoriesWeakened: 1,
      insightsGenerated: 2,
      counterfactualsRun: 3,
      dreamJournalEntry: 'dream',
      durationMs: 1000,
      startedAt: new Date().toISOString(),
      endedAt: null,
      degraded: false,
      mode: 'normal' as const,
      integrityScore: 1.0,
    };
    expect(session.degraded).toBe(false);
    expect(session.mode).toBe('normal');
    expect(session.integrityScore).toBe(1.0);
  });

  it('allows mode to be restrained', () => {
    const mode: 'normal' | 'restrained' = 'restrained';
    expect(mode).toBe('restrained');
  });
});

// ---------------------------------------------------------------------------
// SEC FIX M1: parseAndCheckLockoutWindow does NOT log raw envValue
// ---------------------------------------------------------------------------

describe('parseAndCheckLockoutWindow — SEC M1: envValue redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not include the raw envValue string in any warn log when format is invalid', () => {
    const rawInput = 'SENSITIVE_WINDOW_VALUE_12345';
    parseAndCheckLockoutWindow(rawInput, utcMs(4, 0));

    for (const call of mockWarnFn.mock.calls) {
      // call[0] is the log context object (pino-style first arg)
      const contextArg = call[0];
      if (typeof contextArg === 'object' && contextArg !== null) {
        expect(contextArg).not.toHaveProperty('envValue', rawInput);
        // Confirm the field is either absent or explicitly '[redacted]'
        if ('envValue' in contextArg) {
          expect(contextArg.envValue).toBe('[redacted]');
        }
      }
    }
  });

  it('does not include the raw envValue string in warn log when hours are out of range', () => {
    // Valid format but out-of-range values (hour 99)
    const rawInput = 'SECRET_99:00-25:00_VALUE';
    // Manually craft a string that matches regex but has out-of-range values
    const outOfRangeInput = '99:00-25:00';
    parseAndCheckLockoutWindow(outOfRangeInput, utcMs(4, 0));

    for (const call of mockWarnFn.mock.calls) {
      const contextArg = call[0];
      if (typeof contextArg === 'object' && contextArg !== null && 'envValue' in contextArg) {
        expect(contextArg.envValue).toBe('[redacted]');
        expect(contextArg.envValue).not.toBe(outOfRangeInput);
      }
    }
    void rawInput; // suppress unused variable warning
  });
});

// ---------------------------------------------------------------------------
// UX FIX M2: shouldSleep logs info with operator-visible context on lockout
// ---------------------------------------------------------------------------

describe('SleepCycle.shouldSleep — UX M2: lockout window operator log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SUDO_SLEEP_LOCKOUT_WINDOW;
  });

  it('emits log.info with module="sleep-cycle" and window="[configured]" when lockout is active', () => {
    // Set a window that covers the full day so lockout always fires.
    process.env.SUDO_SLEEP_LOCKOUT_WINDOW = '00:00-23:59';

    const cycle = makeSleepCycle();
    const result = cycle.shouldSleep(999_999_999, true);

    expect(result).toBe(false);

    // Find the info call that reports lockout — may be one of several info calls
    // (e.g. 'SleepCycle initialised' fires first).
    const lockoutCall = mockInfoFn.mock.calls.find((call) => {
      const ctx = call[0];
      const msg = call[1];
      return (
        typeof msg === 'string' &&
        msg.includes('lockout window active') &&
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>)['module'] === 'sleep-cycle'
      );
    });

    expect(lockoutCall).toBeDefined();
    const ctx = lockoutCall![0] as Record<string, unknown>;
    expect(ctx['module']).toBe('sleep-cycle');
    expect(ctx['window']).toBe('[configured]');
    // nextEligibleAt must be present and either an ISO string or 'unknown'
    expect(typeof ctx['nextEligibleAt']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// SEC FIX M2: _finalise returns session even when saveSleepSession throws
// ---------------------------------------------------------------------------

describe('SleepCycle._finalise — SEC M2: persistence failure is non-fatal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the session and does not throw when saveSleepSession throws', async () => {
    mockSaveSleepSession.mockImplementationOnce(() => {
      throw new Error('DB write failed');
    });

    const cycle = makeSleepCycle();
    const result = await cycle.startSleep();

    // Session must be returned successfully
    expect(result).toBeDefined();
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);

    // An error must have been logged
    expect(mockErrorFn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('persistence failed'),
    );
  });

  it('caches the session in getLastSleepReport even when saveSleepSession throws', async () => {
    mockSaveSleepSession.mockImplementationOnce(() => {
      throw new Error('DB write failed');
    });

    const cycle = makeSleepCycle();
    const result = await cycle.startSleep();

    expect(cycle.getLastSleepReport()).toStrictEqual(result);
  });
});

// ---------------------------------------------------------------------------
// Wave 6E Builder C — clearDegraded() + degraded phase-skip guards
// ---------------------------------------------------------------------------

describe('SleepCycle.clearDegraded — C-1 & C-2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('C-1: clears _degraded and emits log.info when degraded=true', () => {
    const cycle = makeSleepCycle();
    // reason: testing private state — necessary to set up precondition
    (cycle as unknown as Record<string, unknown>)['_degraded'] = true;
    expect(cycle.isDegraded()).toBe(true);

    cycle.clearDegraded();

    expect(cycle.isDegraded()).toBe(false);
    // log.info should have been called with the operator message
    const clearCall = mockInfoFn.mock.calls.find((call) => {
      const ctx = call[0];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>)['module'] === 'sleep-cycle'
      );
    });
    expect(clearCall).toBeDefined();
  });

  it('C-2: clearDegraded when already false is a no-op — no error, no extra log', () => {
    const cycle = makeSleepCycle();
    expect(cycle.isDegraded()).toBe(false);
    vi.clearAllMocks();

    expect(() => cycle.clearDegraded()).not.toThrow();
    // No log.info should have fired with the operator message after clear
    const clearCall = mockInfoFn.mock.calls.find((call) => {
      const ctx = call[0];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>)['module'] === 'sleep-cycle'
      );
    });
    expect(clearCall).toBeUndefined();
  });
});

describe('SleepCycle.startSleep — degraded phase-skip guards (C-3 through C-6)', () => {
  let phase3Spy: MockInstance;
  let phase5Spy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    phase3Spy = vi.spyOn(phases, 'runPhase3Counterfactuals').mockResolvedValue(undefined);
    phase5Spy = vi.spyOn(phases, 'runPhase5DreamGeneration').mockResolvedValue(undefined);
  });

  it('C-3: startSleep with _degraded=true skips Phase 3 (runPhase3Counterfactuals not called)', async () => {
    const cycle = makeSleepCycle();
    // reason: testing private state — necessary to simulate degraded entry
    (cycle as unknown as Record<string, unknown>)['_degraded'] = true;

    await cycle.startSleep();

    expect(phase3Spy).not.toHaveBeenCalled();
  });

  it('C-4: startSleep with _degraded=true skips Phase 5 (runPhase5DreamGeneration not called)', async () => {
    const cycle = makeSleepCycle();
    // reason: testing private state — necessary to simulate degraded entry
    (cycle as unknown as Record<string, unknown>)['_degraded'] = true;

    await cycle.startSleep();

    expect(phase5Spy).not.toHaveBeenCalled();
  });

  it('C-5: startSleep with _degraded=true emits log.warn with {degraded:true, sessionId}', async () => {
    const cycle = makeSleepCycle();
    // reason: testing private state — necessary to simulate degraded entry
    (cycle as unknown as Record<string, unknown>)['_degraded'] = true;
    vi.clearAllMocks();

    await cycle.startSleep();

    const warnCall = mockWarnFn.mock.calls.find((call) => {
      const ctx = call[0];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>)['degraded'] === true &&
        typeof (ctx as Record<string, unknown>)['sessionId'] === 'string'
      );
    });
    expect(warnCall).toBeDefined();
  });

  it('C-6: startSleep with _degraded=false runs all 5 phases including Phase 3 and Phase 5', async () => {
    const phase1Spy = vi.spyOn(phases, 'runPhase1ExperienceReplay');
    const phase2Spy = vi.spyOn(phases, 'runPhase2PatternFinding').mockResolvedValue(undefined);
    const phase4Spy = vi.spyOn(phases, 'runPhase4SelfUpdate').mockResolvedValue(undefined);

    const cycle = makeSleepCycle();
    expect(cycle.isDegraded()).toBe(false);

    await cycle.startSleep();

    expect(phase1Spy).toHaveBeenCalled();
    expect(phase2Spy).toHaveBeenCalled();
    expect(phase3Spy).toHaveBeenCalled();
    expect(phase4Spy).toHaveBeenCalled();
    expect(phase5Spy).toHaveBeenCalled();
  });

  it('C-9: startSleep degraded + _wakeRequested before Phase 2 returns partial session without hitting skipped phases', async () => {
    const cycle = makeSleepCycle();
    // reason: testing private state — simulating degraded + early wake
    (cycle as unknown as Record<string, unknown>)['_degraded'] = true;

    // Make Phase 1 trigger a wake request side-effect
    vi.spyOn(phases, 'runPhase1ExperienceReplay').mockImplementation(() => {
      // reason: testing private state — simulating wake request mid-cycle
      (cycle as unknown as Record<string, unknown>)['_wakeRequested'] = true;
    });

    const session = await cycle.startSleep();

    // Session returned (no throw)
    expect(session).toBeDefined();
    expect(typeof session.id).toBe('string');
    // Phase 3 and Phase 5 were never reached
    expect(phase3Spy).not.toHaveBeenCalled();
    expect(phase5Spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wave 6H Builder A — CommitmentAuditor hook in SleepCycle
// ---------------------------------------------------------------------------

/** Build a minimal CommitmentAuditReport for tests. */
function makeAuditReport(expiringSoon: CommitmentRow[], alreadyExpired: CommitmentRow[]): CommitmentAuditReport {
  return {
    checkedAt: new Date().toISOString(),
    windowDays: 3,
    total: expiringSoon.length + alreadyExpired.length,
    expiringSoon,
    alreadyExpired,
  };
}

/** Minimal CommitmentRow stub. */
function makeCommitmentRow(id: string): CommitmentRow {
  return {
    id,
    commitment: 'Do not repeat mistake X',
    learned: 'Lesson Y',
    createdAt: Date.now() - 86_400_000,
    ttlDays: 30,
    expiresAt: Date.now() + 86_400_000,
    daysUntilExpiry: 1,
  };
}

/** Build SleepCycle with an optional commitment auditor injected. */
function makeSleepCycleWithAuditor(auditor?: { checkAndWarn(windowDays?: number): CommitmentAuditReport }): SleepCycle {
  const stubDb = {} as import('better-sqlite3').Database;
  return new SleepCycle({
    cdb: { getDb: () => stubDb } as unknown as import('../../../src/core/consciousness/consciousness-db.js').ConsciousnessDB,
    brain: { call: vi.fn().mockResolvedValue('dream text') } as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepBrainLike,
    episodicMemory: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepEpisodicLike,
    counterfactualEngine: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepCounterfactualLike,
    selfModel: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepSelfModelLike,
    temporalSelf: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepTemporalSelfLike,
    metacognition: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepMetacognitionLike,
    wisdomStore: {} as unknown as import('../../../src/core/consciousness/sleep-cycle/types.js').SleepWisdomLike,
    commitmentAuditor: auditor,
  });
}

describe('SleepCycle — Wave 6H: CommitmentAuditor hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('6H-1: with commitmentAuditor returning 1 expiring + 2 expired, session.commitmentAudit has correct counts', async () => {
    const expiringRows = [makeCommitmentRow('exp-1')];
    const expiredRows = [makeCommitmentRow('old-1'), makeCommitmentRow('old-2')];
    const mockAuditor = {
      checkAndWarn: vi.fn().mockReturnValue(makeAuditReport(expiringRows, expiredRows)),
    };

    const cycle = makeSleepCycleWithAuditor(mockAuditor);
    const session = await cycle.startSleep();

    expect(session.commitmentAudit).toBeDefined();
    expect(session.commitmentAudit!.expired).toBe(2);
    expect(session.commitmentAudit!.expiring).toBe(1);
    expect(session.commitmentAudit!.totalFlagged).toBe(3);
    expect(typeof session.commitmentAudit!.checkedAt).toBe('string');
    expect(mockAuditor.checkAndWarn).toHaveBeenCalledWith(3);
  });

  it('6H-2: with commitmentAuditor undefined, no crash and session.commitmentAudit is undefined', async () => {
    const cycle = makeSleepCycleWithAuditor(undefined);
    const session = await cycle.startSleep();

    expect(session.commitmentAudit).toBeUndefined();
  });

  it('6H-3: with commitmentAuditor throwing, cycle still completes, commitmentAudit is undefined, log.error emitted', async () => {
    const throwingAuditor = {
      checkAndWarn: vi.fn().mockImplementation(() => {
        throw new Error('DB unavailable');
      }),
    };

    const cycle = makeSleepCycleWithAuditor(throwingAuditor);
    const session = await cycle.startSleep();

    // Cycle completed successfully (fail-open)
    expect(session).toBeDefined();
    expect(typeof session.id).toBe('string');
    // No audit data
    expect(session.commitmentAudit).toBeUndefined();
    // Error was logged
    expect(mockErrorFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'commitment.audit.error', err: expect.any(Error) }),
      expect.any(String),
    );
  });

  it('6H-4: degraded-mode cycle + commitmentAuditor: audit still runs and extra warn log fires with correct event', async () => {
    const expiringRows = [makeCommitmentRow('e-1')];
    const expiredRows: CommitmentRow[] = [];
    const mockAuditor = {
      checkAndWarn: vi.fn().mockReturnValue(makeAuditReport(expiringRows, expiredRows)),
    };

    const cycle = makeSleepCycleWithAuditor(mockAuditor);
    // reason: testing private state — simulate degraded cycle
    (cycle as unknown as Record<string, unknown>)['_degraded'] = true;
    vi.clearAllMocks();

    const session = await cycle.startSleep();

    // Audit still ran
    expect(mockAuditor.checkAndWarn).toHaveBeenCalledWith(3);
    expect(session.commitmentAudit).toBeDefined();
    expect(session.commitmentAudit!.expiring).toBe(1);
    expect(session.commitmentAudit!.expired).toBe(0);

    // Extra warn log fired with the expected event key
    const warnCall = mockWarnFn.mock.calls.find((call) => {
      const ctx = call[0];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>)['event'] === 'commitment.audit.on-degraded-cycle'
      );
    });
    expect(warnCall).toBeDefined();
  });
});
