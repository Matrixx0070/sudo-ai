/**
 * @file fork-history.ts
 * @description Fork-mode history filtering for sub-agent context forking.
 *
 * When a parent conversation is forked into a sub-agent session, the
 * sub-agent should inherit the *conclusions* of the parent — not its
 * mechanical noise. The filter keeps:
 *   - system messages (instructions, injected context)
 *   - user messages   (the actual requests)
 *   - final-answer assistant messages (no tool calls attached)
 * and drops:
 *   - tool messages (tool results / denials)
 *   - intermediate assistant turns that triggered tool calls
 *
 * This mirrors Codex's fork-mode rollout filtering: the insight is the
 * design decision (what a sub-task needs to see), not the code.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal structural message shape the filter operates on.
 * Compatible with sessions' BrainMessage; `toolCalls` is attached ad hoc by
 * the agent loop on intermediate assistant turns (loop.ts) and is not part
 * of the declared BrainMessage type.
 */
export interface ForkableMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: unknown[];
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Filter a parent conversation history down to what a forked sub-agent
 * should inherit.
 *
 * @param messages - The parent session's message history (not mutated).
 * @returns A new array containing only system, user, and final-answer
 *   assistant messages, in original order.
 */
export function filterForkedHistory<T extends ForkableMessage>(messages: T[]): T[] {
  return messages.filter((m) => {
    if (m.role === 'system' || m.role === 'user') return true;
    if (m.role === 'assistant') {
      // Intermediate assistant turns carry a non-empty toolCalls array;
      // final answers are plain text.
      return !Array.isArray(m.toolCalls) || m.toolCalls.length === 0;
    }
    return false; // role === 'tool'
  });
}

/**
 * Seed a (sub-agent) session with the filtered fork of a parent history.
 * No-op when the session has no messages array.
 *
 * @param session     - Duck-typed session; messages are appended in place.
 * @param forkHistory - The parent history to filter and seed.
 * @returns Number of messages actually seeded after filtering.
 */
export function seedForkedHistory(
  session: { messages?: unknown },
  forkHistory: ForkableMessage[],
): number {
  if (!Array.isArray(session.messages)) return 0;
  const kept = filterForkedHistory(forkHistory);
  (session.messages as ForkableMessage[]).push(...kept);
  return kept.length;
}
