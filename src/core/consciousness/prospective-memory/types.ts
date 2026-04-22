/**
 * @file types.ts
 * @description Type declarations for the prospective-memory subsystem.
 *
 * Prospective memory allows SUDO-AI to form intentions that fire when a
 * specific temporal or contextual trigger condition is met.
 *
 * Pure declarations only — no logic, no imports.
 */

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/**
 * A persisted intention that the system will act on when its trigger fires.
 */
export interface Intention {
  /** Unique identifier (nanoid). */
  id: string;
  /** Natural-language description of what to do when triggered. */
  description: string;
  /** Category of condition that will fire this intention. */
  triggerType: 'time' | 'context' | 'person' | 'topic';
  /**
   * The exact value to match against the trigger type:
   * - 'time'    → ISO-8601 datetime string
   * - 'context' → keyword substring
   * - 'person'  → userId string
   * - 'topic'   → topic keyword substring
   */
  triggerCondition: string;
  /** Lifecycle status of the intention. */
  status: 'pending' | 'triggered' | 'completed' | 'expired';
  /** ISO-8601 timestamp when the intention was created. */
  createdAt: string;
  /** ISO-8601 timestamp when the trigger first fired; null until triggered. */
  triggeredAt: string | null;
  /** ISO-8601 timestamp when the intention was marked complete; null until done. */
  completedAt: string | null;
  /** ISO-8601 timestamp after which the intention auto-expires; null = no expiry. */
  expiresAt: string | null;
  /** Optional reference to the episodic memory that spawned this intention. */
  sourceEpisodeId: string | null;
}

// ---------------------------------------------------------------------------
// Input / context types
// ---------------------------------------------------------------------------

/**
 * Caller-supplied fields when creating a new intention.
 * `id`, `status`, `createdAt`, `triggeredAt`, and `completedAt` are generated
 * internally and must not be provided by callers.
 */
export interface IntentionInput {
  /** Natural-language description of the action to take. */
  description: string;
  /** Category of the trigger condition. */
  triggerType: Intention['triggerType'];
  /** The specific value to match (datetime, keyword, userId, or topic). */
  triggerCondition: string;
  /** Optional expiry — ISO-8601 datetime string. */
  expiresAt?: string;
  /** Optional back-reference to a source episode. */
  sourceEpisodeId?: string;
}

/**
 * Contextual snapshot passed to the trigger-matcher on each evaluation cycle.
 * The matcher compares each pending intention's condition against these fields.
 */
export interface TriggerContext {
  /** Current wall-clock time as ISO-8601 string (used for 'time' triggers). */
  time: string;
  /** Active user ID, if any (used for 'person' triggers). */
  userId?: string;
  /** Current conversation topic, if known (used for 'topic' triggers). */
  topic?: string;
  /** Raw message text from the current turn (used for 'context' and 'topic' triggers). */
  message?: string;
}
