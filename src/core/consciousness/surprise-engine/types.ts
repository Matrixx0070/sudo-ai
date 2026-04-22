/**
 * @file types.ts
 * @description Domain types for the surprise-engine module.
 *
 * SurpriseEvent is the primary domain object persisted to surprise_events.
 * The two duck-typed interfaces (WorldModelLike, EmotionalStateLike) allow
 * SurpriseEngine to accept collaborators without creating circular imports.
 */

// ---------------------------------------------------------------------------
// SurpriseEvent
// ---------------------------------------------------------------------------

/**
 * A recorded surprise event produced when an observed outcome deviates from
 * a prior prediction.  Magnitude is the absolute prediction-error 0..1.
 */
export interface SurpriseEvent {
  /** Unique identifier (nanoid). */
  id: string;
  /** ID of the world-model prediction that triggered this event. */
  predictionId: string;
  /** Absolute prediction error magnitude 0..1 (0 = no surprise). */
  magnitude: number;
  /**
   * Qualitative direction of the deviation:
   *  'better'    — matched and low error (pleasant surprise)
   *  'worse'     — unmatched with high prior confidence (painful surprise)
   *  'different' — everything else
   */
  direction: 'better' | 'worse' | 'different';
  /** Human-readable description of what happened vs what was predicted. */
  description: string;
  /**
   * Actions triggered as a consequence of this surprise event.
   * Empty array when magnitude is below the lowest threshold.
   */
  triggeredActions: string[];
  /** ISO-8601 timestamp when this event was recorded. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Duck-typed collaborators — used by SurpriseEngine to avoid circular deps
// ---------------------------------------------------------------------------

/**
 * Minimal world-model surface needed by SurpriseEngine.
 * Implemented by WorldModel (world-model/model.ts).
 *
 * The return value is intentionally loose (number | object) because
 * SurpriseEngine discards the return — only the side-effect matters.
 */
export interface WorldModelLike {
  /**
   * Record the actual outcome of a prediction and return the surprise
   * magnitude (absolute prediction error 0..1).
   */
  recordOutcome(
    id: string,
    actual: string,
    matched: boolean,
  ): number;
}

/**
 * Minimal emotional-state surface needed by SurpriseEngine.
 * Implemented by EmotionalState (emotional-memory/engine.ts or equivalent).
 */
export interface EmotionalStateLike {
  /** Nudge the emotional state based on the valence of a resolved outcome. */
  updateFromOutcome(outcome: 'positive' | 'negative' | 'neutral'): void;
}
