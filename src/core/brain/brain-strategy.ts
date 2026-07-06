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

import type { BrainResponse, BrainRequest } from './types.js';
import type { VerifierResult } from './brain-tree-search.js';

export type BrainStrategy = 'single' | 'debate' | 'tree-search';

export type BrainCallTier = 'fast' | 'routine' | 'high-stakes';

/**
 * Per-call verifier signature for tree-search. Mirrors
 * `TreeSearchOpts.verifier` so call sites can hand in factory output
 * from `brain-verifier-{exec,schema,compose}.ts` directly without an
 * extra adapter type. Only consulted when the effective strategy is
 * `tree-search`; ignored on `single` and `debate`.
 */
export type BrainCallVerifier = (
  candidate: BrainResponse,
  request: BrainRequest,
) => Promise<VerifierResult> | VerifierResult;

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

  /**
   * Custom verifier passed to tree-search. Lets a call site that knows
   * its expected output shape (JSON plan, code patch, classifier
   * verdict) hand in a `make…Verifier()` factory result. Tree-search
   * rerolls on rejection with Reflexion feedback; debate scores its
   * winner (log-only by default, SUDO_BRAIN_DEBATE_VERIFIER=fallback to
   * prefer Blue when Revise scores worse). Ignored on `single`. Use the
   * factories in `brain-verifier-{exec,schema,compose}.ts`.
   */
  verifier?: BrainCallVerifier;

  /**
   * Override tree-search breadth (candidate count). Default 3. Only
   * meaningful when the effective strategy is `tree-search`.
   */
  breadth?: number;
}

/** Default strategy preserves current behaviour — same as no strategy ever existed. */
export const DEFAULT_BRAIN_STRATEGY: BrainStrategy = 'single';

/** Default tier is `routine` — the agent loop's main reasoning path. */
export const DEFAULT_BRAIN_TIER: BrainCallTier = 'routine';

/**
 * Env var that opts the system into auto-upgrading `tier: 'high-stakes'`
 * calls to a multi-step strategy. Accepted values: `debate`, `tree-search`.
 * Unset / any other value → no upgrade (default behaviour preserved).
 *
 * Wired in PR #242 so call sites can mark themselves high-stakes (`{ tier:
 * 'high-stakes' }`) once, and the operator decides via env whether to pay
 * for the extra quality. Explicit `opts.strategy` always wins — the upgrade
 * only fires when the caller left strategy unspecified.
 */
export const HIGH_STAKES_UPGRADE_ENV = 'SUDO_BRAIN_HIGH_STAKES_STRATEGY';

/**
 * Returns the effective strategy after applying tier short-circuits and
 * the high-stakes env upgrade.
 *
 * Resolution order:
 *   1. `tier: 'fast'` → always `single`, even if strategy is set. Multi-step
 *      pipelines are incompatible with background work (cognitive ticks,
 *      classifiers).
 *   2. Explicit `opts.strategy` wins next — caller knows best.
 *   3. `tier: 'high-stakes'` + env `SUDO_BRAIN_HIGH_STAKES_STRATEGY` set to
 *      a valid strategy → use that. Lets operators flip multi-step on for
 *      high-stakes paths without touching call sites.
 *   4. Otherwise → the brain's ambient `configured` strategy.
 */
export function resolveEffectiveStrategy(
  configured: BrainStrategy,
  opts: BrainCallOpts | undefined,
): BrainStrategy {
  const tier = opts?.tier ?? DEFAULT_BRAIN_TIER;
  if (tier === 'fast') return 'single';
  if (opts?.strategy) return opts.strategy;
  if (tier === 'high-stakes') {
    const envUpgrade = process.env[HIGH_STAKES_UPGRADE_ENV];
    if (envUpgrade === 'debate' || envUpgrade === 'tree-search') {
      return envUpgrade;
    }
  }
  return configured;
}
