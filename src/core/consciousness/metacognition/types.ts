/**
 * @file types.ts
 * @description TypeScript interfaces for the metacognition subsystem.
 *
 * Pure declarations — no logic, no side effects.
 * Duck-typed brain and episodic-memory interfaces allow loose coupling.
 */

// ---------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------

/**
 * A metacognitive reflection record produced by examining a past episode.
 * Stored in the `reflections` table of consciousness.db.
 */
export interface Reflection {
  /** Unique identifier (nanoid). */
  id: string;
  /** ID of the episode this reflection is about. */
  subjectEpisodeId: string;
  /** The reflective question that prompted this analysis. */
  question: string;
  /** Multi-sentence analysis of the episode reasoning and outcome. */
  analysis: string;
  /** Single-sentence conclusion drawn from the analysis. */
  conclusion: string;
  /** Optional next-step action item, or null if not applicable. */
  actionItem: string | null;
  /** Self-assessed quality of this reflection, 0..1. */
  qualityScore: number;
  /** ISO-8601 timestamp when this reflection was created. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Duck-typed dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal brain interface required by the reflector.
 * Any object implementing this shape is accepted — no concrete import needed.
 */
export interface MetaBrainLike {
  call(opts: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
    source?: string;
  }): Promise<{ content: string }>;
}

/**
 * Minimal episodic memory interface required by the reflector.
 */
export interface MetaEpisodicLike {
  getRecent(
    count: number,
  ): Array<{
    id: string;
    summary: string;
    outcome: string;
    significance: number;
  }>;
  getBySignificance(
    count: number,
  ): Array<{
    id: string;
    summary: string;
    outcome: string;
    significance: number;
  }>;
}
