/**
 * @file tests/consciousness/cw2-context-pressure.test.ts
 * @description CW2 — real context pressure into the assembly path
 * (SUDO_CAS_PRESSURE). Unit-covers the pressure util (tier mapping, budgets,
 * code-point-safe deterministic capping) and proves the acceptance criterion:
 * at 90% synthetic occupancy the injected consciousness block is strictly
 * smaller than at 20%, while an undefined budget stays byte-identical
 * (preserving the CW0 snapshot guarantee).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pressureTier,
  budgetForTier,
  capToBudget,
  estimateTokens,
} from '../../src/core/consciousness/context-pressure.js';
import {
  generateIntelligenceBrief,
  type ConsciousnessLike,
} from '../../src/core/agent/intelligence-brief.js';

function richMock(pad = 400): ConsciousnessLike {
  return {
    getIntelligenceBriefContext: () => ({
      dominantDrive: { name: 'curiosity', intensity: 0.7 },
      emotionalState: { emotion: 'engaged', intensity: 0.5 },
      matchingProcedure: { name: 'build-feature', steps: ['plan', 'code', 'verify'], successRate: 0.8 },
      relevantPredictions: [{ domain: 'tool_use', prediction: 'will need tools '.repeat(8), confidence: 0.6, outcome: 'pending' }],
      recentEpisodes: [
        { summary: 'fixed a long bug '.repeat(pad / 16), outcome: 'positive', significance: 0.6, timestamp: '2026-07-19T00:00:00.000Z' },
        { summary: 'shipped a feature '.repeat(pad / 16), outcome: 'positive', significance: 0.7, timestamp: '2026-07-19T01:00:00.000Z' },
      ],
      counterfactualLessons: [{ lessonLearned: 'test first '.repeat(10), deltaAssessment: 'would have caught it' }],
      metacognitiveReflections: [{ conclusion: 'approach sound '.repeat(10), actionItem: 'keep going' }],
      surpriseLevel: 0.42,
      temporalNarrative: 'Steady progress across the session. '.repeat(10),
      activeConcepts: ['drives', 'surprise', 'pressure'],
      selfCompetence: {
        overallConfidence: 0.8,
        strengths: [{ domain: 'coding', confidence: 0.9 }],
        weaknesses: [{ domain: 'design', confidence: 0.3 }],
      },
    }),
  };
}

let dir: string;
let savedHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw2-'));
  savedHome = process.env['SUDO_AI_HOME'];
  process.env['SUDO_AI_HOME'] = dir;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['SUDO_AI_HOME'];
  else process.env['SUDO_AI_HOME'] = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('CW2 — pressure tier mapping', () => {
  it('CW2-T1: occupancy maps to full/compressed/minimal at the bridge-derived thresholds', () => {
    expect(pressureTier(0)).toBe('full');
    expect(pressureTier(0.2)).toBe('full');
    expect(pressureTier(0.49)).toBe('full');
    expect(pressureTier(0.5)).toBe('compressed');
    expect(pressureTier(0.7)).toBe('compressed');
    expect(pressureTier(0.85)).toBe('compressed');
    expect(pressureTier(0.9)).toBe('minimal');
    expect(pressureTier(1)).toBe('minimal');
  });

  it('CW2-T2: out-of-range and NaN occupancy fail-open toward full/minimal clamps', () => {
    expect(pressureTier(-5)).toBe('full');
    expect(pressureTier(7)).toBe('minimal');
    expect(pressureTier(Number.NaN)).toBe('full');
  });

  it('CW2-T3: budgets — full uncapped, minimal < compressed', () => {
    expect(budgetForTier('full')).toBeUndefined();
    const c = budgetForTier('compressed')!;
    const m = budgetForTier('minimal')!;
    expect(m).toBeLessThan(c);
    expect(m).toBeGreaterThan(0);
  });
});

describe('CW2 — capToBudget', () => {
  it('CW2-C1: under-budget text is returned unchanged; capped text never exceeds the budget', () => {
    expect(capToBudget('short', 100)).toBe('short');
    const long = 'word '.repeat(2000);
    const capped = capToBudget(long, 100);
    expect(capped.length).toBeLessThan(long.length);
    expect(estimateTokens(capped)).toBeLessThanOrEqual(100);
    expect(capped.endsWith('… [truncated: context pressure]')).toBe(true);
  });

  it('CW2-C2: deterministic — identical inputs produce identical outputs', () => {
    const long = 'alpha beta gamma '.repeat(500);
    expect(capToBudget(long, 80)).toBe(capToBudget(long, 80));
  });

  it('CW2-C3: code-point safe — never splits surrogate pairs', () => {
    const emoji = '😀'.repeat(3000); // astral code points (2 UTF-16 units each)
    const capped = capToBudget(emoji, 50);
    // A split surrogate produces a lone-surrogate char; well-formed check:
    expect(capped.isWellFormed?.() ?? true).toBe(true);
    expect(estimateTokens(capped)).toBeLessThanOrEqual(50);
  });

  it('CW2-C4: zero/negative budget yields empty string (defensive)', () => {
    expect(capToBudget('anything', 0)).toBe('');
    expect(capToBudget('anything', -5)).toBe('');
  });
});

describe('CW2 — acceptance: injected block shrinks under pressure', () => {
  it('CW2-A1: 90% occupancy budget yields a strictly smaller injected block than 20%', async () => {
    // 20% occupancy -> tier full -> budget undefined -> uncapped.
    const b20 = budgetForTier(pressureTier(0.2));
    const brief20 = await generateIntelligenceBrief('build a feature', richMock(), null, b20);
    // 90% occupancy -> tier minimal -> hard cap.
    const b90 = budgetForTier(pressureTier(0.9));
    const brief90 = await generateIntelligenceBrief('build a feature', richMock(), null, b90);

    expect(estimateTokens(brief20.formatted)).toBeGreaterThan(150);
    expect(brief90.formatted.length).toBeLessThan(brief20.formatted.length);
    expect(estimateTokens(brief90.formatted)).toBeLessThanOrEqual(b90!);
  });

  it('CW2-A2: undefined budget (flag OFF path) is byte-identical to the 3-arg call', async () => {
    const withoutArg = await generateIntelligenceBrief('build a feature', richMock(), null);
    const withUndefined = await generateIntelligenceBrief('build a feature', richMock(), null, undefined);
    expect(withUndefined.formatted).toBe(withoutArg.formatted);
  });
});
