/**
 * @file types.ts
 * @description Type declarations for the relationship-model subsystem.
 *
 * Relationship captures the evolving state of the AI's bond with a specific user.
 * RelEpisodeLike is a duck-typed interface for episodic-memory episodes.
 * ToMLike is a duck-typed interface for theory-of-mind, avoiding circular deps.
 */

import type { RelationshipStage, UserModel } from '../types.js';

// Re-export for downstream convenience
export type { RelationshipStage, UserModel };

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

/**
 * Full relationship record between the AI and a single user.
 * Persisted to the `relationships` table.
 */
export interface Relationship {
  /** Platform-level user identifier (primary key). */
  userId: string;
  /** Current relationship stage label. */
  stage: RelationshipStage;
  /** Direction of trust over recent interactions. */
  trustTrajectory: 'improving' | 'stable' | 'declining';
  /** Shared memories, references, and topics that define the relationship. */
  sharedReferences: string[];
  /** Free-form note on how communication has evolved over time. */
  communicationEvolution: string;
  /** Recurring callbacks, shorthand, and in-jokes only both parties understand. */
  insideJokes: string[];
  /** Summaries of past conflicts or friction episodes. */
  conflictHistory: string[];
  /** Total number of recorded interactions with this user. */
  totalInteractions: number;
  /** ISO-8601 timestamp of the very first interaction. */
  firstInteraction: string;
  /** ISO-8601 timestamp of the most recent interaction. */
  lastInteraction: string;
}

// ---------------------------------------------------------------------------
// RelEpisodeLike (duck-typed)
// ---------------------------------------------------------------------------

/**
 * Minimal episode shape required by RelationshipTracker.
 * Satisfied by the episodic-memory Episode type without a direct import.
 */
export interface RelEpisodeLike {
  /** Unique episode identifier. */
  id: string;
  /** Human-readable episode summary. */
  summary: string;
  /** Outcome valence of this interaction. */
  outcome: 'positive' | 'negative' | 'neutral' | 'mixed';
  /** Participant identifiers (user IDs or labels). */
  participants: string[];
  /** Topic or domain of this episode. */
  topic: string;
}

// ---------------------------------------------------------------------------
// ToMLike (duck-typed)
// ---------------------------------------------------------------------------

/**
 * Minimal interface the relationship tracker requires of theory-of-mind.
 * Satisfied by TheoryOfMind without creating a circular dependency.
 */
export interface ToMLike {
  /** Return the persisted UserModel for the given userId, or null if unknown. */
  getUserModel(userId: string): UserModel | null;
}
