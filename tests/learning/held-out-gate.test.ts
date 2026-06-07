/**
 * Tests for HeldOutGate — non-regression test gate for self-modification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HeldOutGate, type GateTestCase } from '../../src/core/learning/held-out-gate.js';
import type { TraceStore, TraceRecord } from '../../src/core/learning/trace-store.js';
import type { PolicyAction } from '../../src/core/learning/trace-driven-policy.js';

// ---------------------------------------------------------------------------
// Mock TraceStore
// ---------------------------------------------------------------------------

function createMockTraceStore(failedTraces: TraceRecord[] = [], allTraces: TraceRecord[] = []): TraceStore {
  return {
    query: vi.fn().mockImplementation((q: Record<string, unknown>) => {
      if (q.success === false) return failedTraces;
      return allTraces;
    }),
    record: vi.fn(),
    refreshAggregates: vi.fn(),
    getAggregates: vi.fn().mockReturnValue([]),
    getErrorClusters: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
    close: vi.fn(),
  } as unknown as TraceStore;
}

/** Seed 10 test cases so evaluations can proceed past minTestCases. */
function seedTestCases(gate: HeldOutGate, overrides?: Partial<GateTestCase>): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    ids.push(gate.addTestCase({
      intent: `test intent ${i}`,
      currentModel: 'claude-3-opus',
      expectedSuccess: true,
      ...overrides,
    }));
  }
  return ids;
}

describe('HeldOutGate', () => {
  let traceStore: TraceStore;
  let gate: HeldOutGate;

  beforeEach(() => {
    traceStore = createMockTraceStore();
    gate = new HeldOutGate(traceStore);
  });

  // 1. evaluate with passing change
  it('evaluate with passing change: returns pass', async () => {
    seedTestCases(gate);
    const result = await gate.evaluate('prop-pass', { preferredModel: 'claude-3-opus' });
    expect(result.passed).toBe(true);
    expect(result.passRate).toBe(1);
    expect(result.passedTests).toBe(10);
    expect(result.failedTests).toBe(0);
    expect(result.regressionDetails).toHaveLength(0);
  });

  // 2. evaluate with regressing change
  it('evaluate with regressing change: returns fail', async () => {
    seedTestCases(gate);
    const result = await gate.evaluate('prop-block', { block: true });
    expect(result.passed).toBe(false);
    expect(result.failedTests).toBe(10);
    expect(result.regressionDetails.length).toBeGreaterThan(0);
  });

  it('evaluate fails when policy redirects to model with known failures', async () => {
    const failedTraces: TraceRecord[] = [
      { traceType: 'tool_call', toolName: 'deploy', success: false, errorType: 'auth' } as TraceRecord,
    ];
    traceStore = createMockTraceStore(failedTraces);
    gate = new HeldOutGate(traceStore);
    seedTestCases(gate, { currentModel: 'good-model', toolName: 'deploy' });
    const result = await gate.evaluate('prop-bad', { preferredModel: 'bad-model' });
    expect(result.passed).toBe(false);
  });

  // 3. tolerance
  it('tolerance: change within tolerance passes', async () => {
    gate = new HeldOutGate(traceStore, { tolerance: 0.1, minTestCases: 2, autoApply: false });
    // 1 case that will fail (expectedSuccess=true + block policy)
    gate.addTestCase({ intent: 'blocked', currentModel: 'm1', expectedSuccess: true });
    // 9 cases that pass under a block policy (expectedSuccess=false)
    for (let i = 0; i < 9; i++) {
      gate.addTestCase({ intent: `case ${i}`, currentModel: 'm1', expectedSuccess: false });
    }
    const result = await gate.evaluate('prop-tol', { block: true });
    expect(result.passedTests).toBe(9);
    expect(result.failedTests).toBe(1);
    expect(result.passRate).toBe(0.9);
    expect(result.passed).toBe(true);
  });

  it('tolerance: change exceeding tolerance fails', async () => {
    gate = new HeldOutGate(traceStore, { tolerance: 0.01, minTestCases: 2, autoApply: false });
    gate.addTestCase({ intent: 'a', currentModel: 'm1', expectedSuccess: true });
    gate.addTestCase({ intent: 'b', currentModel: 'm1', expectedSuccess: true });
    const result = await gate.evaluate('prop-tol2', { block: true });
    expect(result.passed).toBe(false);
  });

  // 4. addTestCase and removeTestCase
  it('addTestCase: generates tc: prefixed ID and stores case', () => {
    const id = gate.addTestCase({ intent: 'my test', currentModel: 'm1', expectedSuccess: true });
    expect(id).toMatch(/^tc:/);
    expect(gate.getTestCases()).toHaveLength(1);
    expect(gate.getTestCases()[0].intent).toBe('my test');
  });

  it('removeTestCase: removes by ID and returns true', () => {
    const id = gate.addTestCase({ intent: 'remove me', currentModel: 'm1', expectedSuccess: true });
    expect(gate.removeTestCase(id)).toBe(true);
    expect(gate.getTestCases()).toHaveLength(0);
  });

  it('removeTestCase: returns false for nonexistent ID', () => {
    expect(gate.removeTestCase('tc:nonexistent')).toBe(false);
  });

  // 5. generateTestCasesFromTraces
  it('generateTestCasesFromTraces: auto-generates from trace store', async () => {
    const successfulTraces: TraceRecord[] = [
      { traceType: 'tool_call', intent: 'deploy app', model: 'claude-3-opus', toolName: 'deploy', success: true, latencyMs: 200, category: 'coding' } as TraceRecord,
      { traceType: 'tool_call', intent: 'search docs', model: 'claude-3-sonnet', toolName: 'search', success: true, latencyMs: 100, category: 'analysis' } as TraceRecord,
    ];
    traceStore = createMockTraceStore([], successfulTraces);
    gate = new HeldOutGate(traceStore);

    const count = await gate.generateTestCasesFromTraces();
    expect(count).toBe(2);
    const cases = gate.getTestCases();
    expect(cases).toHaveLength(2);
    expect(cases.some(tc => tc.intent === 'deploy app' && tc.currentModel === 'claude-3-opus')).toBe(true);
    expect(cases.some(tc => tc.intent === 'search docs' && tc.currentModel === 'claude-3-sonnet')).toBe(true);
    // All generated cases expect success
    expect(cases.every(tc => tc.expectedSuccess)).toBe(true);
  });

  it('generateTestCasesFromTraces: deduplicates by intent+model', async () => {
    const traces: TraceRecord[] = [
      { traceType: 'tool_call', intent: 'deploy app', model: 'm1', success: true } as TraceRecord,
      { traceType: 'tool_call', intent: 'deploy app', model: 'm1', success: true } as TraceRecord,
    ];
    traceStore = createMockTraceStore([], traces);
    gate = new HeldOutGate(traceStore);
    // Pre-seed a matching case
    gate.addTestCase({ intent: 'deploy app', currentModel: 'm1', expectedSuccess: true });
    const count = await gate.generateTestCasesFromTraces();
    expect(count).toBe(0);
  });

  // 6. minTestCases
  it('minTestCases: fails when too few test cases', async () => {
    gate = new HeldOutGate(traceStore, { minTestCases: 10 });
    gate.addTestCase({ intent: 'only one', currentModel: 'm1', expectedSuccess: true });
    const result = await gate.evaluate('prop-min', {});
    expect(result.passed).toBe(false);
    expect(result.regressionDetails).toEqual(
      expect.arrayContaining([expect.stringContaining('Insufficient test cases')]),
    );
  });

  // 7. autoApply
  it('autoApply: accepted changes are auto-applied and versioned', async () => {
    gate = new HeldOutGate(traceStore, { minTestCases: 2, autoApply: true, rollbackEnabled: true });
    seedTestCases(gate);
    await gate.evaluate('prop-auto', { preferredModel: 'm1' });
    const history = gate.getVersionHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.versionId).toBe('prop-auto');
  });

  it('autoApply off: accepted changes are not versioned', async () => {
    gate = new HeldOutGate(traceStore, { minTestCases: 2, autoApply: false, rollbackEnabled: true });
    seedTestCases(gate);
    await gate.evaluate('prop-noauto', { preferredModel: 'm1' });
    expect(gate.getVersionHistory()).toHaveLength(0);
  });

  // 8. rollback
  it('rollback: rollback points are created and can be used', async () => {
    gate = new HeldOutGate(traceStore, { minTestCases: 2, autoApply: true, rollbackEnabled: true });
    seedTestCases(gate);
    const change: PolicyAction = { preferredModel: 'm1' };
    await gate.evaluate('prop-rb', change);

    const rolledBack = gate.rollback('prop-rb');
    expect(rolledBack).toEqual(change);
    expect(gate.getVersionHistory()).toHaveLength(0);
  });

  it('rollback: returns null when rollback is disabled', async () => {
    gate = new HeldOutGate(traceStore, { minTestCases: 2, autoApply: true, rollbackEnabled: false });
    seedTestCases(gate);
    await gate.evaluate('prop-rb2', { preferredModel: 'm1' });
    expect(gate.rollback('prop-rb2')).toBeNull();
  });

  it('rollback: returns null for nonexistent proposal ID', () => {
    gate = new HeldOutGate(traceStore, { rollbackEnabled: true });
    expect(gate.rollback('nonexistent')).toBeNull();
  });
});