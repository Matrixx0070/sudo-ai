/**
 * @file agent/bias-priors-seam.ts
 * @description F69 repair-pattern seam. The characteristic-error atlas lives
 * under src/core/gdrive (it reads the corrections dataset), which the agent
 * loop must never import (hot-path isolation). This injected seam lets the live
 * GoalPlanner prepend a bias-priors preamble — the agent's recurring mistakes —
 * to its advisory STRATEGY message. cli.ts wires the provider to the gdrive
 * atlasPreamble() (a cheap, TTL-memoised local read). Default no-op.
 */

/** Returns a short bias-priors preamble (may be ''). MUST be cheap + sync. */
export type BiasPriorsProvider = () => string;

let provider: BiasPriorsProvider | null = null;

/** cli.ts wires this to gdrive atlasPreamble; null to unwire. */
export function setBiasPriorsProvider(fn: BiasPriorsProvider | null): void {
  provider = fn;
}

/** Fail-open: '' when unwired or on any provider error. */
export function getBiasPriorsPreamble(): string {
  if (!provider) return '';
  try {
    return provider() ?? '';
  } catch {
    return '';
  }
}
