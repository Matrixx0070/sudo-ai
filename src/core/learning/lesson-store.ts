/**
 * @file learning/lesson-store.ts
 * @description Persisted lifecycle store for ADOPTED repair lessons — the state a
 * canary rollout needs, and nothing more.
 *
 * A lesson is a small piece of ADVISORY text injected into the system prompt to
 * steer the agent away from a verified failure. Its lifecycle:
 *
 *   candidate ──startCanary──▶ canary ──promote──▶ promoted
 *                                   └───revert────▶ reverted
 *
 * Only `candidate` (via the live-A/B CLI) enters here; the driver (lesson-apply.ts)
 * advances the rest from REAL measured outcomes. `canary` and `promoted` lessons are
 * the ones actually injected. `reverted` lessons are kept as a record (never
 * re-injected) so a bad lesson is not retried blindly.
 *
 * Persistence is atomic (temp+rename) and fail-open: a missing/corrupt file yields
 * an empty store, never a throw. This file holds only pure data ops — the metric
 * measurement and gating live in lesson-apply.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../shared/atomic-write.js';

export type LessonState = 'candidate' | 'canary' | 'promoted' | 'reverted';

export interface AppliedLesson {
  lessonId: string;
  tool: string;
  /** The advisory text injected into the system prompt (when canary/promoted). */
  hint: string;
  state: LessonState;
  /** Recovery % from the live A/B that adopted it (provenance). */
  recoveryPct: number;
  /**
   * The LLM route that authored/proposed this lesson. Drives judge-independence in the
   * F86 two-reader consensus gate (invariant 7): the independent reader must be on a
   * DIFFERENT provider. Omitted → the configured default author route.
   */
  authorRoute?: string;
  /** ISO — became a candidate. */
  admittedAt: string;
  /** ISO — canary rollout began. */
  canaryStartedAt?: string;
  /** Canary window length; the driver waits this long before judging. */
  canaryWindowMs: number;
  /**
   * SQL LIKE fragment matching this lesson's TARGET failure cluster in
   * error_message (e.g. 'Refused:' for the repo-exec guard). Sharpens the metric to
   * the specific failure the lesson addresses instead of the tool's overall rate.
   * Omitted → the tool's whole failure rate (blunt fallback).
   */
  errorPattern?: string;
  /** Min tool calls in the canary window before the verdict is trusted (sample guard). */
  minCanaryCalls?: number;
  /** Hard stop: revert if the sample guard is never met by this age. */
  maxCanaryWindowMs?: number;
  /** Target-cluster failure rate at canary start (the bar to beat). */
  baselineFailRate?: number;
  /** Tool calls observed when the baseline was taken (provenance). */
  baselineCalls?: number;
  /** Target-cluster failure rate measured over the canary window. */
  canaryFailRate?: number;
  /** Tool calls observed in the canary window (the sample-guard denominator). */
  canaryCalls?: number;
  /** ISO — promoted or reverted. */
  decidedAt?: string;
  note?: string;
}

/** A measured cluster rate and its sample size. */
export interface RateSample {
  rate: number;
  calls: number;
}

export interface LessonStore {
  version: 1;
  lessons: AppliedLesson[];
}

export function emptyStore(): LessonStore {
  return { version: 1, lessons: [] };
}

/** Load the store; a missing or corrupt file yields an empty store (fail-open). */
export function loadLessonStore(path: string): LessonStore {
  try {
    if (!existsSync(path)) return emptyStore();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as LessonStore).lessons)) {
      return { version: 1, lessons: (parsed as LessonStore).lessons };
    }
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

/** Persist the store atomically (0o600 — it records harness-behavior changes). */
export function saveLessonStore(path: string, store: LessonStore): void {
  writeFileAtomic(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Add a lesson as a candidate if one with that lessonId is not already tracked. Pure. */
export function upsertCandidate(store: LessonStore, lesson: Omit<AppliedLesson, 'state' | 'admittedAt'>, nowISO: string): { store: LessonStore; added: boolean } {
  if (store.lessons.some((l) => l.lessonId === lesson.lessonId)) return { store, added: false };
  const next: AppliedLesson = { ...lesson, state: 'candidate', admittedAt: nowISO };
  return { store: { version: 1, lessons: [...store.lessons, next] }, added: true };
}

/** Move a candidate into canary, recording the baseline cluster rate it must beat. Pure. */
export function startCanary(store: LessonStore, lessonId: string, baseline: RateSample, nowISO: string): LessonStore {
  return mapLesson(store, lessonId, (l) =>
    l.state === 'candidate' ? { ...l, state: 'canary', canaryStartedAt: nowISO, baselineFailRate: baseline.rate, baselineCalls: baseline.calls } : l,
  );
}

/** Resolve a canary to promoted or reverted with its measured rate + sample size. Pure. */
export function resolveCanary(store: LessonStore, lessonId: string, canary: RateSample, promote: boolean, nowISO: string, note?: string): LessonStore {
  return mapLesson(store, lessonId, (l) =>
    l.state === 'canary' ? { ...l, state: promote ? 'promoted' : 'reverted', canaryFailRate: canary.rate, canaryCalls: canary.calls, decidedAt: nowISO, note } : l,
  );
}

/** Hints to inject right now: canary + promoted lessons only. Pure. */
export function activeLessonHints(store: LessonStore): string[] {
  return store.lessons.filter((l) => l.state === 'canary' || l.state === 'promoted').map((l) => l.hint);
}

function mapLesson(store: LessonStore, lessonId: string, fn: (l: AppliedLesson) => AppliedLesson): LessonStore {
  return { version: 1, lessons: store.lessons.map((l) => (l.lessonId === lessonId ? fn(l) : l)) };
}
