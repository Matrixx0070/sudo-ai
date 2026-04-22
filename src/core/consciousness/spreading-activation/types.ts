/**
 * @file types.ts
 * @description Type declarations for the spreading-activation associative network.
 *
 * All types are pure declarations — no logic, no imports.
 */

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * A concept node in the associative network.
 * `id` is always lowercased. `activation` is clamped to [0, 1].
 */
export interface ConceptNode {
  /** Unique concept identifier — lowercased concept name. */
  id: string;
  /** Current activation level in [0, 1]. Decays over time. */
  activation: number;
  /** ISO-8601 timestamp of the most recent activation. */
  lastActivated: string;
  /** Cumulative count of times this node has been activated. */
  totalActivations: number;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * A directed, weighted edge between two concept nodes.
 * `weight` is clamped to [0, 1] and grows with co-occurrence.
 */
export interface ConceptEdge {
  /** Source concept ID. */
  fromId: string;
  /** Target concept ID. */
  toId: string;
  /** Association strength in [0, 1]. */
  weight: number;
  /** Number of times `fromId` and `toId` co-occurred. */
  cooccurrences: number;
}

// ---------------------------------------------------------------------------
// Activation result
// ---------------------------------------------------------------------------

/**
 * Summary returned by `SpreadingActivationNetwork.activate()`.
 */
export interface ActivationResult {
  /** Concept IDs that were directly activated in this call. */
  directlyActivated: string[];
  /** Neighbor concepts that received spread activation. */
  spreadTo: Array<{ concept: string; activation: number }>;
  /** Total number of concepts affected (direct + spread). */
  totalAffected: number;
}
