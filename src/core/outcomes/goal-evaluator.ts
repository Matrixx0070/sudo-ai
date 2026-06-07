/**
 * @file goal-evaluator.ts
 * @description Evaluates whether a session achieved its stated goal.
 *
 * HeuristicGoalEvaluator: keyword + tool-ratio heuristic, no LLM call.
 * createGoalEvaluator: factory that selects evaluator based on env vars.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('outcomes:goal-evaluator');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The outcome classification for a goal evaluation. */
export type GoalOutcome = 'success' | 'failure' | 'partial';

/** Result produced by a goal evaluator. */
export interface GoalEvalResult {
  outcome: GoalOutcome;
  /** 0.0–1.0 confidence in the outcome classification. */
  confidence: number;
  /** Human-readable strings explaining the classification. */
  evidence: string[];
}

/** Context passed to the evaluator. */
export interface EvalContext {
  sessionId: string;
  goal: string;
  recentMessages: Array<{ role: string; content: string }>;
  toolSuccessCount: number;
  toolFailureCount: number;
}

/** Interface all goal evaluators must satisfy. */
export interface GoalEvaluator {
  evaluate(ctx: EvalContext): Promise<GoalEvalResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUCCESS_KEYWORDS = ['done', 'completed', 'finished', 'success'] as const;
const FAILURE_KEYWORDS = ['error', 'failed', 'cannot'] as const;
const SUCCESS_RATIO_THRESHOLD = 0.6;
const FAILURE_RATIO_THRESHOLD = 0.3;
const HEURISTIC_CONFIDENCE = 0.4;
const LAST_N_FOR_SUCCESS = 5;

// ---------------------------------------------------------------------------
// HeuristicGoalEvaluator
// ---------------------------------------------------------------------------

/**
 * Default evaluator using keyword matching and tool-success ratio.
 * Confidence is always 0.4 to signal honest uncertainty.
 *
 * Rules (evaluated in priority order):
 *   failure — tool ratio < 0.3 OR last message contains failure keyword
 *   success — last 5 messages contain a success keyword AND ratio >= 0.6
 *   partial  — everything else
 */
export class HeuristicGoalEvaluator implements GoalEvaluator {
  async evaluate(ctx: EvalContext): Promise<GoalEvalResult> {
    const { sessionId, recentMessages, toolSuccessCount, toolFailureCount } = ctx;

    const totalTools = toolSuccessCount + toolFailureCount;
    const toolRatio = totalTools === 0 ? 0 : toolSuccessCount / totalTools;

    const last5 = recentMessages.slice(-LAST_N_FOR_SUCCESS);
    const lastMsg = recentMessages[recentMessages.length - 1];
    const lastContent = lastMsg?.content?.toLowerCase() ?? '';

    const evidence: string[] = [];

    // Check failure conditions first (highest priority)
    const hasFailureKeyword = FAILURE_KEYWORDS.some((kw) =>
      lastContent.includes(kw),
    );
    const hasLowToolRatio = totalTools > 0 && toolRatio < FAILURE_RATIO_THRESHOLD;

    if (hasFailureKeyword) {
      evidence.push(`Last message contains failure keyword in: "${lastContent.slice(0, 80)}"`);
    }
    if (hasLowToolRatio) {
      evidence.push(
        `Tool success ratio ${toolRatio.toFixed(2)} is below failure threshold ${FAILURE_RATIO_THRESHOLD}` +
        ` (${toolSuccessCount}/${totalTools})`,
      );
    }
    if (totalTools === 0) {
      evidence.push('No tool calls recorded for this session');
    }

    if (hasFailureKeyword || hasLowToolRatio) {
      log.debug({ sessionId, toolRatio, hasFailureKeyword }, 'HeuristicGoalEvaluator: failure');
      return { outcome: 'failure', confidence: HEURISTIC_CONFIDENCE, evidence };
    }

    // Check success conditions
    const last5Content = last5.map((m) => m.content?.toLowerCase() ?? '').join(' ');
    const hasSuccessKeyword = SUCCESS_KEYWORDS.some((kw) =>
      last5Content.includes(kw),
    );
    const hasHighToolRatio = toolRatio >= SUCCESS_RATIO_THRESHOLD;

    if (hasSuccessKeyword) {
      evidence.push(`Success keyword found in last ${LAST_N_FOR_SUCCESS} messages`);
    }
    if (hasHighToolRatio && totalTools > 0) {
      evidence.push(
        `Tool success ratio ${toolRatio.toFixed(2)} meets success threshold ${SUCCESS_RATIO_THRESHOLD}` +
        ` (${toolSuccessCount}/${totalTools})`,
      );
    }

    if (hasSuccessKeyword && hasHighToolRatio) {
      log.debug({ sessionId, toolRatio, hasSuccessKeyword }, 'HeuristicGoalEvaluator: success');
      return { outcome: 'success', confidence: HEURISTIC_CONFIDENCE, evidence };
    }

    // Partial otherwise
    evidence.push('Could not conclusively determine success or failure');
    log.debug({ sessionId, toolRatio, hasSuccessKeyword }, 'HeuristicGoalEvaluator: partial');
    return { outcome: 'partial', confidence: HEURISTIC_CONFIDENCE, evidence };
  }
}

// ---------------------------------------------------------------------------
// LlmGoalEvaluator (stub for this wave)
// ---------------------------------------------------------------------------

/**
 * Stub LLM-backed evaluator. Logs intent and delegates to heuristic.
 * A real implementation will call the configured model in a future wave.
 */
class LlmGoalEvaluator implements GoalEvaluator {
  private readonly heuristic = new HeuristicGoalEvaluator();

  async evaluate(ctx: EvalContext): Promise<GoalEvalResult> {
    log.info(
      { sessionId: ctx.sessionId, model: process.env['SUDO_GOAL_EVAL_MODEL'] },
      'LlmGoalEvaluator: LLM evaluation not yet implemented — delegating to heuristic',
    );
    return this.heuristic.evaluate(ctx);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a GoalEvaluator appropriate for the current environment.
 *
 * When SUDO_GOAL_EVAL_MODEL=haiku, returns LlmGoalEvaluator (stub).
 * Any other value or absent env var returns HeuristicGoalEvaluator.
 */
export function createGoalEvaluator(): GoalEvaluator {
  const model = process.env['SUDO_GOAL_EVAL_MODEL'];
  if (model === 'haiku') {
    log.info({ model }, 'createGoalEvaluator: using LlmGoalEvaluator (stub)');
    return new LlmGoalEvaluator();
  }
  log.debug({}, 'createGoalEvaluator: using HeuristicGoalEvaluator');
  return new HeuristicGoalEvaluator();
}
