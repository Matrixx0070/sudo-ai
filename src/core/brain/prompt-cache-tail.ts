/**
 * @file prompt-cache-tail.ts
 * @description BO2b/S1 — prompt-cache tail relocation (pure).
 *
 * brainRequestToIR (shadow.ts) folds EVERY role:'system' message into ir.system,
 * the cached prefix that precedes the whole conversation. So any per-turn system
 * content there (the workspace daily-log '## Today', AUTO-ROUTING routing hints,
 * consciousness deep insights, active commitments, skill activation) plus the
 * fresh-every-turn Recent-Memory + Date volatile block busts implicit-prefix
 * caching from that byte onward — through the ENTIRE conversation history.
 *
 * This function moves that per-turn context to the TAIL: it prepends the churning
 * blocks to the newest user message so the request's cacheable region becomes
 * [stable system prompt] + [append-only history]. The model still receives every
 * string — repositioned after the append-only history, never dropped.
 *
 * KEPT in the cached prefix (byte-stable turn-over-turn, so they stay cacheable):
 *   - _durable system messages (compaction summaries, session-fork handoffs =
 *     collapsed history — stable once written);
 *   - the session-stable memory blocks '## Yesterday' and '## Long-Term Memory'.
 *
 * Pure: never reads env, never mutates the input array. The caller owns gating.
 */

import type { BrainMessage } from './types.js';

/** A message carries `_durable` when it represents collapsed/persisted history. */
type MaybeDurable = { _durable?: boolean };

/**
 * Return a NEW message array with per-turn volatile context relocated to the tail
 * (prepended to the latest user message). `volatileTailBlock` is the Recent
 * Memory + Date block captured out of the system prompt (may be empty).
 *
 * When there is nothing to relocate, the input array is returned unchanged
 * (reference-equal), so callers can treat a no-op as byte-identical.
 */
export function relocateVolatileToTail(
  messages: BrainMessage[],
  volatileTailBlock: string,
): BrainMessage[] {
  const tailParts: string[] = [];
  const kept: BrainMessage[] = [];
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    const isPerTurnSystem =
      m.role === 'system' &&
      (m as MaybeDurable)._durable !== true &&
      content.trim() !== '';
    if (!isPerTurnSystem) {
      kept.push(m);
      continue;
    }
    // Session-stable memory blocks do not change turn-over-turn — keep them in
    // the cached prefix rather than re-sending them uncached every turn.
    if (content.startsWith('## Yesterday') || content.startsWith('## Long-Term Memory')) {
      kept.push(m);
      continue;
    }
    // Dedup: the workspace daily-log ('## Today') duplicates the system-prompt
    // Recent Memory already captured in volatileTailBlock — drop the duplicate so
    // the daily log is carried once (at the tail).
    const body = content.replace(/^##[^\n]*\n/, '');
    if (volatileTailBlock && body.length > 0 && volatileTailBlock.includes(body)) {
      continue;
    }
    tailParts.push(content);
  }
  if (volatileTailBlock) tailParts.push(volatileTailBlock);
  if (tailParts.length === 0) return messages;

  const tail = tailParts.join('\n\n');
  // Prepend to the latest user message (context BEFORE the question) rather than
  // inserting a separate message — keeps the message COUNT and role-alternation
  // identical to the original request (no two consecutive user turns, which some
  // providers reject), so only the newest user turn carries the fresh tail while
  // all prior history stays append-only.
  let lastUserIdx = -1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx >= 0) {
    const orig = kept[lastUserIdx]!;
    const origContent = typeof orig.content === 'string' ? orig.content : '';
    kept[lastUserIdx] = { ...orig, content: origContent ? `${tail}\n\n${origContent}` : tail };
  } else {
    kept.push({ role: 'user', content: tail });
  }
  return kept;
}
