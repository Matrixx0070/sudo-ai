/**
 * @file agent/case-law-seam.ts
 * @description F70 planner seam. The fleet's ratified case law lives under
 * src/core/gdrive (consultPrecedents, a pure local read), which the agent loop
 * must not import (hot-path isolation). This injected seam lets the live
 * GoalPlanner surface binding precedents relevant to the current plan — "the
 * fleet already ruled on this" — alongside the dead-end and bias-priors
 * warnings. cli.ts wires the matcher to gdrive consultPrecedents. Default no-op.
 */

export interface PrecedentHit {
  id: string;
  situation: string;
  ruling: string;
}

/** Match plan text against RATIFIED precedents. MUST be synchronous + cheap. */
export type PrecedentMatcher = (planText: string) => PrecedentHit[];

let matcher: PrecedentMatcher | null = null;

export function setCaseLawMatcher(fn: PrecedentMatcher | null): void {
  matcher = fn;
}

/** Fail-open: [] when unwired or on any matcher error. */
export function matchPrecedents(planText: string): PrecedentHit[] {
  if (!matcher) return [];
  try {
    return matcher(planText) ?? [];
  } catch {
    return [];
  }
}

/** Advisory preamble appended to the STRATEGY message when precedents apply. */
export function renderPrecedentConsult(hits: PrecedentHit[]): string {
  if (hits.length === 0) return '';
  return [
    '',
    '## ⚖ FLEET CASE LAW (binding precedents that apply)',
    'The fleet has already ruled on situations like this. Follow the ruling, or state concretely why this case differs:',
    ...hits.slice(0, 5).map((h) => `- **${h.id}**: given "${h.situation}" → ${h.ruling}`),
  ].join('\n');
}
