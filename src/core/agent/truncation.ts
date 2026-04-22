/**
 * @file truncation.ts
 * @description Conversation history truncation to stay within token budgets.
 *
 * Based on Codex's truncation_policy: {mode: "tokens", limit: 10000}.
 * Supports three modes:
 *   - 'none'     — pass-through, no changes
 *   - 'messages' — keep first (system) + last N messages
 *   - 'tokens'   — estimate token count via char length, trim from the middle
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:truncation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Controls how conversation history is trimmed before an LLM call. */
export interface TruncationPolicy {
  /** Algorithm to use when trimming messages. */
  mode: 'tokens' | 'messages' | 'none';
  /**
   * Upper bound for the selected mode.
   * tokens mode   → approximate token limit (1 token ≈ 4 chars)
   * messages mode → maximum number of non-system messages to retain
   */
  limit: number;
}

/** A minimal message shape handled by truncation. */
export interface TruncatableMessage {
  role: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default policy: token-based with a 10 000-token budget. */
export const DEFAULT_POLICY: TruncationPolicy = { mode: 'tokens', limit: 10_000 };

/**
 * Approximate character-to-token conversion.
 * Matches the common heuristic used by OpenAI and Anthropic (1 token ≈ 4 chars).
 */
const CHARS_PER_TOKEN = 4 as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate token count for a single message. */
function estimateTokens(msg: TruncatableMessage): number {
  return Math.ceil(msg.content.length / CHARS_PER_TOKEN);
}

/** Return the system message if messages[0] has role 'system', else undefined. */
function extractSystem(
  messages: TruncatableMessage[],
): TruncatableMessage | undefined {
  return messages[0]?.role === 'system' ? messages[0] : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Truncate a conversation history array to fit within the policy budget.
 *
 * Behaviour by mode:
 *
 * `none` — returns the original array unchanged.
 *
 * `messages` — keeps the system message (if present) plus the last
 *   `policy.limit` non-system messages.
 *
 * `tokens` — converts `policy.limit` tokens to an approximate character
 *   limit, always retains the system message, then adds messages from the
 *   end of the history until the budget is exhausted.
 *
 * @param messages - Ordered conversation messages (system first, if any).
 * @param policy   - Truncation policy to apply. Defaults to DEFAULT_POLICY.
 * @returns Truncated message array (never mutates the input).
 */
export function truncateMessages(
  messages: TruncatableMessage[],
  policy: TruncationPolicy = DEFAULT_POLICY,
): TruncatableMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  if (policy.mode === 'none') {
    return messages;
  }

  if (policy.mode === 'messages') {
    // Keep system message (index 0) + last `limit` non-system messages.
    const systemMsg = extractSystem(messages);
    const rest = systemMsg ? messages.slice(1) : messages;

    if (rest.length <= policy.limit) return messages;

    const kept = systemMsg
      ? [systemMsg, ...rest.slice(-policy.limit)]
      : rest.slice(-policy.limit);

    log.debug(
      { original: messages.length, kept: kept.length, mode: 'messages', limit: policy.limit },
      'Messages truncated (messages mode)',
    );
    return kept;
  }

  // Token mode: always keep system message, then fill from the end.
  const charLimit = policy.limit * CHARS_PER_TOKEN;
  const systemMsg = extractSystem(messages);
  const rest = systemMsg ? messages.slice(1) : messages;

  let usedChars = systemMsg ? systemMsg.content.length : 0;
  const tail: TruncatableMessage[] = [];

  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i]!;
    const msgChars = msg.content.length;
    if (usedChars + msgChars > charLimit) break;
    tail.unshift(msg);
    usedChars += msgChars;
  }

  const kept = systemMsg ? [systemMsg, ...tail] : tail;

  const droppedCount = messages.length - kept.length;
  if (droppedCount > 0) {
    log.debug(
      {
        original: messages.length,
        kept: kept.length,
        dropped: droppedCount,
        usedChars,
        charLimit,
        estimatedTokens: Math.ceil(usedChars / CHARS_PER_TOKEN),
      },
      'Messages truncated (tokens mode)',
    );
  }

  return kept;
}

/**
 * Estimate the total token count for an array of messages.
 * Useful for deciding whether truncation is needed before calling the LLM.
 */
export function estimateMessageTokens(messages: TruncatableMessage[]): number {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}
