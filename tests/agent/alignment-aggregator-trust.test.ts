/**
 * @file tests/agent/alignment-aggregator-trust.test.ts
 * @description Wave 6J: AlignmentAggregator with live TrustTierTracker.
 *
 * Tests:
 *   1. When trustTierTracker is absent, trustTier uses static signal value.
 *   2. When tracker returns HIGH tier, signal score is 0.95.
 *   3. When tracker returns PROBATION tier, signal score is 0.15 (pushes toward RED).
 *   4. When tracker.getCurrentTier() throws, falls back to static signal (fail-open).
 *   5. Tier MEDIUM → score 0.70, tier LOW → score 0.40.
 */

import { describe, it, expect } from 'vitest';
import { AlignmentAggregator, type AlignmentSignals, type TrustTierTrackerLike } from '../../src/core/agent/alignment-aggregator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function neutralSignals(trustTierOverride = 0.5): AlignmentSignals {
  return {
    outcomeDelta: 0,
    commitmentDrift: 0,
    trustTier: trustTierOverride,
    injectionRate: 0,
    recoveryPending: 0,
    reAnchor: 0,
    discordanceScore: 0,
  };
}

function makeMockTracker(tier: string, throwOnGet = false): TrustTierTrackerLike {
  return {
    getCurrentTier: () => {
      if (throwOnGet) throw new Error('tracker error');
      return tier;
    },
    getScore: () => 0.5,
    recordOutcome: () => { /* no-op */ },
    getAuditSnapshot: () => ({
      tier,
      score: 0.5,
      windowSizeDays: 7,
      lastAdjustedAt: new Date().toISOString(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Test 1: No tracker — uses static signal
// ---------------------------------------------------------------------------

describe('6J-AGG-1: no trustTierTracker — static signal used', () => {
  it('uses the signals.trustTier value directly when no tracker is wired', () => {
    const agg = new AlignmentAggregator();
    const result = agg.evaluate(neutralSignals(0.8));
    expect(result.failedOpen).toBe(false);
    // With trustTier=0.8 and all other signals neutral, score should be > 0.70 (GREEN).
    expect(result.level).toBe('GREEN');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Tracker returns HIGH — score becomes 0.95
// ---------------------------------------------------------------------------

describe('6J-AGG-2: tracker HIGH → signal 0.95 contributes to GREEN', () => {
  it('reads HIGH tier from tracker and maps to 0.95 for the trustTier signal', () => {
    const tracker = makeMockTracker('HIGH');
    const agg = new AlignmentAggregator(undefined, tracker);
    // Use static trustTier=0 to verify it gets overridden by tracker
    const result = agg.evaluate(neutralSignals(0));
    expect(result.failedOpen).toBe(false);
    // HIGH=0.95 replaces 0, so score should be higher than with trustTier=0.
    // All neutral except HIGH trustTier → GREEN territory.
    expect(result.level).toBe('GREEN');
    expect(result.score).toBeGreaterThan(0.70);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Tracker returns PROBATION — score becomes 0.15
// ---------------------------------------------------------------------------

describe('6J-AGG-3: tracker PROBATION → signal 0.15 (lower trust contribution)', () => {
  it('maps PROBATION tier to 0.15, lowering the composite score', () => {
    const tracker = makeMockTracker('PROBATION');
    const agg = new AlignmentAggregator(undefined, tracker);
    // Use static trustTier=1.0 to verify it gets overridden downward by tracker
    const signalsWithHighStatic = neutralSignals(1.0);
    const resultWithTracker = agg.evaluate(signalsWithHighStatic);
    expect(resultWithTracker.failedOpen).toBe(false);

    // Compare: without tracker, trustTier=1.0 → higher score
    const aggNoTracker = new AlignmentAggregator();
    const resultNoTracker = aggNoTracker.evaluate(signalsWithHighStatic);

    // PROBATION (0.15) should produce a lower score than 1.0 for the same signals.
    expect(resultWithTracker.score).toBeLessThan(resultNoTracker.score);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Tracker throws — fail-open to static signal
// ---------------------------------------------------------------------------

describe('6J-AGG-4: tracker.getCurrentTier() throws — fall-open to static', () => {
  it('falls back to static trustTier signal when tracker throws', () => {
    const throwingTracker = makeMockTracker('HIGH', /* throwOnGet */ true);
    const agg = new AlignmentAggregator(undefined, throwingTracker);
    // Static trustTier=0.8 should be preserved since tracker throws.
    const result = agg.evaluate(neutralSignals(0.8));
    expect(result.failedOpen).toBe(false);
    // With static 0.8 and neutral signals → GREEN.
    expect(result.level).toBe('GREEN');
  });
});

// ---------------------------------------------------------------------------
// Test 5: MEDIUM and LOW tier mappings
// ---------------------------------------------------------------------------

describe('6J-AGG-5: MEDIUM=0.70 and LOW=0.40 tier mappings', () => {
  it('MEDIUM tier produces a higher trustTier contribution than LOW', () => {
    const medTracker = makeMockTracker('MEDIUM');
    const lowTracker = makeMockTracker('LOW');
    const aggMed = new AlignmentAggregator(undefined, medTracker);
    const aggLow = new AlignmentAggregator(undefined, lowTracker);
    const signals = neutralSignals(0); // static=0, overridden by tracker

    const medResult = aggMed.evaluate(signals);
    const lowResult = aggLow.evaluate(signals);
    expect(medResult.score).toBeGreaterThan(lowResult.score);
  });
});
