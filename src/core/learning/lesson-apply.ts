/**
 * @file learning/lesson-apply.ts
 * @description The APPLY half of the flywheel — the one genuinely dangerous step,
 * wrapped so it can never do harm: gated OFF by default, advisory-text only, and
 * auto-reverting on any non-improvement.
 *
 * Two responsibilities:
 *  1. getAppliedLessonHints() — what the live system prompt injects RIGHT NOW.
 *     Gated by SUDO_FLYWHEEL_APPLY (default off → [], with NO disk read). When on,
 *     returns the advisory hints of canary/promoted lessons, cached briefly so the
 *     hot prompt-assembly path never hammers the disk.
 *  2. advanceLessonLifecycle() — the canary controller. Promotes a lesson ONLY when
 *     the REAL target-metric failure rate dropped by a margin over the canary
 *     window; otherwise it REVERTS. Pure given an injected metric measurer, so the
 *     decision is fully testable and the driver (the scanner) just supplies traces.
 *
 * SAFETY ENVELOPE (why auto-apply is acceptable here):
 *  - Default OFF. With the flag unset, the daemon's prompt is byte-identical.
 *  - Injects ADVISORY TEXT only — never changes code, never removes a feature.
 *  - Reversible: reverting drops the hint on the next prompt assembly.
 *  - A lesson only ever reaches here after an 'adopt' live-A/B decision (≥20
 *    samples / ≥80% recovery), which the corpus cannot currently satisfy — so even
 *    with the flag ON nothing applies until a lesson genuinely proves out.
 *  - Bias to safety: on ANY doubt (baseline no failures, not enough improvement,
 *    regression) the canary REVERTS, never promotes.
 */
import path from 'node:path';
import { DATA_DIR } from '../shared/paths.js';
import {
  loadLessonStore,
  saveLessonStore,
  startCanary,
  resolveCanary,
  activeLessonHints,
  type LessonStore,
} from './lesson-store.js';

/** True only when the operator has explicitly opted into live apply. */
export function isApplyEnabled(): boolean {
  return process.env['SUDO_FLYWHEEL_APPLY'] === '1';
}

export function lessonStorePath(): string {
  return path.join(DATA_DIR, 'flywheel-lessons.json');
}

// --- cached hint read (hot path) --------------------------------------------
let hintCache: { at: number; hints: string[] } | null = null;
const HINT_CACHE_MS = 30_000;

/**
 * Advisory hints to inject into the live system prompt right now. Returns [] with NO
 * disk read when apply is disabled — so the default path is free. `nowMs` is injected
 * for testability (defaults to Date.now()).
 */
export function getAppliedLessonHints(nowMs: number = Date.now()): string[] {
  if (!isApplyEnabled()) return [];
  if (hintCache && nowMs - hintCache.at < HINT_CACHE_MS) return hintCache.hints;
  let hints: string[] = [];
  try {
    hints = activeLessonHints(loadLessonStore(lessonStorePath()));
  } catch {
    hints = [];
  }
  hintCache = { at: nowMs, hints };
  return hints;
}

/** Drop the hint cache (call after mutating the store so the next prompt reflects it). */
export function invalidateHintCache(): void {
  hintCache = null;
}

// --- canary verdict (pure) --------------------------------------------------

export interface CanaryVerdictOpts {
  /** Fractional drop in failure rate required to promote (default 0.2 = 20% lower). */
  minImprovement: number;
}

export const DEFAULT_CANARY_OPTS: CanaryVerdictOpts = { minImprovement: 0.2 };

/**
 * Judge a canary from its baseline vs measured failure rate. Promote ONLY on a clear
 * improvement; revert on no-improvement, regression, or nothing to gain (baseline 0).
 * Pure.
 */
export function canaryVerdict(baseline: number, canary: number, opts: CanaryVerdictOpts = DEFAULT_CANARY_OPTS): { promote: boolean; reason: string } {
  if (baseline <= 0) return { promote: false, reason: 'no baseline failures to improve — nothing to gain' };
  if (canary > baseline) return { promote: false, reason: `regression: failure rate rose ${baseline.toFixed(3)}→${canary.toFixed(3)}` };
  const improved = canary <= baseline * (1 - opts.minImprovement);
  return improved
    ? { promote: true, reason: `failure rate dropped ${baseline.toFixed(3)}→${canary.toFixed(3)} (≥${Math.round(opts.minImprovement * 100)}%)` }
    : { promote: false, reason: `improvement below ${Math.round(opts.minImprovement * 100)}% bar (${baseline.toFixed(3)}→${canary.toFixed(3)})` };
}

// --- lifecycle driver (pure given injected measurer) ------------------------

export interface LifecycleDeps {
  /** Target-metric failure rate for a lesson's tool over [sinceISO, now]; whole-corpus if sinceISO omitted. */
  measureFailRate: (tool: string, sinceISO?: string) => number;
  nowMs: number;
  nowISO: string;
}

export interface LifecycleAction {
  lessonId: string;
  action: 'started-canary' | 'promoted' | 'reverted';
  reason: string;
}

/**
 * Advance every lesson one lifecycle step from real measurements. Candidates start a
 * canary (recording the baseline); canaries past their window are judged and
 * promoted/reverted. Returns the new store, whether anything changed, and the actions
 * taken (for logging). Pure — no I/O; the caller persists and logs.
 */
export function advanceLessonLifecycle(store: LessonStore, deps: LifecycleDeps, opts: CanaryVerdictOpts = DEFAULT_CANARY_OPTS): { store: LessonStore; changed: boolean; actions: LifecycleAction[] } {
  let next = store;
  const actions: LifecycleAction[] = [];

  for (const lesson of store.lessons) {
    if (lesson.state === 'candidate') {
      const baseline = deps.measureFailRate(lesson.tool);
      next = startCanary(next, lesson.lessonId, baseline, deps.nowISO);
      actions.push({ lessonId: lesson.lessonId, action: 'started-canary', reason: `baseline failRate=${baseline.toFixed(3)}` });
      continue;
    }
    if (lesson.state === 'canary' && lesson.canaryStartedAt) {
      const elapsed = deps.nowMs - Date.parse(lesson.canaryStartedAt);
      if (elapsed < lesson.canaryWindowMs) continue; // window not up yet
      const canaryRate = deps.measureFailRate(lesson.tool, lesson.canaryStartedAt);
      const v = canaryVerdict(lesson.baselineFailRate ?? 0, canaryRate, opts);
      next = resolveCanary(next, lesson.lessonId, canaryRate, v.promote, deps.nowISO, v.reason);
      actions.push({ lessonId: lesson.lessonId, action: v.promote ? 'promoted' : 'reverted', reason: v.reason });
    }
  }
  return { store: next, changed: actions.length > 0, actions };
}

/**
 * Full driver step used by the scanner (when apply is enabled): load → advance →
 * persist → invalidate cache. Fail-open. No-op (returns []) when apply is disabled.
 */
export function runLessonLifecycle(deps: LifecycleDeps, opts: CanaryVerdictOpts = DEFAULT_CANARY_OPTS): LifecycleAction[] {
  if (!isApplyEnabled()) return [];
  try {
    const store = loadLessonStore(lessonStorePath());
    const { store: next, changed, actions } = advanceLessonLifecycle(store, deps, opts);
    if (changed) {
      saveLessonStore(lessonStorePath(), next);
      invalidateHintCache();
    }
    return actions;
  } catch {
    return [];
  }
}
