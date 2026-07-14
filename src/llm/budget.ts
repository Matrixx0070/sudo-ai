/**
 * @file budget.ts
 * @description Pure context-budget decision used by the agent loop's proactive
 * pre-call gate (gw-refactor Phase 2). Kept free of I/O so the thresholds are
 * unit-testable: >80% of the model's context window → compact; >95% → force
 * (compact + escalate). The loop must never learn its limit from a
 * context_exceeded error.
 */

export type ContextBudgetDecision = 'none' | 'compact' | 'force';

export const COMPACT_THRESHOLD = 0.8;
export const FORCE_THRESHOLD = 0.95;

export function decideContextBudget(estimatedTokens: number, windowTokens: number): ContextBudgetDecision {
  if (!Number.isFinite(estimatedTokens) || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return 'none';
  }
  if (estimatedTokens > windowTokens * FORCE_THRESHOLD) return 'force';
  if (estimatedTokens > windowTokens * COMPACT_THRESHOLD) return 'compact';
  return 'none';
}
