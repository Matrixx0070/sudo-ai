/**
 * Tests for agent-config-evolver.ts and proposal-store.ts.
 * ProposalStore uses in-memory SQLite (via :memory: DB path).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentConfigEvolver } from '../../src/core/learning/agent-config-evolver.js';
import { ProposalStore } from '../../src/core/learning/proposal-store.js';
import type { TracePattern } from '../../src/core/shared/wave10-types.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): ProposalStore {
  // Use a temp file DB per test run to avoid cross-test contamination
  const dbPath = join(tmpdir(), `proposals-test-${randomUUID()}.db`);
  return new ProposalStore(dbPath);
}

function makePattern(opts: Partial<TracePattern> = {}): TracePattern {
  return {
    id: randomUUID().slice(0, 16),
    toolSequence: ['coder.read-file', 'coder.write-file'],
    occurrenceCount: 5,
    successRate: 0.9,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    proposalGenerated: false,
    ...opts,
  };
}

function addHighQualityTraces(
  evolver: AgentConfigEvolver,
  agentId: string,
  count = 15,
  quality = 0.85,
): void {
  for (let i = 0; i < count; i++) {
    evolver.recordTrace({
      sessionId: `session-${i}`,
      agentId,
      toolSequence: ['coder.read-file', 'coder.write-file'],
      quality,
      timestamp: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// ProposalStore
// ---------------------------------------------------------------------------

describe('ProposalStore', () => {
  let store: ProposalStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('saves and retrieves a proposal by ID', () => {
    const now = new Date().toISOString();
    const proposal = {
      id: randomUUID(),
      agentId: 'agent-1',
      rationale: 'Test rationale',
      delta: { tools: { preferred: ['x'] } },
      traceQuality: 0.85,
      traceCount: 12,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    };
    store.save(proposal);
    const retrieved = store.getById(proposal.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(proposal.id);
    expect(retrieved!.agentId).toBe('agent-1');
    expect(retrieved!.rationale).toBe('Test rationale');
    expect(retrieved!.traceQuality).toBe(0.85);
    expect(retrieved!.status).toBe('pending');
  });

  it('returns null for unknown ID', () => {
    const result = store.getById('non-existent');
    expect(result).toBeNull();
  });

  it('lists proposals with pagination', () => {
    for (let i = 0; i < 5; i++) {
      const now = new Date().toISOString();
      store.save({
        id: randomUUID(),
        agentId: 'agent-1',
        rationale: `Rationale ${i}`,
        delta: {},
        traceQuality: 0.8,
        traceCount: 10,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
    const result = store.list({ limit: 3, offset: 0 });
    expect(result.data).toHaveLength(3);
    expect(result.total).toBe(5);
  });

  it('filters list by status', () => {
    const now = new Date().toISOString();
    store.save({ id: randomUUID(), agentId: 'a', rationale: 'r', delta: {}, traceQuality: 0.8, traceCount: 10, status: 'pending', createdAt: now, updatedAt: now });
    store.save({ id: randomUUID(), agentId: 'a', rationale: 'r', delta: {}, traceQuality: 0.8, traceCount: 10, status: 'approved', createdAt: now, updatedAt: now });

    const pending = store.list({ status: 'pending', limit: 50, offset: 0 });
    expect(pending.data).toHaveLength(1);
    expect(pending.data[0]!.status).toBe('pending');
  });

  it('approves a pending proposal', () => {
    const now = new Date().toISOString();
    const id = randomUUID();
    store.save({ id, agentId: 'a', rationale: 'r', delta: {}, traceQuality: 0.8, traceCount: 10, status: 'pending', createdAt: now, updatedAt: now });
    const approved = store.approve(id);
    expect(approved.status).toBe('approved');
  });

  it('throws when approving non-existent ID', () => {
    expect(() => store.approve('ghost-id')).toThrow(/not found/i);
  });

  it('throws when approving an already applied proposal', () => {
    const now = new Date().toISOString();
    const id = randomUUID();
    store.save({ id, agentId: 'a', rationale: 'r', delta: {}, traceQuality: 0.8, traceCount: 10, status: 'applied', createdAt: now, updatedAt: now });
    expect(() => store.approve(id)).toThrow(/already applied/i);
  });

  it('rejects a proposal with optional reason', () => {
    const now = new Date().toISOString();
    const id = randomUUID();
    store.save({ id, agentId: 'a', rationale: 'r', delta: {}, traceQuality: 0.8, traceCount: 10, status: 'pending', createdAt: now, updatedAt: now });
    const rejected = store.reject(id, 'Not applicable');
    expect(rejected.status).toBe('rejected');
  });

  it('throws when rejecting non-existent ID', () => {
    expect(() => store.reject('ghost')).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// AgentConfigEvolver
// ---------------------------------------------------------------------------

describe('AgentConfigEvolver', () => {
  let store: ProposalStore;
  let evolver: AgentConfigEvolver;

  beforeEach(() => {
    store = makeStore();
    evolver = new AgentConfigEvolver(store);
  });

  describe('recordTrace()', () => {
    it('records traces without throwing', () => {
      expect(() => {
        evolver.recordTrace({
          sessionId: 's1',
          agentId: 'agent-1',
          toolSequence: ['x', 'y'],
          quality: 0.9,
          timestamp: new Date().toISOString(),
        });
      }).not.toThrow();
    });

    it('increments trace count per agent', () => {
      expect(evolver.traceCount('agent-1')).toBe(0);
      evolver.recordTrace({ sessionId: 's1', agentId: 'agent-1', toolSequence: ['x'], quality: 0.8, timestamp: new Date().toISOString() });
      expect(evolver.traceCount('agent-1')).toBe(1);
    });

    it('ignores empty sessionId', () => {
      evolver.recordTrace({ sessionId: '', agentId: 'agent-1', toolSequence: ['x'], quality: 0.8, timestamp: new Date().toISOString() });
      expect(evolver.traceCount('agent-1')).toBe(0);
    });

    it('ignores empty agentId', () => {
      evolver.recordTrace({ sessionId: 's1', agentId: '', toolSequence: ['x'], quality: 0.8, timestamp: new Date().toISOString() });
      expect(evolver.traceCount()).toBe(0);
    });
  });

  describe('propose() — quality gate', () => {
    it('returns null when fewer than 10 traces for agent', () => {
      addHighQualityTraces(evolver, 'agent-1', 5, 0.9);
      const result = evolver.propose(makePattern(), 'agent-1');
      expect(result).toBeNull();
    });

    it('returns null when average quality < 0.7', () => {
      addHighQualityTraces(evolver, 'agent-1', 15, 0.4); // low quality
      const result = evolver.propose(makePattern(), 'agent-1');
      expect(result).toBeNull();
    });

    it('returns null when proposalGenerated flag is already set', () => {
      addHighQualityTraces(evolver, 'agent-1', 15, 0.85);
      const pattern = makePattern({ proposalGenerated: true });
      const result = evolver.propose(pattern, 'agent-1');
      expect(result).toBeNull();
    });

    it('generates proposal when >=10 traces with >=0.7 quality', () => {
      addHighQualityTraces(evolver, 'agent-1', 12, 0.8);
      const pattern = makePattern();
      const result = evolver.propose(pattern, 'agent-1');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('pending');
      expect(result!.agentId).toBe('agent-1');
      expect(result!.traceQuality).toBeGreaterThanOrEqual(0.7);
      expect(result!.traceCount).toBeGreaterThanOrEqual(10);
    });

    it('persists proposal to store', () => {
      addHighQualityTraces(evolver, 'agent-2', 10, 0.75);
      const pattern = makePattern();
      const proposal = evolver.propose(pattern, 'agent-2');
      expect(proposal).not.toBeNull();

      const stored = store.getById(proposal!.id);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('pending');
    });

    it('emits proposal event', async () => {
      addHighQualityTraces(evolver, 'agent-3', 10, 0.75);
      const pattern = makePattern();
      const emitted: unknown[] = [];
      evolver.on('proposal', (p) => emitted.push(p));

      evolver.propose(pattern, 'agent-3');
      expect(emitted).toHaveLength(1);
    });

    it('never auto-applies: proposal status is always pending', () => {
      addHighQualityTraces(evolver, 'agent-4', 15, 0.9);
      const result = evolver.propose(makePattern(), 'agent-4');
      expect(result?.status).toBe('pending');
    });

    it('includes rationale with pattern info', () => {
      addHighQualityTraces(evolver, 'agent-5', 10, 0.75);
      const pattern = makePattern({
        toolSequence: ['coder.read-file', 'coder.write-file'],
        occurrenceCount: 7,
        successRate: 0.85,
      });
      const result = evolver.propose(pattern, 'agent-5');
      expect(result!.rationale).toContain('coder.read-file');
      expect(result!.rationale).toContain('7 times');
    });

    it('includes delta with preferred_sequence', () => {
      addHighQualityTraces(evolver, 'agent-6', 10, 0.75);
      const pattern = makePattern({ toolSequence: ['x', 'y', 'z'] });
      const result = evolver.propose(pattern, 'agent-6');
      const delta = result!.delta as Record<string, Record<string, unknown>>;
      expect(delta['tools']?.['preferred_sequence']).toEqual(['x', 'y', 'z']);
    });
  });

  describe('resetTraces()', () => {
    it('clears all traces', () => {
      addHighQualityTraces(evolver, 'agent-1', 5, 0.8);
      evolver.resetTraces();
      expect(evolver.traceCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Traces buffer cap / eviction (CAP-ACE-1 through CAP-ACE-4)
  // ---------------------------------------------------------------------------

  describe('traces buffer cap', () => {
    // Helper: push N traces with quality=0.0 (passes pre-filter: only quality<0 is rejected)
    function pushTraces(count: number): void {
      for (let i = 0; i < count; i++) {
        evolver.recordTrace({
          sessionId: `cap-session-${i}`,
          agentId: 'cap-agent',
          toolSequence: ['tool.a'],
          quality: 0.0,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // CAP-ACE-1: traceCount() stays <= MAX_TRACES after MAX_TRACES+1 pushes
    // MAX_TRACES = 5_000; pushing 5_001 triggers eviction of 500 oldest
    it('CAP-ACE-1: traceCount() stays <= MAX_TRACES after MAX_TRACES+1 pushes', () => {
      pushTraces(5_001);
      expect(evolver.traceCount()).toBeLessThanOrEqual(5_000);
    });

    // CAP-ACE-2: eviction removes exactly TRACES_EVICT_COUNT oldest entries
    // After pushing 5_001 entries: 5_001 - 500 = 4_501 remain
    it('CAP-ACE-2: eviction removes exactly TRACES_EVICT_COUNT oldest entries', () => {
      pushTraces(5_001);
      expect(evolver.traceCount()).toBe(4_501);
    });

    // CAP-ACE-3: traces added after eviction are retained (newest entries not lost)
    it('CAP-ACE-3: traces added after eviction are retained', () => {
      pushTraces(5_001);
      const countAfterEviction = evolver.traceCount(); // 4_501
      pushTraces(3); // 3 more post-eviction
      expect(evolver.traceCount()).toBe(countAfterEviction + 3);
    });

    // CAP-ACE-4: no eviction fires below MAX_TRACES
    it('CAP-ACE-4: no eviction fires below MAX_TRACES', () => {
      const SMALL_COUNT = 20;
      pushTraces(SMALL_COUNT);
      expect(evolver.traceCount()).toBe(SMALL_COUNT);
    });
  });
});
