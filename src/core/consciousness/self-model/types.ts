/**
 * @file types.ts
 * @description Type declarations for the self-model subsystem of SUDO-AI v4.
 *
 * Pure declarations only — no logic, no runtime imports.
 * CapabilityAssessment is re-exported from the parent consciousness types
 * so consumers can import everything from this single module.
 */

export type { CapabilityAssessment } from '../types.js';

// ---------------------------------------------------------------------------
// PersonalityTrait
// ---------------------------------------------------------------------------

/**
 * A single observed personality trait value with provenance.
 * Multiple observations per trait are averaged to produce the effective value.
 */
export interface PersonalityTrait {
  /** Short label for the trait.  e.g. 'analytical', 'creative', 'cautious', 'direct' */
  trait: string;
  /** Strength of the trait in this observation, clamped to [0, 1]. */
  value: number;
  /** What triggered this observation.  e.g. 'episode_analysis', 'manual_override' */
  source: string;
  /** ISO-8601 timestamp when this observation was recorded. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// SelfSummary
// ---------------------------------------------------------------------------

import type { CapabilityAssessment } from '../types.js';

/**
 * A rolled-up snapshot of the AI's self-model, suitable for display and
 * for injection into system prompts.
 */
export interface SelfSummary {
  /** Domains where success_count > failure_count, sorted by confidence desc. */
  strengths: CapabilityAssessment[];
  /** Domains where failure_count > success_count, sorted by confidence asc. */
  weaknesses: CapabilityAssessment[];
  /** Domains whose trend is 'improving'. */
  growthAreas: CapabilityAssessment[];
  /** Map of trait name → average observed value over the last 30 days. */
  personalityTraits: Record<string, number>;
  /** Mean confidence across all tracked capability assessments (0..1). */
  overallConfidence: number;
}

// ---------------------------------------------------------------------------
// EpisodeLike
// ---------------------------------------------------------------------------

/**
 * Minimal duck-typed Episode shape consumed by the assessor.
 * Using a structural type avoids a circular import from episodic-memory.
 */
export interface EpisodeLike {
  /** Unique episode identifier. */
  id: string;
  /** Primary topic or domain label for the episode. */
  topic: string;
  /** Overall outcome classification. */
  outcome: 'positive' | 'negative' | 'neutral' | 'mixed';
  /** Retrieval weight / importance score, 0..1. */
  significance: number;
}
