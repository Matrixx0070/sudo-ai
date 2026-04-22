/**
 * @file tool-quality.ts
 * @description ToolQualityScorer — per-tool quality scoring via Exponential Moving Average.
 *
 * Alpha = 0.3:  new observations have 30% weight, history retains 70%.
 * Scores stay in [0, 1].
 *
 * In-memory scores are initialised by syncing from feedback_memory on construction.
 * Callers should call syncFromDb() periodically (e.g. after each session) to pick
 * up records written by other processes.
 */

import { createLogger } from '../shared/logger.js';
import type { FeedbackMemory } from './feedback-memory.js';

const log = createLogger('self-improvement:tool-quality');

const EMA_ALPHA = 0.3;
const DEFAULT_SCORE = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  tool: string;
  score: number;
  totalUses: number;
}

/** Minimal interface required — allows passing a mock in tests. */
export interface FeedbackMemoryLike {
  getToolStats: () => Map<string, { tool: string; successes: number; failures: number; avgScore: number }>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ToolState {
  score: number;
  totalUses: number;
}

// ---------------------------------------------------------------------------
// ToolQualityScorer
// ---------------------------------------------------------------------------

export class ToolQualityScorer {
  private readonly feedbackMemory: FeedbackMemoryLike;
  private readonly scores = new Map<string, ToolState>();

  constructor(feedbackMemory: FeedbackMemoryLike) {
    if (!feedbackMemory) throw new TypeError('feedbackMemory is required');
    this.feedbackMemory = feedbackMemory;
    this.syncFromDb();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the current EMA quality score for a tool.
   * Returns DEFAULT_SCORE (0.5) if the tool has never been seen.
   *
   * @param toolName - Name of the tool to query.
   */
  getScore(toolName: string): number {
    if (!toolName) {
      log.warn('getScore called with empty toolName');
      return DEFAULT_SCORE;
    }
    return this.scores.get(toolName)?.score ?? DEFAULT_SCORE;
  }

  /**
   * Return all tools sorted by score descending.
   */
  getLeaderboard(): LeaderboardEntry[] {
    return [...this.scores.entries()]
      .map(([tool, state]) => ({
        tool,
        score: state.score,
        totalUses: state.totalUses,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Apply a single outcome observation to a tool's EMA score.
   * Updates the in-memory score immediately.
   *
   * @param toolName - Tool that ran.
   * @param success  - Whether the tool call succeeded.
   * @param score    - Optional explicit quality score in [0, 1]. Defaults to 1.0/0.0.
   */
  recordOutcome(toolName: string, success: boolean, score?: number): void {
    if (!toolName?.trim()) throw new Error('toolName must not be empty');

    const observation = score !== undefined
      ? Math.min(1, Math.max(0, score))
      : (success ? 1.0 : 0.0);

    const current = this.scores.get(toolName) ?? { score: DEFAULT_SCORE, totalUses: 0 };
    const newScore = EMA_ALPHA * observation + (1 - EMA_ALPHA) * current.score;

    this.scores.set(toolName, {
      score: newScore,
      totalUses: current.totalUses + 1,
    });

    log.debug(
      { tool: toolName, observation, prevScore: current.score, newScore },
      'Tool EMA score updated',
    );
  }

  /**
   * Reload in-memory scores from the feedback_memory table.
   * Existing in-memory scores are replaced by DB-derived EMA values.
   * Call this periodically to incorporate feedback written by other components.
   */
  syncFromDb(): void {
    try {
      const stats = this.feedbackMemory.getToolStats();
      let synced = 0;

      for (const [tool, stat] of stats.entries()) {
        const totalUses = stat.successes + stat.failures;
        if (totalUses === 0) continue;

        // Re-derive EMA from stored avgScore as an approximation
        const dbScore = Math.min(1, Math.max(0, stat.avgScore));
        const current = this.scores.get(tool);

        if (!current) {
          this.scores.set(tool, { score: dbScore, totalUses });
        } else {
          // Blend: weight existing in-memory EMA with DB average
          const blended = EMA_ALPHA * dbScore + (1 - EMA_ALPHA) * current.score;
          this.scores.set(tool, { score: blended, totalUses: Math.max(current.totalUses, totalUses) });
        }
        synced++;
      }

      log.debug({ toolCount: synced }, 'Tool quality scores synced from DB');
    } catch (err) {
      log.warn({ err: String(err) }, 'syncFromDb failed — keeping in-memory scores');
    }
  }
}
