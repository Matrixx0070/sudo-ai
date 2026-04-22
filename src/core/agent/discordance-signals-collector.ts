/**
 * @file agent/discordance-signals-collector.ts
 * @description Pure helper that builds a DiscordanceSignals object from the
 * current agent loop state. All fields fail-open to neutral zeros when data
 * is absent or malformed.
 *
 * Wave 6E — Primitive A (Builder A).
 */

import type { DiscordanceSignals } from '../security/discordance-detector.js';

// ---------------------------------------------------------------------------
// LoopState — minimal snapshot of agent loop state needed by the collector.
// Only the fields actually consumed are required; everything else is optional.
// ---------------------------------------------------------------------------

/** Subset of AgentState + transient loop-local data needed by the collector. */
export interface LoopState {
  /** Current tool-call iteration count from AgentState. */
  iteration: number;
  /** Names of the tool calls currently active / about to be dispatched. */
  activeToolNames?: string[];
  /** Recent outcome type strings (most-recent first). Optional — future expansion. */
  recentOutcomeTypes?: string[];
  /** Last assistant-generated text snippet. */
  lastAssistantText?: string;
}

// ---------------------------------------------------------------------------
// Baseline cadence reference (tool calls per window).
// Matches the value used in the spec's example call site.
// ---------------------------------------------------------------------------

const BASELINE_CALLS_PER_WINDOW = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `DiscordanceSignals` object from the current loop state.
 *
 * Fail-open: any missing or malformed field resolves to neutral zeros so that
 * the downstream `detectDiscordance()` call always receives a valid structure.
 *
 * Pure function — no I/O, no side effects, no exceptions thrown.
 */
export function collectDiscordanceSignals(state: LoopState): DiscordanceSignals {
  // Guard against completely undefined/null input.
  if (!state || typeof state !== 'object') {
    return neutralSignals();
  }

  // cadence — derive from iteration count.
  const callsInWindow = isFinitePositiveInt(state.iteration) ? state.iteration : 0;

  // toolGraph — recent tool names used in this turn.
  const recentToolNames = safeStringArray(state.activeToolNames);

  // outcomeTrend — future expansion placeholder; caller may pass recent outcomes.
  const recentOutcomeTypes = safeStringArray(state.recentOutcomeTypes);

  // selfReport — last assistant text; empty string is valid (neutral scorer output).
  const text = typeof state.lastAssistantText === 'string' ? state.lastAssistantText : '';

  return {
    cadence: { callsInWindow, baselineCallsPerWindow: BASELINE_CALLS_PER_WINDOW },
    toolGraph: { recentToolNames },
    outcomeTrend: { recentOutcomeTypes },
    selfReport: { text },
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function neutralSignals(): DiscordanceSignals {
  return {
    cadence: { callsInWindow: 0, baselineCallsPerWindow: BASELINE_CALLS_PER_WINDOW },
    toolGraph: { recentToolNames: [] },
    outcomeTrend: { recentOutcomeTypes: [] },
    selfReport: { text: '' },
  };
}

function isFinitePositiveInt(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= 0;
}

function safeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === 'string');
}
