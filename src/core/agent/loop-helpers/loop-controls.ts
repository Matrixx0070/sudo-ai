/**
 * F103 loop-helpers decomposition — loop-level knobs: proactive session
 * message trimming and the GoalPlanner semantic per-run cap.
 *
 * Moved verbatim from the former monolithic src/core/agent/loop-helpers.ts.
 * See ../loop-helpers.ts (barrel) for the full submodule map.
 */

import { createLogger } from '../../shared/logger.js';
import type { AgentState } from '../types.js';
import type { SessionLike } from './types.js';

const log = createLogger('agent:loop');

// ---------------------------------------------------------------------------
// Proactive session message trimming
// ---------------------------------------------------------------------------

/** Maximum messages in session before proactive trimming. */
export const SESSION_MESSAGE_TRIM_THRESHOLD = 40 as const;
/** Number of non-system messages to keep after trimming. */
export const SESSION_MESSAGE_KEEP_COUNT = 20 as const;

/**
 * Proactively trim session.messages to prevent unbounded growth.
 *
 * Keeps all system messages + the last N non-system messages.
 * Called at the start of each agent loop iteration.
 *
 * @param session - Mutable session object.
 * @param state   - Current agent state (for logging).
 */
export function trimSessionMessages(
  session: SessionLike,
  state: AgentState,
): void {
  const messages = session.messages;
  if (!Array.isArray(messages) || messages.length <= SESSION_MESSAGE_TRIM_THRESHOLD) {
    return;
  }

  const systemMsgs = messages.filter((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
  const keptNonSystem = nonSystemMsgs.slice(-SESSION_MESSAGE_KEEP_COUNT);

  session.messages = [...systemMsgs, ...keptNonSystem];

  log.info(
    {
      sessionId: state.sessionId,
      totalMessages: messages.length,
      keptMessages: session.messages.length,
      droppedMessages: messages.length - session.messages.length,
    },
    'Proactive session message trim applied',
  );
}

// ---------------------------------------------------------------------------
// GoalPlanner semantic per-run cap (Theme 2 follow-up)
// ---------------------------------------------------------------------------

/**
 * Resolve the per-run cap on GoalPlanner semantic (brain.chat) planning calls
 * from the raw SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN value.
 *
 * Accepts ONLY a clean base-10 non-negative integer (surrounding whitespace is
 * trimmed). Anything else — unset, blank, signed ("+5"/"-1"), fractional ("2.9"),
 * hex ("0x10"), or other junk ("3x") — is treated as `undefined` (= no cap, the
 * pre-existing behavior). This is fail-open: a malformed value never changes
 * behavior and never crashes the turn. Strict parsing (rather than a lenient
 * `parseInt`) avoids the footgun where "0x10" would silently collapse to 0 and
 * thereby DISABLE semantic planning. A literal `0` is a valid cap meaning "no
 * semantic planning this run" (template only).
 *
 * @param raw - The raw env value (typically `process.env[...]`).
 * @returns The cap as a non-negative integer, or `undefined` for no cap.
 */
export function resolveSemanticPlanCap(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether a semantic plan is allowed given the resolved cap and the number of
 * semantic calls already made this run. An `undefined` cap means no limit.
 *
 * @param cap         - Resolved cap from {@link resolveSemanticPlanCap}.
 * @param usedThisRun - Count of semantic plans already run this turn.
 */
export function semanticPlanAllowed(cap: number | undefined, usedThisRun: number): boolean {
  return cap === undefined || usedThisRun < cap;
}
