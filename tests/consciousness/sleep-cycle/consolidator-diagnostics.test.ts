/**
 * @file tests/consciousness/sleep-cycle/consolidator-diagnostics.test.ts
 * @description Wave 6M: CrossSignalDiagnostics integration in SleepCycle.
 *
 * Tests:
 *   DIAG-SL-1  analyze() called with correct opts; summary attached to session.
 *   DIAG-SL-2  diagnostics undefined when crossSignalDiagnostics is absent.
 *   DIAG-SL-3  Fail-open: analyze() throw swallowed; diagnostics stays undefined.
 *   DIAG-SL-4  Warn log emitted when running on a degraded cycle.
 *   DIAG-SL-5  topCorrelations capped to 3 entries in summary.
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

interface MockSpike {
  source: string;
  kind: string;
  ts: number;
  count: number;
}

interface MockCorrelation {
  leadingSpike: { kind: string; source: string; ts: number; count: number };
  trailingSpike: { kind: string; source: string; ts: number; count: number };
  deltaMs: number;
  confidence: number;
}

interface MockDiagnosticsReport {
  windowDays: number;
  trustSpikes: MockSpike[];
  epistemicBlockSpikes: MockSpike[];
  vetoSpikes: MockSpike[];
  commitmentExpirySpikes: MockSpike[];
  correlations: MockCorrelation[];
  analyzedAt: string;
  totalEventsScanned: number;
}

interface CrossSignalDiagnosticsLike {
  analyze(opts?: { windowDays?: number; spikeBucketMinutes?: number; correlationWindowMinutes?: number }): MockDiagnosticsReport;
}

function makeSpike(source: string, kind: string, count = 3): MockSpike {
  return { source, kind, ts: Date.now(), count };
}

function makeCorrelation(fromKind: string, toKind: string, deltaMs = 5000, confidence = 0.7): MockCorrelation {
  return {
    leadingSpike: { kind: fromKind, source: 'trust', ts: Date.now(), count: 4 },
    trailingSpike: { kind: toKind, source: 'epistemic', ts: Date.now() + deltaMs, count: 3 },
    deltaMs,
    confidence,
  };
}

function makeDiagnosticsReport(opts: Partial<{
  trustSpikeCount: number;
  epistemicSpikeCount: number;
  vetoSpikeCount: number;
  commitmentSpikeCount: number;
  correlationCount: number;
  totalEventsScanned: number;
}> = {}): MockDiagnosticsReport {
  const trustSpikes = Array.from({ length: opts.trustSpikeCount ?? 2 }, (_, i) =>
    makeSpike('trust', 'trust-failure', 3 + i));
  const epistemicBlockSpikes = Array.from({ length: opts.epistemicSpikeCount ?? 1 }, () =>
    makeSpike('epistemic', 'epistemic-block', 4));
  const vetoSpikes = Array.from({ length: opts.vetoSpikeCount ?? 0 }, () =>
    makeSpike('veto', 'veto', 3));
  const commitmentExpirySpikes = Array.from({ length: opts.commitmentSpikeCount ?? 0 }, () =>
    makeSpike('commitment', 'commitment-expired', 3));
  const correlations = Array.from({ length: opts.correlationCount ?? 2 }, (_, i) =>
    makeCorrelation('trust-failure', 'epistemic-block', 5000 + i * 1000, 0.8 - i * 0.1));

  return {
    windowDays: 7,
    trustSpikes,
    epistemicBlockSpikes,
    vetoSpikes,
    commitmentExpirySpikes,
    correlations,
    analyzedAt: new Date().toISOString(),
    totalEventsScanned: opts.totalEventsScanned ?? 50,
  };
}

function makeStubSleepCycle(
  diagnostics?: CrossSignalDiagnosticsLike,
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
    crossSignalDiagnostics: diagnostics,
  });
  if (forceDegraded) {
    (cycle as unknown as { _degraded: boolean })._degraded = true;
  }
  return cycle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SleepCycle CrossSignalDiagnostics hooks (6M)', () => {
  beforeEach(() => {
    mockSaveSleepSession.mockClear();
    mockWarnFn.mockClear();
    mockErrorFn.mockClear();
    mockInfoFn.mockClear();
    mockDebugFn.mockClear();
  });

  // -------------------------------------------------------------------------
  // DIAG-SL-1: analyze() called with correct opts; summary attached
  // -------------------------------------------------------------------------
  it('DIAG-SL-1: calls analyze with correct opts and attaches diagnostics summary to session', async () => {
    const report = makeDiagnosticsReport({ trustSpikeCount: 2, epistemicSpikeCount: 1, correlationCount: 2, totalEventsScanned: 60 });
    const mockDiagnostics: CrossSignalDiagnosticsLike = {
      analyze: vi.fn().mockReturnValue(report),
    };

    const cycle = makeStubSleepCycle(mockDiagnostics);
    const session: SleepSession = await cycle.startSleep();

    // analyze called once with correct opts
    expect(mockDiagnostics.analyze).toHaveBeenCalledOnce();
    expect(mockDiagnostics.analyze).toHaveBeenCalledWith({
      windowDays: 7,
      spikeBucketMinutes: 15,
      correlationWindowMinutes: 30,
    });

    // diagnostics summary attached to session
    expect(session.diagnostics).toBeDefined();
    expect(session.diagnostics?.trustSpikeCount).toBe(2);
    expect(session.diagnostics?.epistemicBlockSpikeCount).toBe(1);
    expect(session.diagnostics?.vetoSpikeCount).toBe(0);
    expect(session.diagnostics?.commitmentExpirySpikeCount).toBe(0);
    expect(session.diagnostics?.totalEventsScanned).toBe(60);
    expect(typeof session.diagnostics?.analyzedAt).toBe('string');
    expect(Array.isArray(session.diagnostics?.topCorrelations)).toBe(true);
    expect(session.diagnostics?.topCorrelations.length).toBe(2);
    // Verify correlation shape
    const first = session.diagnostics?.topCorrelations[0];
    expect(typeof first?.from).toBe('string');
    expect(typeof first?.to).toBe('string');
    expect(typeof first?.deltaMs).toBe('number');
    expect(typeof first?.confidence).toBe('number');
  });

  // -------------------------------------------------------------------------
  // DIAG-SL-2: diagnostics undefined when dep absent
  // -------------------------------------------------------------------------
  it('DIAG-SL-2: does not attach diagnostics when crossSignalDiagnostics is not provided', async () => {
    const cycle = makeStubSleepCycle(/* no diagnostics */);
    const session: SleepSession = await cycle.startSleep();

    expect(session.diagnostics).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // DIAG-SL-3: Fail-open: analyze() throw swallowed
  // -------------------------------------------------------------------------
  it('DIAG-SL-3: swallows errors thrown by analyze() and leaves diagnostics undefined', async () => {
    const throwingDiagnostics: CrossSignalDiagnosticsLike = {
      analyze: () => { throw new Error('DB error from cross-signal diagnostics'); },
    };

    const cycle = makeStubSleepCycle(throwingDiagnostics);

    // Should not throw despite diagnostics failure
    await expect(cycle.startSleep()).resolves.not.toThrow();

    const session: SleepSession = await cycle.startSleep();
    expect(session.diagnostics).toBeUndefined();

    // error should be logged
    expect(mockErrorFn).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // DIAG-SL-4: Warn log on degraded cycle
  // -------------------------------------------------------------------------
  it('DIAG-SL-4: logs a warn when running on a degraded cycle', async () => {
    const report = makeDiagnosticsReport();
    const mockDiagnostics: CrossSignalDiagnosticsLike = {
      analyze: vi.fn().mockReturnValue(report),
    };

    const cycle = makeStubSleepCycle(mockDiagnostics, /* forceDegraded */ true);
    await cycle.startSleep();

    const warnCalls = mockWarnFn.mock.calls as Array<[unknown, string]>;
    const degradedWarn = warnCalls.find(c =>
      typeof c[1] === 'string' && c[1].includes('Cross-signal diagnostics ran on degraded cycle'),
    );
    expect(degradedWarn).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // DIAG-SL-5: topCorrelations capped to 3 entries
  // -------------------------------------------------------------------------
  it('DIAG-SL-5: topCorrelations is capped to 3 entries in session summary', async () => {
    // Return 5 correlations — summary should only keep first 3
    const report = makeDiagnosticsReport({ correlationCount: 5 });
    const mockDiagnostics: CrossSignalDiagnosticsLike = {
      analyze: vi.fn().mockReturnValue(report),
    };

    const cycle = makeStubSleepCycle(mockDiagnostics);
    const session: SleepSession = await cycle.startSleep();

    expect(session.diagnostics?.topCorrelations.length).toBe(3);
  });
});
