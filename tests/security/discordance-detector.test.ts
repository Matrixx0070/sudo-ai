/**
 * @file tests/security/discordance-detector.test.ts
 * @description Unit tests for the cross-stream discordance detector.
 *
 * Pure unit tests — no DB, no FS, no network.
 * Covers all 10 scenarios from spec section 5 (Builder B).
 */

import { describe, it, expect } from 'vitest';
import {
  detectDiscordance,
} from '../../src/core/security/discordance-detector.js';
import type {
  DiscordanceSignals,
  DiscordanceResult,
} from '../../src/core/security/discordance-detector.js';

// ---------------------------------------------------------------------------
// Helpers — well-behaved baseline signals
// ---------------------------------------------------------------------------

function normalSignals(): DiscordanceSignals {
  return {
    cadence: { callsInWindow: 10, baselineCallsPerWindow: 10 },
    toolGraph: { recentToolNames: ['read', 'write', 'read', 'exec'] },
    outcomeTrend: { recentOutcomeTypes: ['success', 'success', 'success'] },
    selfReport: { text: 'proceeding as planned' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectDiscordance', () => {
  // B-1: All-normal signals → 'normal', score < 0.40
  it('B-1: all-normal signals produce level=normal and score < 0.40', () => {
    const result: DiscordanceResult = detectDiscordance(normalSignals());
    expect(result.level).toBe('normal');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(0.40);
  });

  // B-2: Cadence ratio > 2x → cadence flagged in contributingSignals
  it('B-2: cadence ratio > 2x flags cadence in contributingSignals', () => {
    const signals = normalSignals();
    // ratio = 30/10 = 3.0, which is > 2.0 → flagged
    signals.cadence = { callsInWindow: 30, baselineCallsPerWindow: 10 };
    const result = detectDiscordance(signals);
    expect(result.contributingSignals).toContain('cadence');
  });

  // B-3: Tool repetition > 50% → toolGraph flagged
  it('B-3: high consecutive tool repetition flags toolGraph in contributingSignals', () => {
    const signals = normalSignals();
    // 4 consecutive pairs out of 5 items = 4/5 = 0.8 → > 0.5 → flagged
    signals.toolGraph = { recentToolNames: ['x', 'x', 'x', 'x', 'x'] };
    const result = detectDiscordance(signals);
    expect(result.contributingSignals).toContain('toolGraph');
  });

  // B-4: Error rate > 60% → outcomeTrend flagged
  it('B-4: error-dominant outcomes flag outcomeTrend in contributingSignals', () => {
    const signals = normalSignals();
    // 7/10 = 0.7 error rate > 0.6 → flagged
    signals.outcomeTrend = {
      recentOutcomeTypes: [
        'error', 'error', 'error', 'error', 'error', 'error', 'error',
        'success', 'success', 'success',
      ],
    };
    const result = detectDiscordance(signals);
    expect(result.contributingSignals).toContain('outcomeTrend');
  });

  // B-5: Distress keyword in text → selfReport flagged
  it('B-5: distress keyword in selfReport.text flags selfReport in contributingSignals', () => {
    const signals = normalSignals();
    signals.selfReport = { text: 'I am stuck and cannot proceed' };
    const result = detectDiscordance(signals);
    expect(result.contributingSignals).toContain('selfReport');
  });

  // B-6: All signals maxed → 'discordant', score >= 0.70
  it('B-6: all signals maxed produces level=discordant and score >= 0.70', () => {
    const signals: DiscordanceSignals = {
      // cadence ratio = 100 → very high, score=1 (clamped), flagged
      cadence: { callsInWindow: 100, baselineCallsPerWindow: 10 },
      // all same tool → consecutive pairs = 4/5 = 0.8, flagged
      toolGraph: { recentToolNames: ['x', 'x', 'x', 'x', 'x'] },
      // all errors → error rate = 1.0, flagged
      outcomeTrend: {
        recentOutcomeTypes: ['error', 'error', 'error', 'error', 'error'],
      },
      // multiple distress markers
      selfReport: { text: 'stuck cannot failed error blocked unable loop' },
    };
    const result = detectDiscordance(signals);
    expect(result.level).toBe('discordant');
    expect(result.score).toBeGreaterThanOrEqual(0.70);
  });

  // B-7: Empty recentToolNames → no crash, toolGraph score = 0
  it('B-7: empty recentToolNames does not crash and produces score=0 for toolGraph', () => {
    const signals = normalSignals();
    signals.toolGraph = { recentToolNames: [] };
    // toolGraph alone won't be flagged; overall should remain normal-ish
    expect(() => detectDiscordance(signals)).not.toThrow();
    const result = detectDiscordance(signals);
    // toolGraph not flagged → not in contributingSignals
    expect(result.contributingSignals).not.toContain('toolGraph');
  });

  // B-8: Invalid/undefined values in signals → fails open to 'normal'
  it('B-8: completely malformed signals object fails open to level=normal', () => {
    // Pass a signal object that forces an exception inside the try block
    // by providing non-object sub-signals (null coercion paths).
    const badSignals = {
      cadence: null,
      toolGraph: null,
      outcomeTrend: null,
      selfReport: null,
    } as unknown as DiscordanceSignals;

    const result = detectDiscordance(badSignals);
    expect(result.level).toBe('normal');
    expect(result.score).toBe(0);
    expect(result.contributingSignals).toEqual([]);
  });

  // B-9: contributingSignals lists exactly the flagged scorer names (and no others)
  it('B-9: contributingSignals contains exactly the names of flagged scorers', () => {
    const signals = normalSignals();
    // Only trigger outcomeTrend (> 60% errors)
    signals.outcomeTrend = {
      recentOutcomeTypes: ['error', 'error', 'error', 'error', 'success'],
    };
    const result = detectDiscordance(signals);
    expect(result.contributingSignals).toContain('outcomeTrend');
    expect(result.contributingSignals).not.toContain('cadence');
    expect(result.contributingSignals).not.toContain('toolGraph');
    expect(result.contributingSignals).not.toContain('selfReport');
  });

  // B-10: detectedAt is valid ISO-8601
  it('B-10: detectedAt is a valid ISO-8601 timestamp string', () => {
    const result = detectDiscordance(normalSignals());
    expect(typeof result.detectedAt).toBe('string');
    const parsed = new Date(result.detectedAt);
    expect(parsed.toISOString()).toBe(result.detectedAt);
  });

  // Extra: verify cadence weight — cadence alone at max produces score ~ 0.30
  it('weight check: cadence-only high signal produces score near 0.30', () => {
    const signals: DiscordanceSignals = {
      // ratio = 100 → |100 - 1| = 99, clamped to 1.0; weight=0.30 → contribution=0.30
      cadence: { callsInWindow: 100, baselineCallsPerWindow: 10 },
      toolGraph: { recentToolNames: ['a', 'b', 'c', 'd'] }, // no repetition → 0
      outcomeTrend: { recentOutcomeTypes: ['success'] },
      selfReport: { text: '' },
    };
    const result = detectDiscordance(signals);
    // score ≈ 1.0*0.30 + 0*0.20 + 0*0.35 + 0*0.15 = 0.30
    expect(result.score).toBeCloseTo(0.30, 2);
  });

  // Extra: verify outcomeTrend weight — 100% error rate alone → score ~ 0.35
  it('weight check: outcomeTrend-only max produces score near 0.35', () => {
    const signals: DiscordanceSignals = {
      cadence: { callsInWindow: 10, baselineCallsPerWindow: 10 }, // ratio=1 → score=0
      toolGraph: { recentToolNames: ['a', 'b', 'c'] }, // no repetition → 0
      outcomeTrend: { recentOutcomeTypes: ['error', 'error', 'error'] }, // 100% error → score=1
      selfReport: { text: '' },
    };
    const result = detectDiscordance(signals);
    // score ≈ 0*0.30 + 0*0.20 + 1.0*0.35 + 0*0.15 = 0.35
    expect(result.score).toBeCloseTo(0.35, 2);
  });
});
