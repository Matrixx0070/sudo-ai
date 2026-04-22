/**
 * @file tests/consciousness/sleep-cycle/consolidator-trust.test.ts
 * @description Wave 6J: TrustTracker recordOutcome hooks in SleepCycle commitment audit block.
 *
 * Tests:
 *   1. For each expired commitment row, recordOutcome('commitment-expired') is called.
 *   2. When there are no expired rows, recordOutcome is NOT called.
 *   3. When trustTracker.recordOutcome() throws, the error is swallowed (fail-open).
 *   4. trustTracker is optional — SleepCycle constructs without it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommitmentAuditReport, CommitmentRow } from '../../../src/core/cognition/commitment-auditor.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(id: string): CommitmentRow {
  return {
    id,
    mistake: 'test mistake',
    learned: 'test learned',
    commitment: 'test commitment',
    ttl_days: 7,
    created_at: Date.now(),
    expires_at: Date.now() - 1000,
    is_expired: 1,
  };
}

function makeReport(expiredRows: CommitmentRow[], expiringSoon: CommitmentRow[] = []): CommitmentAuditReport {
  return {
    alreadyExpired: expiredRows,
    expiringSoon,
    checkedAt: new Date().toISOString(),
    total: expiredRows.length + expiringSoon.length,
  };
}

interface TrustTrackerLike {
  recordOutcome(outcome: { timestamp: number; kind: string }): void;
}

function makeStubSleepCycle(
  commitmentAuditorReport: CommitmentAuditReport,
  trustTracker?: TrustTrackerLike,
): SleepCycle {
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
    commitmentAuditor: {
      checkAndWarn: () => commitmentAuditorReport,
    },
    trustTracker,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SleepCycle trustTracker hooks (6J)', () => {
  beforeEach(() => {
    mockSaveSleepSession.mockClear();
    mockWarnFn.mockClear();
    mockErrorFn.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. recordOutcome called once per expired row
  // -------------------------------------------------------------------------
  it('calls recordOutcome(commitment-expired) once per expired commitment row', async () => {
    const recordOutcome = vi.fn();
    const trustTracker: TrustTrackerLike = { recordOutcome };

    const expiredRows = [makeRow('row-1'), makeRow('row-2'), makeRow('row-3')];
    const cycle = makeStubSleepCycle(makeReport(expiredRows), trustTracker);

    await cycle.startSleep();

    const expiredCalls = recordOutcome.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === 'commitment-expired',
    );
    expect(expiredCalls).toHaveLength(3);
    for (const call of expiredCalls) {
      expect(typeof (call[0] as { timestamp: number }).timestamp).toBe('number');
    }
  });

  // -------------------------------------------------------------------------
  // 2. No calls when no expired rows
  // -------------------------------------------------------------------------
  it('does not call recordOutcome when there are no expired rows', async () => {
    const recordOutcome = vi.fn();
    const trustTracker: TrustTrackerLike = { recordOutcome };

    const cycle = makeStubSleepCycle(makeReport([], [makeRow('expiring-soon')]), trustTracker);

    await cycle.startSleep();

    const expiredCalls = recordOutcome.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === 'commitment-expired',
    );
    expect(expiredCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Fail-open: recordOutcome throw is swallowed
  // -------------------------------------------------------------------------
  it('swallows errors thrown by recordOutcome (fail-open)', async () => {
    const throwingTracker: TrustTrackerLike = {
      recordOutcome: () => { throw new Error('tracker error'); },
    };

    const expiredRows = [makeRow('row-1')];
    const cycle = makeStubSleepCycle(makeReport(expiredRows), throwingTracker);

    // Should not throw despite tracker failure.
    await expect(cycle.startSleep()).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 4. trustTracker is optional — SleepCycle constructs fine without it
  // -------------------------------------------------------------------------
  it('constructs and runs without trustTracker (no errors)', async () => {
    const cycle = makeStubSleepCycle(makeReport([makeRow('row-1')]), /* no tracker */);
    await expect(cycle.startSleep()).resolves.toBeDefined();
  });
});
