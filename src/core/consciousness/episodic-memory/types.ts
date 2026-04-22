/**
 * @file types.ts
 * @description TypeScript interfaces for the episodic-memory subsystem.
 *
 * Pure declarations — no logic, no side effects.
 * Import EmotionTag and EmotionalValence from the parent consciousness types.
 */

import type { EmotionTag, EmotionalValence } from '../types.js';

// Re-export for consumers that only import from this module.
export type { EmotionTag, EmotionalValence };

// ---------------------------------------------------------------------------
// Episode
// ---------------------------------------------------------------------------

/**
 * A complete record of a discrete interaction episode.
 * Stored in the `episodes` table of consciousness.db.
 */
export interface Episode {
  /** Unique identifier (nanoid). */
  id: string;
  /** Short natural-language summary of what occurred. */
  summary: string;
  /** User IDs or agent names that participated. */
  participants: string[];
  /** Primary topic or domain of the episode. */
  topic: string;
  /** Keyword tags extracted from the episode. */
  tags: string[];
  /** Emotional state at the end of the episode. */
  emotionalValence: EmotionalValence;
  /** How surprising the episode was, 0..1. */
  surpriseLevel: number;
  /** Overall outcome classification. */
  outcome: 'positive' | 'negative' | 'neutral' | 'mixed';
  /** Retrieval weight / importance score, 0..1. Higher = more significant. */
  significance: number;
  /** Optional session identifier linking episodes to a broader conversation. */
  sessionId: string | null;
  /** ISO-8601 timestamp when the episode started. */
  startedAt: string;
  /** ISO-8601 timestamp when the episode ended. */
  endedAt: string;
  /** Wall-clock duration of the episode in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// EpisodeQuery
// ---------------------------------------------------------------------------

/**
 * Filter parameters accepted by `queryEpisodes`.
 * All fields are optional — omitting all fields returns everything (up to limit).
 */
export interface EpisodeQuery {
  /** Filter episodes whose startedAt / endedAt falls within this range. */
  timeRange?: { start: string; end: string };
  /** Filter by a dominant or contributing emotion tag. */
  emotion?: EmotionTag;
  /** Filter by participant name/ID (partial match). */
  participant?: string;
  /** Filter by topic (partial match). */
  topic?: string;
  /** Only return episodes with significance >= this value. */
  minSignificance?: number;
  /** Filter by exact outcome value. */
  outcome?: Episode['outcome'];
  /** Maximum number of results to return (default 50). */
  limit?: number;
}
