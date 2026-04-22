/**
 * @file types.ts
 * @description Type declarations for the temporal-self subsystem.
 *
 * SelfSnapshot captures a point-in-time view of the AI's self-model.
 * Aspiration represents a growth goal derived from weaknesses or growth areas.
 * SelfModelLike is a duck-typed interface satisfied by SelfModel.
 */

import type { EmotionTag, CapabilityAssessment } from '../types.js';

// Re-export to avoid consumers needing to import from parent types.
export type { EmotionTag };

// ---------------------------------------------------------------------------
// SelfSnapshot
// ---------------------------------------------------------------------------

/**
 * A frozen cross-section of the AI's capability and personality state,
 * persisted to self_snapshots for temporal comparison.
 */
export interface SelfSnapshot {
  /** Unique identifier (nanoid). */
  id: string;
  /** Map of capability domain → text level label (e.g. 'expert', 'developing'). */
  capabilities: Record<string, string>;
  /** Map of personality trait → numeric value 0..1. */
  personality: Record<string, number>;
  /** The dominant emotion at snapshot time. */
  dominantEmotion: EmotionTag;
  /** Active goal descriptions at snapshot time. */
  activeGoals: string[];
  /** ISO-8601 timestamp when the snapshot was taken. */
  snapshotAt: string;
}

// ---------------------------------------------------------------------------
// Aspiration
// ---------------------------------------------------------------------------

/**
 * A concrete growth intention derived from self-assessment weaknesses or
 * trend analysis.  Persisted to aspirations table.
 */
export interface Aspiration {
  /** Unique identifier (nanoid). */
  id: string;
  /** Human-readable description of the growth goal. */
  description: string;
  /** Current text-level label for the capability (e.g. 'developing'). */
  currentLevel: string;
  /** Target text-level label the AI aspires to reach (e.g. 'expert'). */
  targetLevel: string;
  /** Capability domain this aspiration targets. */
  domain: string;
  /** Human-readable estimated timeframe (e.g. '3 months'). */
  estimatedTimeframe: string;
  /** Lifecycle status of this aspiration. */
  status: 'active' | 'achieved' | 'abandoned';
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// SelfModelLike (duck-typed)
// ---------------------------------------------------------------------------

/**
 * Minimal interface that temporal-self requires of the self-model.
 * Satisfied by SelfModel without an explicit import creating a circular dep.
 */
export interface SelfModelLike {
  /** Return the top-N strongest capabilities. */
  getStrengths(count?: number): CapabilityAssessment[];
  /** Return the top-N weakest capabilities. */
  getWeaknesses(count?: number): CapabilityAssessment[];
  /** Return all capabilities with trend === 'improving'. */
  getGrowthAreas(): CapabilityAssessment[];
  /** Return average personality trait values keyed by trait name. */
  getPersonalityTraits(): Record<string, number>;
  /** Return overall mean confidence across all assessments. */
  getOverallConfidence(): number;
}
