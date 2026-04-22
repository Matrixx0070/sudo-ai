/**
 * Effort-level resolution for SUDO-AI v5 agent runs.
 *
 * Reads the EFFORT_LEVELS preset table from shared constants and returns a
 * fully-typed, shallow-copied config object so callers can safely mutate
 * their local copy without affecting the frozen preset.
 */

import { EFFORT_LEVELS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EffortLevel = 'min' | 'low' | 'normal' | 'high' | 'max';
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';

export interface EffortConfig {
  maxSteps: number;
  temperature: number;
  reasoningLevel: ReasoningLevel;
  thinkingBudgetTokens: number;
  interleavedThinking: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve an effort level string into its concrete configuration object.
 *
 * @param level - One of 'min' | 'low' | 'normal' | 'high' | 'max'.
 *                Defaults to 'normal' when omitted or unrecognised.
 * @returns A shallow copy of the matching preset so callers can mutate freely.
 */
export function resolveEffort(level: EffortLevel = 'normal'): EffortConfig {
  const config = EFFORT_LEVELS[level];
  if (!config) {
    console.warn(`[effort] Unknown effort level "${level}", defaulting to normal`);
    return { ...EFFORT_LEVELS.normal };
  }
  return { ...config };
}
