/**
 * @file types.ts
 * @description Local type definitions for the theory-of-mind subsystem.
 *
 * Kept separate from the parent consciousness/types.ts to avoid polluting the
 * top-level barrel and to prevent circular import chains when brain modules
 * import from this directory.
 */

// ---------------------------------------------------------------------------
// InteractionRecord
// ---------------------------------------------------------------------------

/**
 * A single recorded exchange between SUDO-AI and a user.
 * Persisted to user_interaction_log and used for model updates.
 */
export interface InteractionRecord {
  /** Platform-level user identifier. */
  userId: string;
  /** Raw message text received from the user. */
  message: string;
  /** AI response that was delivered. */
  response: string;
  /** Subjective quality outcome of this exchange. */
  outcome: 'positive' | 'negative' | 'neutral';
  /** Mood inferred from the message at processing time (optional). */
  inferredMood?: string;
}

// ---------------------------------------------------------------------------
// UserPrediction
// ---------------------------------------------------------------------------

/**
 * Forward-looking prediction about a user's current state.
 * Generated either via LLM inference or rule-based fallback.
 */
export interface UserPrediction {
  /** Predicted emotional mood (e.g. 'frustrated', 'curious', 'neutral'). */
  mood: string;
  /** Predicted user intent in natural language. */
  intent: string;
  /** Predicted urgency level clamped to [0, 1]. */
  urgency: number;
}

// ---------------------------------------------------------------------------
// MindReaderBrainLike
// ---------------------------------------------------------------------------

/**
 * Duck-typed brain interface used by TheoryOfMind for mood inference.
 *
 * Defined here rather than importing from a brain module to avoid circular
 * dependency chains: brain → consciousness → brain.
 *
 * Any brain implementation that provides a `call` method matching this
 * signature is compatible without needing to share a concrete class.
 */
export interface MindReaderBrainLike {
  /**
   * Send a message array to the LLM and return the content string.
   *
   * @param options.messages   - Chat-format messages (role + content).
   * @param options.maxTokens  - Optional token budget for the completion.
   * @param options.temperature - Optional sampling temperature.
   */
  call(options: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ content: string }>;
}
