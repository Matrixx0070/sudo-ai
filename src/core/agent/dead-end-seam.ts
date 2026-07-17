/**
 * @file agent/dead-end-seam.ts
 * @description G-PLANNER repair. The dream cycle (F12) already pre-checks its
 * plans against confirmed dead ends (F33) via matchDeadEnds(), but the LIVE
 * GoalPlanner in the agent loop never did — so the agent could cheerfully
 * re-attempt an approach already proven futile.
 *
 * The dead-end store lives under src/core/gdrive, which the agent loop must
 * NEVER import (hot-path isolation, tests/gdrive/hot-path.test.ts). So this is
 * an INJECTED-CALLBACK seam: cli.ts wires the matcher to gdrive's matchDeadEnds
 * (a pure in-memory lookup — no Drive I/O), and the planner calls it through
 * this indirection. Default is a no-op, so nothing changes until wired.
 */

export interface DeadEndHit {
  /** One-line description of the previously-failed approach. */
  summary: string;
  /** Why it failed. */
  cause: string;
}

/** Matches plan text against confirmed dead ends. MUST be synchronous + cheap. */
export type PlanDeadEndMatcher = (planText: string) => DeadEndHit[];

let matcher: PlanDeadEndMatcher | null = null;

/** cli.ts wires this to gdrive matchDeadEnds; pass null to unwire. */
export function setPlanDeadEndMatcher(fn: PlanDeadEndMatcher | null): void {
  matcher = fn;
}

/** Fail-open: never throws, returns [] when unwired or on any matcher error. */
export function matchPlanDeadEnds(planText: string): DeadEndHit[] {
  if (!matcher) return [];
  try {
    return matcher(planText) ?? [];
  } catch {
    return [];
  }
}

/**
 * Render a warning block appended to the STRATEGY message when a plan repeats a
 * known dead end. Advisory (the plan steps are already advisory) but explicit:
 * the agent must justify why THIS attempt differs, or abandon the approach.
 */
export function renderDeadEndWarning(hits: DeadEndHit[]): string {
  if (hits.length === 0) return '';
  const lines = [
    '',
    '## ⚠ PREVIOUSLY-FAILED APPROACHES (dead ends)',
    'This plan resembles approaches already proven futile. For each, either state concretely why THIS attempt differs, or abandon it — do not blindly retry:',
    ...hits.slice(0, 5).map((h) => `- ${h.summary} — failed because: ${h.cause}`),
  ];
  return lines.join('\n');
}
