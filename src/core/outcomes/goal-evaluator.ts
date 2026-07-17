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
// LlmGoalEvaluator (F88 — real implementation, injected-caller seam)
// ---------------------------------------------------------------------------

/** Injected LLM caller — keeps core/outcomes free of heavy brain imports.
 *  Takes a prompt, returns the model's raw text reply. */
export type GoalEvalLlmCall = (prompt: string) => Promise<string>;

const LLM_EVAL_MAX_MSG_CHARS = 400;
const LLM_EVAL_MAX_MESSAGES = 8;
const LLM_EVAL_MIN_CONFIDENCE = 0;
const LLM_EVAL_MAX_CONFIDENCE = 1;

/**
 * F88: real LLM-backed evaluator. Builds a compact transcript summary,
 * requests a strict-JSON verdict, validates it, and FALLS BACK to the
 * heuristic (with honest evidence) on any call/parse/validation failure.
 * Cost is bounded: truncated transcript in, small completion out.
 */
export class LlmGoalEvaluator implements GoalEvaluator {
  private readonly heuristic = new HeuristicGoalEvaluator();
  private readonly llmCall: GoalEvalLlmCall;

  constructor(llmCall: GoalEvalLlmCall) {
    this.llmCall = llmCall;
  }

  private buildPrompt(ctx: EvalContext): string {
    const msgs = ctx.recentMessages
      .slice(-LLM_EVAL_MAX_MESSAGES)
      .map((m) => `${m.role}: ${(m.content ?? '').slice(0, LLM_EVAL_MAX_MSG_CHARS)}`)
      .join('\n');
    return [
      'You judge whether an AI agent session achieved its stated goal.',
      'Reply with ONLY a JSON object, no prose, no code fences:',
      '{"outcome":"success"|"failure"|"partial","confidence":0.0-1.0,"evidence":["short reason", ...]}',
      '',
      `Goal: ${ctx.goal || '(none recorded)'}`,
      `Tool calls: ${ctx.toolSuccessCount} succeeded, ${ctx.toolFailureCount} failed.`,
      'Recent messages (truncated):',
      msgs || '(none)',
    ].join('\n');
  }

  private parseVerdict(raw: string): GoalEvalResult | null {
    // Tolerate accidental fencing/prose by extracting the first {...} block.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    const outcome = v['outcome'];
    if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial') return null;
    const confRaw = typeof v['confidence'] === 'number' ? v['confidence'] : NaN;
    if (!Number.isFinite(confRaw)) return null;
    const confidence = Math.min(LLM_EVAL_MAX_CONFIDENCE, Math.max(LLM_EVAL_MIN_CONFIDENCE, confRaw));
    const evidence = Array.isArray(v['evidence'])
      ? v['evidence'].filter((e): e is string => typeof e === 'string').slice(0, 10)
      : [];
    return { outcome, confidence, evidence };
  }

  async evaluate(ctx: EvalContext): Promise<GoalEvalResult> {
    try {
      const raw = await this.llmCall(this.buildPrompt(ctx));
      const verdict = this.parseVerdict(raw);
      if (verdict) {
        log.debug({ sessionId: ctx.sessionId, outcome: verdict.outcome }, 'LlmGoalEvaluator: verdict');
        return verdict;
      }
      log.warn({ sessionId: ctx.sessionId, rawPreview: raw.slice(0, 120) }, 'LlmGoalEvaluator: unparseable reply — falling back to heuristic');
    } catch (err) {
      log.warn({ sessionId: ctx.sessionId, err: String(err) }, 'LlmGoalEvaluator: call failed — falling back to heuristic');
    }
    const fallback = await this.heuristic.evaluate(ctx);
    fallback.evidence.push('LLM evaluation unavailable — heuristic fallback');
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a GoalEvaluator appropriate for the current environment.
 *
 * SUDO_GOAL_EVAL_MODEL set (e.g. 'haiku') AND an llmCall injected →
 * LlmGoalEvaluator. Model set but no caller → heuristic with a warning
 * (the wiring site did not provide the seam). Otherwise heuristic.
 */
export function createGoalEvaluator(llmCall?: GoalEvalLlmCall): GoalEvaluator {
  const model = process.env['SUDO_GOAL_EVAL_MODEL'];
  if (model) {
    if (llmCall) {
      log.info({ model }, 'createGoalEvaluator: using LlmGoalEvaluator');
      return new LlmGoalEvaluator(llmCall);
    }
    log.warn({ model }, 'createGoalEvaluator: SUDO_GOAL_EVAL_MODEL set but no llmCall injected — using heuristic');
  }
  log.debug({}, 'createGoalEvaluator: using HeuristicGoalEvaluator');
  return new HeuristicGoalEvaluator();
}
