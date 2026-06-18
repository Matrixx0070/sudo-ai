/**
 * @file types.ts
 * @description TypeScript interfaces for the counterfactual-engine subsystem.
 *
 * Pure declarations — no logic, no imports from other subsystems.
 * Duck-typed brain and episodic-memory interfaces allow loose coupling.
 */

// ---------------------------------------------------------------------------
// Counterfactual
// ---------------------------------------------------------------------------

/**
 * A counterfactual simulation record: what would have happened if a different
 * action had been taken during a recorded episode.
 */
export interface Counterfactual {
  /** Unique identifier (nanoid). */
  id: string;
  /** ID of the episode this counterfactual is derived from. */
  originalEpisodeId: string;
  /** The alternative action that was NOT taken. */
  alternativeAction: string;
  /** LLM-predicted outcome if the alternative action had been taken. */
  simulatedOutcome: string;
  /** What actually happened in the original episode. */
  actualOutcome: string;
  /** Assessment of delta: 'better', 'worse', or 'same'. */
  deltaAssessment: string;
  /** Lesson extracted from the comparison, or null if none identified. */
  lessonLearned: string | null;
  /** Confidence in the simulated outcome, 0..1. */
  confidence: number;
  /** ISO-8601 timestamp when this counterfactual was created. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Duck-typed dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal brain interface required by the counterfactual simulator.
 * Any object implementing this shape is accepted — no concrete import needed.
 */
export interface CFBrainLike {
  call(opts: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
    source?: string;
  }): Promise<{ content: string }>;
}

/**
 * Minimal episodic memory interface required by the counterfactual simulator.
 */
export interface CFEpisodicLike {
  getRecent(
    count: number,
  ): Array<{
    id: string;
    summary: string;
    outcome: string;
    significance: number;
    topic: string;
  }>;
  getBySignificance(
    count: number,
  ): Array<{
    id: string;
    summary: string;
    outcome: string;
    significance: number;
    topic: string;
  }>;
}
