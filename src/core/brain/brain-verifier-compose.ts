/**
 * @file brain-verifier-compose.ts
 * @description Composition primitive for tree-search verifiers. Wraps
 * N independent verifiers into one shape-compatible with
 * `TreeSearchOpts.verifier`, so a caller can require "must compile AND
 * must be valid JSON" without writing a fused verifier by hand.
 *
 * Stops being premature with the second judge in the family: the exec
 * verifier (#241) checks runtime behaviour, the schema verifier (#246)
 * checks structured shape, and most production callers want BOTH.
 *
 *   const v = makeCompositeVerifier([execVerifier, schemaVerifier]);
 *   runTreeSearch(brain, request, { verifier: v, breadth: 3 });
 *
 * Modes:
 *   - `all` (default) — score is the MIN across sub-verifiers (every
 *     judge must accept). Reasons from any failing judge are joined.
 *   - `any` — score is the MAX (any one judge accepts). Reasons from
 *     all judges are kept only when every judge rejected, so the
 *     Reflexion log doesn't get spammed for an accepting case.
 *   - `weighted` — score is the weighted average. Requires `weights`
 *     of the same length as `verifiers`; weights are normalised so
 *     callers can pass raw priorities. Reasons from any judge below
 *     `threshold` (default 0.5) are joined.
 *
 * Concurrency: sub-verifiers run sequentially. Parallelism is a future
 * slice — most verifiers either do almost no work (schema) or already
 * own a sandbox runner (exec), so the extra wiring isn't worth it yet.
 *
 * Errors: a throwing sub-verifier is treated as score 0 with the error
 * message in the reason. Composite never throws past its own boundary
 * — tearing down a tree-search run because one judge crashed would
 * defeat the point of having multiple judges.
 *
 * What this verifier is NOT:
 *   - A judge in its own right. It produces no novel signal beyond
 *     the sub-verifiers it wraps.
 *   - A way to silence a noisy verifier. If one judge is wrong, fix
 *     or drop it — don't bury it under composition.
 *
 * Wiring: same posture as the sister verifiers — exported as a
 * library primitive, no `src/` callers yet. Production wiring is the
 * caller's choice; the typical pattern is `runTreeSearch(brain, req,
 * { verifier: makeCompositeVerifier([exec, schema]) })`. Forced
 * wiring into the default tree-search path is intentionally avoided:
 * the right judges depend on the task, and the orchestrator should
 * stay agnostic.
 */

import { createLogger } from '../shared/logger.js';
import type { BrainResponse, BrainRequest } from './types.js';
import type { VerifierResult } from './brain-tree-search.js';

const log = createLogger('brain-verifier-compose');

/** Single verifier signature, matches `TreeSearchOpts.verifier`. */
export type Verifier = (
  candidate: BrainResponse,
  request: BrainRequest,
) => Promise<VerifierResult> | VerifierResult;

/** Composition mode. */
export type CompositeMode = 'all' | 'any' | 'weighted';

/** Options for makeCompositeVerifier. */
export interface CompositeOpts {
  /** Combination strategy. Default 'all'. */
  mode?: CompositeMode;
  /**
   * Per-verifier weights, same length as `verifiers`. Required for
   * `weighted`, ignored for `all` / `any`. Normalised internally so
   * callers can pass raw integer priorities.
   */
  weights?: number[];
  /**
   * Score below this counts as failure. Default 0.5 — same threshold
   * the tree-search orchestrator uses to decide whether to log a
   * reason (brain-tree-search.ts:165). Governs TWO behaviours
   * simultaneously: which sub-verifier reasons get joined into the
   * Reflexion log, AND in `any` mode whether at least one judge
   * counted as "accepted" (which suppresses reason output). If you
   * raise this, you tighten both gates together.
   */
  threshold?: number;
}

/** Single sub-verifier outcome plus its index in the input array. */
interface SubResult extends VerifierResult {
  idx: number;
}

/**
 * Compose N verifiers. Throws at construction time for
 * caller-misconfigurations (empty array, weighted-without-weights,
 * mismatched-weight-length) so a mistake surfaces early, not on the
 * first candidate.
 */
export function makeCompositeVerifier(
  verifiers: Verifier[],
  opts: CompositeOpts = {},
): Verifier {
  if (!Array.isArray(verifiers) || verifiers.length === 0) {
    throw new Error('makeCompositeVerifier: at least one verifier is required');
  }
  const mode: CompositeMode = opts.mode ?? 'all';
  const threshold = opts.threshold ?? 0.5;

  let normalisedWeights: number[] | undefined;
  if (mode === 'weighted') {
    if (!opts.weights || opts.weights.length !== verifiers.length) {
      throw new Error('makeCompositeVerifier: weighted mode requires weights of the same length as verifiers');
    }
    if (opts.weights.some((w) => w < 0 || !Number.isFinite(w))) {
      // A negative or NaN weight would sneak past the sum-positive guard
      // (e.g. [-1, 2] sums to 1, passes, then normalises to [-1, 2]) and
      // produce out-of-range scores the [0,1] clamp would silently hide.
      throw new Error('makeCompositeVerifier: weighted mode requires non-negative finite weights');
    }
    const sum = opts.weights.reduce((acc, w) => acc + w, 0);
    if (sum <= 0) {
      throw new Error('makeCompositeVerifier: weighted mode requires a positive weight sum');
    }
    normalisedWeights = opts.weights.map((w) => w / sum);
  }

  return async function composite(candidate, request) {
    const results: SubResult[] = [];
    for (let i = 0; i < verifiers.length; i++) {
      try {
        const verdict = await verifiers[i]!(candidate, request);
        results.push({ idx: i, score: verdict.score, reason: verdict.reason });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ verifierIdx: i, err: msg }, 'composite: sub-verifier threw');
        results.push({ idx: i, score: 0.0, reason: `verifier ${i} threw: ${msg}` });
      }
    }

    if (mode === 'all') return reduceAll(results, threshold);
    if (mode === 'any') return reduceAny(results, threshold);
    return reduceWeighted(results, normalisedWeights!, threshold);
  };
}

/**
 * Join the reasons of every sub-verifier whose score sits below
 * threshold. Empty input means no failures to surface — composite
 * returns no reason in that case.
 */
function joinReasons(results: SubResult[], threshold: number): string | undefined {
  const failed = results.filter((r) => r.score < threshold && r.reason);
  if (failed.length === 0) return undefined;
  return failed.map((r) => `[v${r.idx}] ${r.reason}`).join('; ');
}

function reduceAll(results: SubResult[], threshold: number): VerifierResult {
  // Min score — every judge must accept.
  const min = results.reduce((acc, r) => Math.min(acc, r.score), 1.0);
  const reason = joinReasons(results, threshold);
  return reason ? { score: min, reason } : { score: min };
}

function reduceAny(results: SubResult[], threshold: number): VerifierResult {
  // Max score — any one judge accepting is enough.
  const max = results.reduce((acc, r) => Math.max(acc, r.score), 0.0);
  // Only surface reasons when EVERY judge rejected; otherwise an
  // accepted candidate gets a noisy Reflexion entry.
  const anyPassed = results.some((r) => r.score >= threshold);
  if (anyPassed) return { score: max };
  const reason = joinReasons(results, threshold);
  return reason ? { score: max, reason } : { score: max };
}

function reduceWeighted(
  results: SubResult[],
  weights: number[],
  threshold: number,
): VerifierResult {
  let sum = 0;
  for (let i = 0; i < results.length; i++) {
    sum += results[i]!.score * weights[i]!;
  }
  // Defensive clamp; with non-negative normalised weights and scores in
  // [0,1] this should never fire — a fired clamp would mean someone
  // bypassed the construction-time weight guard.
  const score = Math.max(0, Math.min(1, sum));
  const reason = joinReasons(results, threshold);
  return reason ? { score, reason } : { score };
}
