/**
 * @file no-gate-fail-closed.test.ts
 * @description Invariant 8 on the self-improvement apply path: an ABSENT
 * HeldOutGate blocks every apply (fail-closed) instead of waving changes
 * through. Before this fix, `shouldApply` returned true with no gate and the
 * only production caller (meta/self-improve tool) passed none — every
 * autonomous improvement applied ungated. The caller now wires a real
 * HeldOutGate; the engine treats "no gate" the same as "gate holds".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpData: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpData = mkdtempSync(join(tmpdir(), 'selfimprove-gate-'));
  saved['DATA_DIR'] = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpData; // no mind.db inside → pattern detection skipped
  vi.resetModules(); // paths.ts captures DATA_DIR at import time
});

afterEach(() => {
  rmSync(tmpData, { recursive: true, force: true });
  if (saved['DATA_DIR'] === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = saved['DATA_DIR'];
  vi.resetModules();
});

async function importEngine() {
  return await import('../../src/core/self-improvement/engine.js');
}

describe('runSelfImprovement — absent HeldOutGate fails closed', () => {
  it('NOGATE-1: with NO gate, no action is applied', async () => {
    const { runSelfImprovement } = await importEngine();
    const result = await runSelfImprovement({ trigger: 'test-no-gate' });
    // Actions may be proposed, but none may be APPLIED without a gate.
    expect(result.actions.every((a) => a.applied === false)).toBe(true);
    expect(result.rollbacks).toHaveLength(0);
  });

  it('NOGATE-2: with a PASSING gate, applies still happen (capability preserved)', async () => {
    const { runSelfImprovement } = await importEngine();
    const gate = {
      evaluate: async (proposalId: string) => ({
        proposalId,
        passed: true,
        passRate: 1,
        tolerance: 0.05,
        totalTests: 10,
        passedTests: 10,
        regressionDetails: [],
        evaluatedAt: new Date().toISOString(),
      }),
    };
    const result = await runSelfImprovement({
      trigger: 'test-gate-pass',
      heldOutGate: gate as unknown as import('../../src/core/learning/held-out-gate.js').HeldOutGate,
    });
    const applied = result.actions.filter((a) => a.applied);
    expect(applied.length).toBeGreaterThan(0);
    expect(result.rollbacks.length).toBeGreaterThan(0);
  });

  it('NOGATE-3: a THROWING gate blocks applies (fail-closed, AL8.0 semantics)', async () => {
    const { runSelfImprovement } = await importEngine();
    const gate = {
      evaluate: async () => {
        throw new Error('bench data unavailable');
      },
    };
    const result = await runSelfImprovement({
      trigger: 'test-gate-throw',
      heldOutGate: gate as unknown as import('../../src/core/learning/held-out-gate.js').HeldOutGate,
    });
    expect(result.actions.every((a) => a.applied === false)).toBe(true);
    expect(result.rollbacks).toHaveLength(0);
  });

  it('NOGATE-4: evaluateDraftGate holds on a throwing gate (direct unit)', async () => {
    const { evaluateDraftGate } = await importEngine();
    const verdict = await evaluateDraftGate(
      { evaluate: async () => { throw new Error('down'); } },
      'p-1',
      { params: { description: 'd' } },
      'tool-x',
    );
    expect(verdict).toBe(false);
  });
});
