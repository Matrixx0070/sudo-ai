/**
 * @file types.ts
 * @description Type definitions for the emotional-memory subsystem.
 *
 * SomaticMarker models a learned trigger→emotion association,
 * implementing the Damasio somatic marker hypothesis in rule-based form.
 */

import type { EmotionTag } from '../types.js';

// Re-export so consumers can import everything from this barrel.
export type { EmotionTag };

// ---------------------------------------------------------------------------
// SomaticMarker
// ---------------------------------------------------------------------------

/**
 * A persisted association between a text trigger pattern and an emotional
 * response. Intensity and hit-count are updated as the system encounters
 * the pattern across interactions.
 */
export interface SomaticMarker {
  /** Unique identifier (nanoid). */
  id: string;
  /** Plain-text keyword or phrase that activates this marker. */
  triggerPattern: string;
  /** The emotion this trigger reliably evokes. */
  emotion: EmotionTag;
  /** Response intensity 0..1. */
  intensity: number;
  /** Back-reference to the episodic memory that originally created this marker, if any. */
  associatedEpisodeId: string | null;
  /** Running count of how many times this marker has been activated. */
  timesTriggered: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}
