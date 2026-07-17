/**
 * @file judge.ts
 * @description Judge-route independence (G-JUDGE). The NotebookLM annex's E4
 * probe framework compares a route-under-test's answers against an external
 * reader; a cheap LLM comparator/judge scores the pairs. The hard rule
 * (invariant 7 / annex E4): the judge route must be DISTINCT from any route
 * under test — never the student, never the incoming route, never the author
 * of the answers judged. Where no independent judge exists (single-provider
 * fleet), the gate HOLDS for human review rather than letting a model grade
 * itself.
 *
 * This module is pure resolution + independence logic. The actual judge brain
 * call is injected by the consumer (E4), which passes the resolved judge model
 * to brain.chat(msgs, judgeModel) — the same injection the second-opinion
 * reviewer and gdrive inspector already use.
 */

import { resolveAlias } from './aliases.js';

/** Extract the provider prefix from a `provider/model` string. */
export function providerOf(model: string): string {
  const slash = model.indexOf('/');
  return (slash > 0 ? model.slice(0, slash) : model).toLowerCase();
}

/** Resolve the pinned judge route to a concrete `provider/model`
 * (honors LLM_ALIAS_JUDGE via resolveAlias). */
export function resolveJudgeModel(): string {
  return resolveAlias('sudo/judge');
}

/**
 * Independence test: the judge is independent iff it shares NEITHER the exact
 * model NOR the provider of the route under test. Provider-level distinctness
 * is required because same-provider models share training lineage and failure
 * modes — a weak form of grading-your-own-homework.
 */
export function isIndependentJudge(judgeModel: string, routeUnderTest: string): boolean {
  const j = judgeModel.toLowerCase();
  const r = routeUnderTest.toLowerCase();
  if (j === r) return false;
  return providerOf(j) !== providerOf(r);
}

export type JudgeVerdict =
  | { available: true; judgeModel: string }
  | { available: false; reason: string };

/**
 * Resolve the judge for a given route under test. Returns the judge model when
 * independent, or an unavailable verdict (the E4 gate then HOLDS for human
 * review). `routesUnderTest` may include multiple routes (student + authors);
 * the judge must be independent of ALL of them.
 */
export function judgeFor(routesUnderTest: string[]): JudgeVerdict {
  const judgeModel = resolveJudgeModel();
  const conflicting = routesUnderTest
    .map((r) => resolveAlias(r))
    .find((r) => !isIndependentJudge(judgeModel, r));
  if (conflicting) {
    return {
      available: false,
      reason: `judge route ${judgeModel} is not independent of route-under-test ${conflicting} (same provider) — gate holds for human review`,
    };
  }
  return { available: true, judgeModel };
}
