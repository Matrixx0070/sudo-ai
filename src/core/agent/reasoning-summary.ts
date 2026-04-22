/**
 * @file reasoning-summary.ts
 * @description Reasoning transparency layer — surfaces what the agent was thinking.
 *
 * Inspired by Codex's reasoning_summary_format: "experimental".
 * Builds a structured summary from the agent's action log so the user
 * can understand the steps taken and the agent's confidence level.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:reasoning-summary');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single recorded agent action (tool call + result). */
export interface AgentAction {
  /** Tool name that was called. */
  tool: string;
  /** Stringified result returned by the tool. */
  result: string;
  /** ISO-8601 timestamp of when the action completed. */
  timestamp: string;
}

/** Structured summary of the agent's reasoning process. */
export interface ReasoningSummary {
  /** High-level description of the approach. */
  approach: string;
  /** Human-readable labels for each completed step (capped at 100 chars each). */
  stepsCompleted: string[];
  /** Label for the most recently completed step. */
  currentStep: string;
  /** Agent's confidence in its progress. Derived from step count heuristic. */
  confidence: 'low' | 'medium' | 'high';
  /** Alternative approaches that were considered but not taken. */
  alternativesConsidered?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters kept from a tool result when building step labels. */
const MAX_RESULT_CHARS = 100 as const;

/** Maximum characters kept from the task description in the approach field. */
const MAX_TASK_CHARS = 100 as const;

/** Step count thresholds for confidence bands. */
const CONFIDENCE_HIGH_THRESHOLD = 5 as const;
const CONFIDENCE_MEDIUM_THRESHOLD = 2 as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a step count to a confidence band.
 * More steps completed → higher confidence (agent has gathered more evidence).
 */
function deriveConfidence(stepCount: number): 'low' | 'medium' | 'high' {
  if (stepCount >= CONFIDENCE_HIGH_THRESHOLD) return 'high';
  if (stepCount >= CONFIDENCE_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a {@link ReasoningSummary} from the agent's accumulated action log.
 *
 * @param actions - Ordered list of tool calls the agent has completed so far.
 * @param task    - The original task/goal description given to the agent.
 * @returns A structured summary suitable for display or logging.
 */
export function buildReasoningSummary(
  actions: AgentAction[],
  task: string,
): ReasoningSummary {
  if (!Array.isArray(actions)) {
    log.warn({ task }, 'buildReasoningSummary: actions must be an array — returning empty summary');
    actions = [];
  }

  const safeTask = typeof task === 'string' ? task : String(task ?? '');

  const steps = actions.map(
    (a) => `${a.tool}: ${a.result.substring(0, MAX_RESULT_CHARS)}`,
  );

  const currentStep = steps.length > 0 ? steps[steps.length - 1]! : 'Starting...';

  const summary: ReasoningSummary = {
    approach: `Solving: ${safeTask.substring(0, MAX_TASK_CHARS)}`,
    stepsCompleted: steps,
    currentStep,
    confidence: deriveConfidence(steps.length),
  };

  log.debug(
    { stepCount: steps.length, confidence: summary.confidence, task: safeTask.substring(0, 60) },
    'Reasoning summary built',
  );

  return summary;
}

/**
 * Format a {@link ReasoningSummary} as a human-readable markdown string.
 *
 * Only the last 5 completed steps are shown to keep output concise.
 *
 * @param summary - The reasoning summary to format.
 * @returns Multi-line markdown string.
 */
export function formatReasoningSummary(summary: ReasoningSummary): string {
  if (!summary || typeof summary !== 'object') {
    log.warn('formatReasoningSummary: invalid summary object');
    return '';
  }

  const recentSteps = summary.stepsCompleted.slice(-5);

  const lines: string[] = [
    `**Approach:** ${summary.approach}`,
    `**Confidence:** ${summary.confidence}`,
    `**Steps (${summary.stepsCompleted.length}):**`,
    ...recentSteps.map((s, i) => `  ${i + 1}. ${s}`),
  ];

  if (summary.alternativesConsidered && summary.alternativesConsidered.length > 0) {
    lines.push(`**Alternatives considered:** ${summary.alternativesConsidered.join(', ')}`);
  }

  return lines.join('\n');
}
