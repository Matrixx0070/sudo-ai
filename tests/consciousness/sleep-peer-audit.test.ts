/**
 * @file tests/consciousness/sleep-peer-audit.test.ts
 * @description Wave 8D: peer-audit tail pull integration in SleepCycle.
 *
 * Tests:
 *   PEER-AUDIT-1  Empty peer registry → peerAudits === [] or undefined
 *   PEER-AUDIT-2  Single peer returns 3 events → summary has eventCount:3 + byEventType
 *   PEER-AUDIT-3  Peer throws → error field set, no session failure
 *   PEER-AUDIT-4  Peer timeout (never-resolving) → total 15s timeout → error:'timeout'
 *   PEER-AUDIT-5  Multiple peers → each summarised independently
 *   PEER-AUDIT-6  Newest/oldest timestamps correctly computed
 *   PEER-AUDIT-7  peerAudits attached to SleepSession output
 *   PEER-AUDIT-8  No auditChainSync set → peerAudits undefined
 *   PEER-AUDIT-9  Empty event list from peer → error:'empty' in summary
 *   PEER-AUDIT-10 firstInstanceIds captured (up to 10) from event list
 *   PEER-AUDIT-11 setAuditChainSync(undefined) clears existing sync
 *   PEER-AUDIT-12 byEventType aggregated correctly across multiple event types
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import type { SleepSession, PeerAuditSummary } from '../../src/core/consciousness/sleep-cycle/types.js';

// ---------------------------------------------------------------------------
// Types for mocking
// ---------------------------------------------------------------------------

interface FakeEvent {
  eventType: string;
  ts: number;
  id: string;
}

interface AuditChainSyncLike {
  listPeers(): string[];
  fetchPeerTail(peerName: string, sinceMs: number, limit?: number): Promise<FakeEvent[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSleepCycle(): SleepCycle {
  const stubDb = {} as import('better-sqlite3').Database;
  return new SleepCycle({
    cdb: { getDb: () => stubDb } as unknown as import('../../src/core/consciousness/consciousness-db.js').ConsciousnessDB,
    brain: { call: vi.fn().mockResolvedValue({ content: 'dream text' }) } as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepBrainLike,
    episodicMemory: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepEpisodicLike,
    counterfactualEngine: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepCounterfactualLike,
    selfModel: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepSelfModelLike,
    temporalSelf: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepTemporalSelfLike,
    metacognition: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepMetacognitionLike,
    wisdomStore: {} as unknown as import('../../src/core/consciousness/sleep-cycle/types.js').SleepWisdomLike,
  });
}

function makeSync(overrides: Partial<AuditChainSyncLike> = {}): AuditChainSyncLike {
  return {
    listPeers: vi.fn().mockReturnValue([]),
    fetchPeerTail: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeEvents(count: number, eventType = 're-anchor', baseTs = 1_700_000_000_000): FakeEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    eventType,
    ts: baseTs + i * 1000,
    id: `evt-${i}`,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SleepCycle peer-audit tail pull (Wave 8D)', () => {
  beforeEach(() => {
    mockSaveSleepSession.mockClear();
    mockWarnFn.mockClear();
    mockErrorFn.mockClear();
    mockInfoFn.mockClear();
    mockDebugFn.mockClear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-1: Empty peer registry → peerAudits empty or undefined
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-1: empty peer registry → peerAudits is empty array', async () => {
    const cycle = makeSleepCycle();
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue([]),
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    // Empty peers → pullAllPeerAudits returns [] → peerAudits is []
    expect(session.peerAudits).toBeDefined();
    expect(session.peerAudits).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-2: Single peer returns 3 events → summary correct
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-2: single peer with 3 events → summary has eventCount:3 + byEventType', async () => {
    const cycle = makeSleepCycle();
    const events = makeEvents(3, 're-anchor');
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-a']),
      fetchPeerTail: vi.fn().mockResolvedValue(events),
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toHaveLength(1);
    const summary = session.peerAudits![0] as PeerAuditSummary;
    expect(summary.peerName).toBe('peer-a');
    expect(summary.eventCount).toBe(3);
    expect(summary.byEventType).toEqual({ 're-anchor': 3 });
    expect(summary.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-3: Peer throws → error field set, no session failure
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-3: peer fetchPeerTail throws → error:unreachable in summary, no session failure', async () => {
    const cycle = makeSleepCycle();
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-b']),
      fetchPeerTail: vi.fn().mockRejectedValue(new Error('network error')),
    });
    cycle.setAuditChainSync(sync);

    // Must not throw
    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toHaveLength(1);
    const summary = session.peerAudits![0] as PeerAuditSummary;
    expect(summary.peerName).toBe('peer-b');
    expect(summary.eventCount).toBe(0);
    expect(summary.error).toBe('unreachable');
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-4: Total timeout → all peers marked timeout
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-4: total 15s timeout fires → all peers get error:timeout', async () => {
    vi.useFakeTimers();

    const cycle = makeSleepCycle();
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-slow']),
      // Never resolves — will trigger the 15s overall timeout
      fetchPeerTail: vi.fn().mockReturnValue(new Promise(() => { /* never */ })),
    });
    cycle.setAuditChainSync(sync);

    const sessionPromise = cycle.startSleep();
    // Advance past the 15s total timeout — use runAllTimersAsync to let async chains settle
    await vi.runAllTimersAsync();

    const session: SleepSession = await sessionPromise;

    expect(session.peerAudits).toHaveLength(1);
    const summary = session.peerAudits![0] as PeerAuditSummary;
    expect(summary.peerName).toBe('peer-slow');
    expect(summary.eventCount).toBe(0);
    expect(summary.error).toBe('timeout');
  }, 30_000);

  // -------------------------------------------------------------------------
  // PEER-AUDIT-5: Multiple peers → each summarised independently
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-5: multiple peers → each summarised independently', async () => {
    const cycle = makeSleepCycle();
    const eventsA = makeEvents(2, 'veto');
    const eventsB = makeEvents(5, 'pattern');
    const fetchMock = vi.fn()
      .mockImplementation(async (peerName: string) => {
        if (peerName === 'peer-a') return eventsA;
        if (peerName === 'peer-b') return eventsB;
        return [];
      });
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-a', 'peer-b']),
      fetchPeerTail: fetchMock,
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toHaveLength(2);
    const a = (session.peerAudits as PeerAuditSummary[]).find(p => p.peerName === 'peer-a');
    const b = (session.peerAudits as PeerAuditSummary[]).find(p => p.peerName === 'peer-b');
    expect(a?.eventCount).toBe(2);
    expect(a?.byEventType).toEqual({ veto: 2 });
    expect(b?.eventCount).toBe(5);
    expect(b?.byEventType).toEqual({ pattern: 5 });
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-6: Newest/oldest timestamps correctly computed
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-6: newestTs and oldestTs correctly reflect event timestamps', async () => {
    const cycle = makeSleepCycle();
    const baseTs = 1_700_000_000_000;
    const events: FakeEvent[] = [
      { eventType: 're-anchor', ts: baseTs + 10_000, id: 'e1' },
      { eventType: 're-anchor', ts: baseTs + 1_000,  id: 'e2' },
      { eventType: 're-anchor', ts: baseTs + 5_000,  id: 'e3' },
    ];
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-ts']),
      fetchPeerTail: vi.fn().mockResolvedValue(events),
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toHaveLength(1);
    const summary = session.peerAudits![0] as PeerAuditSummary;
    expect(summary.newestTs).toBe(baseTs + 10_000);
    expect(summary.oldestTs).toBe(baseTs + 1_000);
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-7: peerAudits attached to SleepSession output
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-7: peerAudits field present on returned SleepSession', async () => {
    const cycle = makeSleepCycle();
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-c']),
      fetchPeerTail: vi.fn().mockResolvedValue(makeEvents(1)),
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    expect(Object.prototype.hasOwnProperty.call(session, 'peerAudits')).toBe(true);
    expect(Array.isArray(session.peerAudits)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-8: No auditChainSync set → peerAudits undefined
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-8: no auditChainSync set → peerAudits is undefined on session', async () => {
    const cycle = makeSleepCycle();
    // Do NOT call setAuditChainSync

    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-9: Empty event list from peer → error:'empty'
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-9: peer returns empty array → summary error:empty, eventCount:0', async () => {
    const cycle = makeSleepCycle();
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-empty']),
      fetchPeerTail: vi.fn().mockResolvedValue([]),
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toHaveLength(1);
    const summary = session.peerAudits![0] as PeerAuditSummary;
    expect(summary.peerName).toBe('peer-empty');
    expect(summary.eventCount).toBe(0);
    expect(summary.error).toBe('empty');
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-10: firstInstanceIds captured (up to 10)
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-10: firstInstanceIds captures up to 10 event IDs', async () => {
    const cycle = makeSleepCycle();
    const events = makeEvents(15, 're-anchor'); // 15 events
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-ids']),
      fetchPeerTail: vi.fn().mockResolvedValue(events),
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toHaveLength(1);
    const summary = session.peerAudits![0] as PeerAuditSummary;
    expect(summary.eventCount).toBe(15);
    expect(summary.firstInstanceIds).toHaveLength(10);
    // Should be the first 10 IDs in order
    expect(summary.firstInstanceIds).toEqual(events.slice(0, 10).map(e => e.id));
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-11: setAuditChainSync(undefined) clears existing sync
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-11: setAuditChainSync(undefined) clears sync → peerAudits undefined next cycle', async () => {
    const cycle = makeSleepCycle();
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-x']),
      fetchPeerTail: vi.fn().mockResolvedValue(makeEvents(1)),
    });
    cycle.setAuditChainSync(sync);

    // First run — should have peerAudits
    const session1: SleepSession = await cycle.startSleep();
    expect(session1.peerAudits).toBeDefined();
    expect((session1.peerAudits as PeerAuditSummary[]).length).toBeGreaterThan(0);

    // Clear sync
    cycle.setAuditChainSync(undefined);

    // Second run — should NOT have peerAudits
    const session2: SleepSession = await cycle.startSleep();
    expect(session2.peerAudits).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // PEER-AUDIT-12: byEventType aggregated correctly across multiple event types
  // -------------------------------------------------------------------------
  it('PEER-AUDIT-12: byEventType aggregated correctly across mixed event types', async () => {
    const cycle = makeSleepCycle();
    const events: FakeEvent[] = [
      { eventType: 're-anchor',  ts: 1000, id: 'a' },
      { eventType: 'veto',       ts: 2000, id: 'b' },
      { eventType: 're-anchor',  ts: 3000, id: 'c' },
      { eventType: 'pattern',    ts: 4000, id: 'd' },
      { eventType: 'veto',       ts: 5000, id: 'e' },
      { eventType: 'veto',       ts: 6000, id: 'f' },
    ];
    const sync = makeSync({
      listPeers: vi.fn().mockReturnValue(['peer-mixed']),
      fetchPeerTail: vi.fn().mockResolvedValue(events),
    });
    cycle.setAuditChainSync(sync);

    const session: SleepSession = await cycle.startSleep();

    expect(session.peerAudits).toHaveLength(1);
    const summary = session.peerAudits![0] as PeerAuditSummary;
    expect(summary.eventCount).toBe(6);
    expect(summary.byEventType).toEqual({ 're-anchor': 2, veto: 3, pattern: 1 });
  });
});
