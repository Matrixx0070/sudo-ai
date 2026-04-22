/**
 * @file types.ts
 * @description TypeScript types for the SUDO-AI learning / wisdom subsystem.
 *
 * Insights are structured lessons extracted from sessions, pipelines, and
 * analytics — things the agent should apply in future runs to improve
 * outcomes.
 */

/**
 * A single distilled lesson learned by SUDO-AI.
 *
 * Insights accumulate over time and are retrieved at the start of each task
 * to bias the agent toward known-good patterns.
 */
export interface Insight {
  /** Auto-incremented primary key */
  id: number;
  /**
   * Broad category describing the nature of the insight:
   *  - error        – how to avoid a past mistake
   *  - success      – what worked and should be repeated
   *  - pattern      – a recurring structural observation
   *  - optimization – a speed, cost, or quality improvement
   */
  category: 'error' | 'success' | 'pattern' | 'optimization';
  /**
   * Where this insight came from:
   *  - session    – extracted from a conversation
   *  - pipeline   – extracted from a pipeline run
   *  - analytics  – derived from video / metric data
   *  - user       – explicitly stated by the user
   */
  source: 'session' | 'pipeline' | 'analytics' | 'user';
  /** Free-text description of the insight. Keep it concrete and actionable. */
  insight: string;
  /**
   * Estimated confidence in this insight, 0..1.
   * Start at 0.5 for new insights; increase when they prove correct.
   */
  confidence: number;
  /** How many times this insight has been retrieved and applied to a task */
  appliedCount: number;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 timestamp of last update (confidence change, applied increment) */
  updatedAt: string;
}
