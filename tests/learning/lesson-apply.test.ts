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

const base = { lessonId: 'exec', tool: 'system.exec', hint: 'no pipes', recoveryPct: 90, canaryWindowMs: 1000 };

describe('advanceLessonLifecycle', () => {
  const deps = (failRate: number, nowMs: number): LifecycleDeps => ({
    measureFailRate: () => failRate, nowMs, nowISO: new Date(nowMs).toISOString(),
  });

  it('candidate → canary and records the baseline', () => {
    const s0 = upsertCandidate(emptyStore(), base, 'T0').store;
    const { store, actions } = advanceLessonLifecycle(s0, deps(0.5, 1_000));
    expect(actions[0]!.action).toBe('started-canary');
    expect(store.lessons[0]!.state).toBe('canary');
    expect(store.lessons[0]!.baselineFailRate).toBe(0.5);
  });

  it('canary before its window elapses is left untouched', () => {
    const startMs = 1_000_000;
    const s: LessonStore = startCanary(upsertCandidate(emptyStore(), base, 'T0').store, 'exec', 0.5, new Date(startMs).toISOString());
    const { changed } = advanceLessonLifecycle(s, deps(0.1, startMs + 500)); // window is 1000ms
    expect(changed).toBe(false);
  });

  it('canary past its window PROMOTES when the failure rate dropped', () => {
    const startMs = 1_000_000;
    const s = startCanary(upsertCandidate(emptyStore(), base, 'T0').store, 'exec', 0.5, new Date(startMs).toISOString());
    const { store, actions } = advanceLessonLifecycle(s, deps(0.2, startMs + 2_000));
    expect(actions[0]!.action).toBe('promoted');
    expect(store.lessons[0]!.state).toBe('promoted');
  });

  it('canary past its window AUTO-REVERTS when the rate did not improve', () => {
    const startMs = 1_000_000;
    const s = startCanary(upsertCandidate(emptyStore(), base, 'T0').store, 'exec', 0.5, new Date(startMs).toISOString());
    const { store, actions } = advanceLessonLifecycle(s, deps(0.55, startMs + 2_000)); // regressed
    expect(actions[0]!.action).toBe('reverted');
    expect(store.lessons[0]!.state).toBe('reverted');
  });
});
