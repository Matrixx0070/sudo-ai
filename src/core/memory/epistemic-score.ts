/**
 * @file memory/epistemic-score.ts
 * @description Epistemic ranking rider (Drive roadmap Phase 5) — the central
 * scoreMemory() used by retrieval paths:
 *
 *   score = similarity × trustWeight × freshnessDecay × validationState
 *
 * PURE math, deliberately placed in the memory subsystem: retrieval is on the
 * agent hot path and must never import core/gdrive (enforced by
 * tests/gdrive/hot-path.test.ts). Provenance metadata (trust tier, validation
 * state) is supplied by the caller; the gdrive beliefs layer builds an
 * adjuster from its graph and injects it as data, not as an import.
 */

export type EpistemicTrustTier = 'principal' | 'agent' | 'self_acquired' | 'external';

export type ValidationState = 'fresh' | 'due' | 'stale' | 'orphaned' | 'deprecated';

/** Spec defaults; override via the weights argument. */
export const DEFAULT_TRUST_WEIGHTS: Record<EpistemicTrustTier, number> = {
  principal: 1.0,
  agent: 0.9,
  self_acquired: 0.7,
  external: 0.5,
};

export const VALIDATION_MULTIPLIERS: Record<ValidationState, number> = {
  fresh: 1.0,
  due: 0.9,
  stale: 0.6,
  orphaned: 0.4,
  deprecated: 0.2,
};

export interface EpistemicMeta {
  trustTier?: EpistemicTrustTier;
  validationState?: ValidationState;
  /** Age in days for freshness decay (skip when the base score already decays). */
  ageDays?: number;
  halfLifeDays?: number;
}

/**
 * Multiply a similarity/base score by the epistemic factors. Missing metadata
 * contributes a neutral 1.0 — memories without provenance rank as before.
 */
export function scoreMemory(
  similarity: number,
  meta: EpistemicMeta,
  trustWeights: Record<EpistemicTrustTier, number> = DEFAULT_TRUST_WEIGHTS,
): number {
  let score = similarity;
  if (meta.trustTier) score *= trustWeights[meta.trustTier] ?? 1;
  if (meta.validationState) score *= VALIDATION_MULTIPLIERS[meta.validationState] ?? 1;
  if (meta.ageDays !== undefined && meta.ageDays > 0) {
    const halfLife = meta.halfLifeDays ?? 30;
    score *= Math.exp((-Math.LN2 / halfLife) * meta.ageDays);
  }
  return score;
}

/**
 * A per-chunk score adjuster retrieval hooks accept: given the chunk's
 * logical path and its base score, return the adjusted score. Built by the
 * provenance-aware layer; retrieval stays provenance-agnostic.
 */
export type EpistemicAdjuster = (chunkPath: string, baseScore: number) => number;
