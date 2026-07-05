/** lesson-apply — the canary controller (pure verdict + lifecycle driver). */
import { describe, it, expect } from 'vitest';
import {
  canaryVerdict, advanceLessonLifecycle, type LifecycleDeps,
} from '../../src/core/learning/lesson-apply.js';
import { upsertCandidate, startCanary, emptyStore, type LessonStore } from '../../src/core/learning/lesson-store.js';

describe('canaryVerdict — promote only on verified improvement', () => {
  it('promotes on a ≥20% failure-rate drop', () => {
    expect(canaryVerdict(0.5, 0.3).promote).toBe(true);   // 40% drop
    expect(canaryVerdict(0.5, 0.4).promote).toBe(true);   // exactly 20%
  });
  it('reverts on regression, sub-margin improvement, or nothing to gain', () => {
    expect(canaryVerdict(0.5, 0.6).promote).toBe(false);  // regression
    expect(canaryVerdict(0.5, 0.45).promote).toBe(false); // only 10% — below bar
    expect(canaryVerdict(0, 0).promote).toBe(false);      // no baseline failures
  });
});

const base = { lessonId: 'exec', tool: 'system.exec', hint: 'no pipes', recoveryPct: 90, canaryWindowMs: 1000, errorPattern: 'Refused:', minCanaryCalls: 20, maxCanaryWindowMs: 100_000 };

describe('advanceLessonLifecycle', () => {
  // Ample sample size (100 calls) unless a test overrides, so the guard is satisfied.
  const deps = (rate: number, nowMs: number, calls = 100): LifecycleDeps => ({
    measureClusterRate: () => ({ rate, calls }), nowMs, nowISO: new Date(nowMs).toISOString(),
  });
  const canaried = (startMs: number): LessonStore =>
    startCanary(upsertCandidate(emptyStore(), base, 'T0').store, 'exec', { rate: 0.5, calls: 100 }, new Date(startMs).toISOString());

  it('candidate → canary and records the baseline cluster rate', () => {
    const s0 = upsertCandidate(emptyStore(), base, 'T0').store;
    const { store, actions } = advanceLessonLifecycle(s0, deps(0.5, 1_000));
    expect(actions[0]!.action).toBe('started-canary');
    expect(store.lessons[0]!.state).toBe('canary');
    expect(store.lessons[0]!.baselineFailRate).toBe(0.5);
    expect(store.lessons[0]!.baselineCalls).toBe(100);
  });

  it('canary before its window elapses is left untouched', () => {
    const startMs = 1_000_000;
    const { changed } = advanceLessonLifecycle(canaried(startMs), deps(0.1, startMs + 500)); // window 1000ms
    expect(changed).toBe(false);
  });

  it('canary past its window PROMOTES when the cluster rate dropped', () => {
    const startMs = 1_000_000;
    const { store, actions } = advanceLessonLifecycle(canaried(startMs), deps(0.2, startMs + 2_000));
    expect(actions[0]!.action).toBe('promoted');
    expect(store.lessons[0]!.state).toBe('promoted');
  });

  it('canary past its window AUTO-REVERTS when the rate did not improve', () => {
    const startMs = 1_000_000;
    const { store, actions } = advanceLessonLifecycle(canaried(startMs), deps(0.55, startMs + 2_000)); // regressed
    expect(actions[0]!.action).toBe('reverted');
    expect(store.lessons[0]!.state).toBe('reverted');
  });

  it('SAMPLE GUARD: thin traffic → WAIT (no mutation) before the hard stop', () => {
    const startMs = 1_000_000;
    // Only 5 calls (< minCanaryCalls 20), still inside maxCanaryWindowMs (100k).
    const { changed, actions } = advanceLessonLifecycle(canaried(startMs), deps(0.1, startMs + 2_000, 5));
    expect(actions[0]!.action).toBe('waiting');
    expect(changed).toBe(false); // 'waiting' does not persist
  });

  it('SAMPLE GUARD: thin traffic past the hard stop → REVERT unverified', () => {
    const startMs = 1_000_000;
    // 5 calls (< 20) AND past maxCanaryWindowMs (100k) → revert even though rate looks great.
    const { store, actions } = advanceLessonLifecycle(canaried(startMs), deps(0.0, startMs + 200_000, 5));
    expect(actions[0]!.action).toBe('reverted');
    expect(store.lessons[0]!.state).toBe('reverted');
    expect(store.lessons[0]!.note).toContain('insufficient canary traffic');
  });
});
