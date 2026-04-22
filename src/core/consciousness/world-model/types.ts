/**
 * @file types.ts
 * @description TypeScript interfaces for the world-model sub-module.
 *
 * WorldModelEntry represents a single forward-looking prediction stored in the
 * `world_model` table.  All fields map directly to the SQLite schema defined in
 * consciousness-db.ts.  No logic lives here — pure declarations only.
 */

// ---------------------------------------------------------------------------
// WorldModelEntry
// ---------------------------------------------------------------------------

/**
 * A single prediction entry in the world model.
 * Maps to one row in the `world_model` table (snake_case → camelCase).
 */
export interface WorldModelEntry {
  /** Unique identifier (nanoid). */
  id: string;
  /** Broad domain e.g. 'user_intent', 'task_outcome', 'system_state'. */
  domain: string;
  /** Natural-language prediction statement. */
  prediction: string;
  /** Confidence at time of prediction (0..1). */
  confidence: number;
  /** Number of evidence points that have updated this entry. */
  evidenceCount: number;
  /** ISO-8601 timestamp when the prediction was made. */
  madeAt: string;
  /** ISO-8601 expiry timestamp, or null for never-expiring entries. */
  expiresAt: string | null;
  /** ISO-8601 timestamp of the last validation check, or null. */
  lastValidated: string | null;
  /** Current resolution state of this prediction. */
  outcome: 'pending' | 'confirmed' | 'violated' | 'expired';
  /** What actually happened (populated on resolution), or null if pending. */
  actualResult: string | null;
}
