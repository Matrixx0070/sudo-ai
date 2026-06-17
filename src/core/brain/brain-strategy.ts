/**
 * @file brain-strategy.ts
 * @description Brain execution strategy types — the plumbing layer for
 * routing brain.call() through different generation pipelines without
 * touching the existing call sites.
 *
 * Stage 1 of the kimi+glm Mythos-beating architecture (refactor #238):
 * adds the types, defaults, and the optional `opts` parameter shape that
 * later stages (#239 debate, #240 tree search) will route on. This PR
 * itself contains zero behavior change — `single` is the only strategy
 * honored, `tier` is captured but not yet acted upon.
 *
 * Design intent:
 *   - `single` — current behavior. One model call through the failover
 *     chain. Default. Conservative.
 *   - `debate` — Blue (kimi) + Red (glm) + Revise + judge. Wired in #239.
 *   - `tree-search` — N debates with shared Reflexion memory + algorithmic
 *     verifier. Wired in #240.
 *
 * Tier hints are an orthogonal axis. The same strategy can apply at
 * different intensity:
 *   - `fast` — cognitive ticks, classifiers, micro-thoughts. Always
 *     single-call regardless of strategy. Prevents latency catastrophe on
 *     background work.
 *   - `routine` — normal agent loop iterations. Strategy applies.
 *   - `high-stakes` — final user-facing synthesis, plan generation, code
 *     edits. Strategy applies with maximum effort (e.g. tree-search
 *     budget bumped).
 */

export type BrainStrategy = 'single' | 'debate' | 'tree-search';

export type BrainCallTier = 'fast' | 'routine' | 'high-stakes';

/**
 * Per-call options that complement BrainRequest. Optional so existing
 * call sites continue to compile untouched — they just behave as if
 * `{ strategy: <Brain.getStrategy()>, tier: 'routine' }` was passed.
 */
export interface BrainCallOpts {
  /**
   * Override the brain's current strategy for this single call. Useful
   * when the caller knows the call is conversational filler that doesn't
   * need debate, or when forcing tree-search on a one-shot benchmark
   * problem.
   */
  strategy?: BrainStrategy;

  /**
   * Hint about how much effort this call deserves. `fast` short-circuits
   * to single-model regardless of the strategy setting. `high-stakes`
   * tells the multi-step strategies (debate, tree-search) to use their
   * higher-budget paths.
   */
  tier?: BrainCallTier;
}

/** Default strategy preserves current behaviour — same as no strategy ever existed. */
export const DEFAULT_BRAIN_STRATEGY: BrainStrategy = 'single';

/** Default tier is `routine` — the agent loop's main reasoning path. */
export const DEFAULT_BRAIN_TIER: BrainCallTier = 'routine';

/**
 * Returns the effective strategy after applying tier short-circuits.
 * `fast` tier always wins over the configured strategy because the
 * cost/latency profile of multi-step pipelines is incompatible with
 * background work (cognitive stream ticks, classifiers).
 */
export function resolveEffectiveStrategy(
  configured: BrainStrategy,
  opts: BrainCallOpts | undefined,
): BrainStrategy {
  const tier = opts?.tier ?? DEFAULT_BRAIN_TIER;
  if (tier === 'fast') return 'single';
  return opts?.strategy ?? configured;
}
