/**
 * @file tests/agent/veto-gate-auto-threshold.test.ts
 * @description Wave 7C: AutoThresholdTuner integration with veto-gate.
 *
 * Tests:
 *   VGA-1  No tuner set → static behavior preserved (LOW risk approve)
 *   VGA-2  No tuner set → MEDIUM risk proceeds to LLM (vote path unchanged)
 *   VGA-3  Tuner set, no adjustment (Brier low) → normal APPROVE
 *   VGA-4  Tuner set, threshold adjusted (Brier high) → computation fires
 *   VGA-5  Tuner throws → fail-open (normal veto proceeds)
 *   VGA-6  BASE_VETO_THRESHOLD exported value is 0.5
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runVetoGate,
  setAutoThresholdTuner,
  BASE_VETO_THRESHOLD,
  type AutoThresholdTunerLike,
} from '../../src/core/agent/veto-gate.js';
import type { VetoInput } from '../../src/core/agent/veto-gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetcher(answer: string): (model: string, prompt: string) => Promise<string> {
  return async (_model: string, _prompt: string): Promise<string> => answer;
}

function makeTuner(opts: {
  effective?: number;
  throws?: boolean;
}): AutoThresholdTunerLike {
  const { effective = 0.5, throws = false } = opts;
  return {
    computeVetoThreshold: (_base: number) => {
      if (throws) throw new Error('tuner failed');
      return effective;
    },
    getLastComputation: () => {
      if (throws) return null;
      return {
        baseThreshold: 0.5,
        effectiveThreshold: effective,
        brierScore: effective < 0.5 ? 0.35 : 0.05,
        totalSamples: 20,
        adjustment: 0.5 - effective,
        computedAt: new Date().toISOString(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

afterEach(() => {
  // Reset module-level state after each test
  setAutoThresholdTuner(undefined);
});

describe('veto-gate AutoThresholdTuner integration', () => {
  // VGA-1: No tuner → LOW risk bypasses LLM
  it('VGA-1: no tuner set — LOW risk returns APPROVE without LLM call', async () => {
    const input: VetoInput = { toolName: 'fetchProfile', args: {} };
    const fetcher = vi.fn<[string, string], Promise<string>>().mockResolvedValue('APPROVE safe');
    const result = await runVetoGate(input, fetcher);
    expect(result.decision).toBe('APPROVE');
    expect(result.risk).toBe('LOW');
    expect(fetcher).not.toHaveBeenCalled();
  });

  // VGA-2: No tuner → MEDIUM risk goes to LLM
  it('VGA-2: no tuner set — MEDIUM risk calls LLM and returns APPROVE', async () => {
    const input: VetoInput = { toolName: 'sendNotification', args: {} };
    const result = await runVetoGate(input, mockFetcher('APPROVE ok'));
    expect(result.decision).toBe('APPROVE');
    expect(result.risk).toBe('MEDIUM');
  });

  // VGA-3: Tuner set, no adjustment (Brier low)
  it('VGA-3: tuner set with no adjustment — APPROVE still returns APPROVE', async () => {
    setAutoThresholdTuner(makeTuner({ effective: 0.5 })); // no change
    const input: VetoInput = { toolName: 'sendAlert', args: {} };
    const result = await runVetoGate(input, mockFetcher('APPROVE all clear'));
    expect(result.decision).toBe('APPROVE');
  });

  // VGA-4: Tuner set with calibration drift — computation fires (observability)
  it('VGA-4: tuner set with adjustment — computation fires and decision proceeds normally', async () => {
    const tuner = makeTuner({ effective: 0.35 }); // threshold lowered due to drift
    const spy = vi.spyOn(tuner, 'computeVetoThreshold');
    setAutoThresholdTuner(tuner);

    const input: VetoInput = { toolName: 'sendEmail', args: {} };
    const result = await runVetoGate(input, mockFetcher('APPROVE looks fine'));

    // Tuner was called once (before LLM)
    expect(spy).toHaveBeenCalledWith(BASE_VETO_THRESHOLD);
    expect(spy).toHaveBeenCalledTimes(1);
    // Decision still driven by vote-counting
    expect(result.decision).toBe('APPROVE');
  });

  // VGA-5: Tuner throws → fail-open, veto proceeds normally
  it('VGA-5: tuner throws — fail-open, normal APPROVE returned for MEDIUM APPROVE votes', async () => {
    setAutoThresholdTuner(makeTuner({ throws: true }));
    const input: VetoInput = { toolName: 'sendMessage', args: {} };
    const result = await runVetoGate(input, mockFetcher('APPROVE ok'));
    expect(result.decision).toBe('APPROVE');
    // No crash — failedOpen is not set (models responded)
    expect(result.failedOpen).toBeUndefined();
  });

  // VGA-6: BASE_VETO_THRESHOLD is exported and equals 0.5
  it('VGA-6: BASE_VETO_THRESHOLD is exported and equals 0.5', () => {
    expect(BASE_VETO_THRESHOLD).toBe(0.5);
  });
});
