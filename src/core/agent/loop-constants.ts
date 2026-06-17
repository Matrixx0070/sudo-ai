/**
 * @file loop-constants.ts
 * @description Compile-time constants consumed by AgentLoop.
 *
 * Extracted from loop.ts (refactor #230) so the orchestrator file shrinks
 * further. All values here are pure data — no logic, no imports of class
 * state. Behaviour delta: zero. Importers in agent/loop.ts and the new
 * loop-* helper modules all reach for the same values.
 */

import { MAX_AGENT_ITERATIONS } from '../shared/constants.js';
import type { AgentConfig } from './types.js';

// ---------------------------------------------------------------------------
// Confidence calibration — deterministic EpistemicTag → predicted confidence.
// CERTAIN=0.9, PROBABLE=0.7, CONJECTURE=0.4, UNKNOWN=0.2.
// Used to pair predicted confidence with observed tool-call outcome for Brier scoring.
// ---------------------------------------------------------------------------

export const EPISTEMIC_TAG_CONFIDENCE_MAP: Record<string, number> = {
  CERTAIN:    0.9,
  PROBABLE:   0.7,
  CONJECTURE: 0.4,
  UNKNOWN:    0.2,
} as const;

// ---------------------------------------------------------------------------
// Auto-plan / predictor / reasoning tunables
// ---------------------------------------------------------------------------

/** Theme 2 (auto-plan): max decomposed subtasks injected as a plan checklist. */
export const MAX_PLAN_STEPS = 8;
/** Theme 2 (auto-plan): max chars per subtask after sanitization (bloat + injection guard). */
export const MAX_PLAN_STEP_CHARS = 200;
/** Theme 2 heavy (GoalPlanner): skip strategy injection below this classification confidence. */
export const GOAL_PLANNER_MIN_CONFIDENCE = 0.5;
/** Predictor loop injection (opt-in): only inject anticipatory predictions at/above this confidence. */
export const PREDICTOR_MIN_CONFIDENCE = 0.8;
/** Predictor loop injection (opt-in): cap how many predictions are folded into one heads-up. */
export const MAX_PREDICTOR_INJECTED = 3;
/** Theme 2.2 (reasoning-summary): max recent tool actions folded into the summary. */
export const MAX_SUMMARY_ACTIONS = 20;
/** Theme 2 step-tracking: a plan step counts as "addressed" when at least this
 *  fraction of its content words (>=4 chars) appear in the turn's tool actions. */
export const PLAN_COVERAGE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: MAX_AGENT_ITERATIONS,
  timeout: 0,
};
