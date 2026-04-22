/**
 * @file tests/security/discordance-detector-reanchor.test.ts
 * @description Tests for Wave 7D post-discordance re-anchor callback.
 *
 * Verifies: 'discordant' level fires callback; 'normal' and 'elevated' do not.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectDiscordance,
  setDiscordanceReAnchorCallback,
} from '../../src/core/security/discordance-detector.js';
import type { DiscordanceSignals } from '../../src/core/security/discordance-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalSignals(): DiscordanceSignals {
  return {
    cadence: { callsInWindow: 10, baselineCallsPerWindow: 10 },
    toolGraph: { recentToolNames: ['read', 'write', 'read', 'exec'] },
    outcomeTrend: { recentOutcomeTypes: ['success', 'success', 'success'] },
    selfReport: { text: 'all good' },
  };
}

/** Signals crafted to produce score >= 0.70 (discordant level). */
function discordantSignals(): DiscordanceSignals {
  return {
    // cadence ratio = 50/5 = 10 → |10-1| = 9, clamped to 1.0, flagged
    cadence: { callsInWindow: 50, baselineCallsPerWindow: 5 },
    // all same tool → score = (N-1)/N ≈ 0.875, flagged
    toolGraph: { recentToolNames: ['exec', 'exec', 'exec', 'exec', 'exec', 'exec', 'exec', 'exec'] },
    // all error outcomes → score = 1.0, flagged
    outcomeTrend: { recentOutcomeTypes: ['error', 'error', 'error', 'error', 'error'] },
    // multiple distress markers
    selfReport: { text: 'stuck cannot failed error blocked unable loop' },
  };
}

/**
 * Signals crafted to produce score in [0.40, 0.70) (elevated level).
 *
 * Calculation (weights: cadence=0.30, toolGraph=0.20, outcomeTrend=0.35, selfReport=0.15):
 *   cadence: ratio = 25/10 = 2.5 → |2.5-1| = 1.5, clamped to 1.0. Contribution = 0.30
 *   toolGraph: 3 consecutive pairs in ['a','a','a','a','b','b','b'] = 3 pairs / 7 total ≈ 0.43
 *             × 0.20 = 0.086
 *   outcomeTrend: 0 errors. Contribution = 0
 *   selfReport: 1 distress marker ('stuck') in 7 total markers = 1/7 ≈ 0.143. × 0.15 = 0.021
 *   Total ≈ 0.407 → elevated (>= 0.40, < 0.70)
 */
function elevatedSignals(): DiscordanceSignals {
  return {
    cadence: { callsInWindow: 25, baselineCallsPerWindow: 10 },
    toolGraph: { recentToolNames: ['a', 'a', 'a', 'a', 'b', 'b', 'b'] },
    outcomeTrend: { recentOutcomeTypes: ['success', 'success', 'success'] },
    selfReport: { text: 'things are stuck right now' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discordance-detector: post-discordance re-anchor callback (Wave 7D)', () => {
  afterEach(() => {
    setDiscordanceReAnchorCallback(undefined);
  });

  it('D-1: discordant level fires re-anchor callback', () => {
    const cb = vi.fn();
    setDiscordanceReAnchorCallback(cb);

    const result = detectDiscordance(discordantSignals());

    expect(result.level).toBe('discordant');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('D-2: normal level does NOT fire re-anchor callback', () => {
    const cb = vi.fn();
    setDiscordanceReAnchorCallback(cb);

    const result = detectDiscordance(normalSignals());

    expect(result.level).toBe('normal');
    expect(cb).not.toHaveBeenCalled();
  });

  it('D-3: elevated level does NOT fire re-anchor callback', () => {
    const cb = vi.fn();
    setDiscordanceReAnchorCallback(cb);

    const result = detectDiscordance(elevatedSignals());

    // Confirm we actually got elevated
    expect(result.score).toBeGreaterThanOrEqual(0.40);
    expect(result.score).toBeLessThan(0.70);
    expect(result.level).toBe('elevated');
    expect(cb).not.toHaveBeenCalled();
  });

  it('D-4: callback undefined → no error on discordant', () => {
    setDiscordanceReAnchorCallback(undefined);

    expect(() => detectDiscordance(discordantSignals())).not.toThrow();
  });

  it('D-5: throwing callback does not propagate (fail-open)', () => {
    const cb = vi.fn().mockImplementation(() => { throw new Error('CB exploded'); });
    setDiscordanceReAnchorCallback(cb);

    expect(() => detectDiscordance(discordantSignals())).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
