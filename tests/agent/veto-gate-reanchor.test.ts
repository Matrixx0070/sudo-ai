/**
 * @file tests/agent/veto-gate-reanchor.test.ts
 * @description Tests for Wave 7D post-veto re-anchor callback in veto-gate.ts.
 *
 * Verifies: adversarial DENY fires callback; AUTO-BLOCK does not; APPROVE does not.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runVetoGate,
  setVetoReAnchorCallback,
  setAutoBlockGuard,
} from '../../src/core/agent/veto-gate.js';
import type { VetoInput, AutoBlockGuardLike } from '../../src/core/agent/veto-gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetcher(answer: string): (model: string, prompt: string) => Promise<string> {
  return async () => answer;
}

function makeInput(overrides: Partial<VetoInput> = {}): VetoInput {
  return {
    toolName: 'writeFile',
    args: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('veto-gate: post-veto re-anchor callback (Wave 7D)', () => {
  afterEach(() => {
    // Clean up module-level state after each test
    setVetoReAnchorCallback(undefined);
    setAutoBlockGuard(undefined);
  });

  it('V-1: adversarial DENY fires re-anchor callback', async () => {
    const cb = vi.fn();
    setVetoReAnchorCallback(cb);

    // writeFile = HIGH risk, VETO answer → consensus DENY
    const result = await runVetoGate(makeInput({ toolName: 'writeFile', args: {} }), makeFetcher('VETO because dangerous'));

    expect(result.decision).toBe('VETO');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('V-2: adversarial APPROVE does NOT fire re-anchor callback', async () => {
    const cb = vi.fn();
    setVetoReAnchorCallback(cb);

    // sendEmail = MEDIUM risk, APPROVE answer
    const result = await runVetoGate(makeInput({ toolName: 'sendEmail', args: { to: 'a@b.com' } }), makeFetcher('APPROVE'));

    expect(result.decision).toBe('APPROVE');
    expect(cb).not.toHaveBeenCalled();
  });

  it('V-3: AUTO-BLOCK short-circuit does NOT fire re-anchor callback', async () => {
    const cb = vi.fn();
    setVetoReAnchorCallback(cb);

    // Wire a guard that always BLOCKs
    const guard: AutoBlockGuardLike = {
      check: () => ({ verdict: 'BLOCK', reason: 'repeated mistake detected' }),
    };
    setAutoBlockGuard(guard);

    const result = await runVetoGate(makeInput({ toolName: 'writeFile', args: {} }), makeFetcher('VETO'));

    expect(result.decision).toBe('VETO');
    expect(result.reason).toContain('[AUTO-BLOCK]');
    // Re-anchor must NOT fire on AUTO-BLOCK path
    expect(cb).not.toHaveBeenCalled();
  });

  it('V-4: callback undefined → no error on VETO', async () => {
    setVetoReAnchorCallback(undefined);

    await expect(
      runVetoGate(makeInput({ toolName: 'writeFile', args: {} }), makeFetcher('VETO'))
    ).resolves.toMatchObject({ decision: 'VETO' });
  });

  it('V-5: throwing callback does not propagate error (fail-open)', async () => {
    const cb = vi.fn().mockImplementation(() => { throw new Error('Callback exploded'); });
    setVetoReAnchorCallback(cb);

    await expect(
      runVetoGate(makeInput({ toolName: 'writeFile', args: {} }), makeFetcher('VETO'))
    ).resolves.toMatchObject({ decision: 'VETO' });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
