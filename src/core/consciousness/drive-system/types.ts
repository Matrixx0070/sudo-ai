/**
 * @file types.ts
 * @description Type declarations for the drive-system subsystem.
 *
 * Drives are motivational impulses that shape the AI's behaviour by biasing
 * its system prompt and sampling temperature. Intensities are always [0, 1].
 *
 * Pure declarations only — no logic, no imports.
 */

import type { BodyState, EmotionTag } from '../types.js';

// Re-export upstream types used by consumers of this module
export type { BodyState, EmotionTag };

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

/**
 * A single computed motivational drive.
 * Intensity is clamped to [0, 1] by the drive-computer.
 */
export interface Drive {
  /** Canonical drive name (e.g. 'curiosity', 'rest', 'social'). */
  name: string;
  /** Current intensity in [0, 1]. Higher values mean stronger motivation. */
  intensity: number;
  /** Human-readable description of what satisfies this drive. */
  satisfiedBy: string;
  /** List of input factors that contributed most to this drive's intensity. */
  sources: string[];
}

// ---------------------------------------------------------------------------
// DriveComputeInput
// ---------------------------------------------------------------------------

/**
 * All signals required to compute the full drive vector for one cycle.
 * All numeric fields in [0, 1] unless otherwise noted.
 */
export interface DriveComputeInput {
  /** Current somatic state snapshot. */
  bodyState: BodyState;
  /** Active emotion tag intensities (partial — missing tags default to 0). */
  emotionalTags: Partial<Record<EmotionTag, number>>;
  /** Blended emotional intensity from the current valence reading. */
  emotionalIntensity: number;
  /** Average surprise magnitude from recent episodic memory (0 = none, 1 = max). */
  recentSurprise: number;
  /** Normalised recent interaction rate (0 = no interactions, 1 = constant). */
  recentInteractionRate: number;
  /** Average prediction confidence from the world-model (0 = uncertain, 1 = certain). */
  worldModelConfidence: number;
  /**
   * Ratio of capabilities that are currently on an 'improving' trend.
   * 0 = all declining, 1 = all improving.
   */
  selfModelImprovingRatio: number;
  /** Milliseconds elapsed since the last user interaction. */
  timeSinceLastInteractionMs: number;
}
