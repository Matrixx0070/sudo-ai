/**
 * Context management utilities for the agent loop.
 *
 * Provides token estimation and tool-result trimming to keep the conversation
 * within LLM context window limits before compaction is needed.
 */

import { createLogger } from '../shared/logger.js';
import { estimateTokens } from '../shared/utils.js';

const log = createLogger('agent:context');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum context size in tokens before compaction should be triggered. */
export const MAX_CONTEXT_TOKENS = 60_000 as const;

/**
 * Default per-result character cap when trimming tool outputs.
 * Prevents a single large tool result from dominating context.
 */
const DEFAULT_MAX_PER_RESULT = 4_000 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal message shape needed for context size estimation. */
interface MessageLike {
  content: string;
}

/** Shape of a message that may contain tool call result content. */
interface ToolMessage {
  role?: string;
  content?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Estimate the total context size of a message array in tokens.
 *
 * Uses the shared 4-chars-per-token heuristic. Iterates all messages and
 * sums content lengths. Non-string content fields are JSON-stringified before
 * estimation so structured tool results are accounted for correctly.
 *
 * @param messages - Array of objects with a `content` field.
 * @returns Estimated total token count across all messages.
 */
export function estimateContextSize(messages: Array<MessageLike>): number {
  if (!Array.isArray(messages)) {
    log.warn('estimateContextSize called with non-array; returning 0');
    return 0;
  }

  let total = 0;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const content = msg.content;
    if (typeof content === 'string') {
      total += estimateTokens(content);
    } else if (content !== null && content !== undefined) {
      // Structured content (arrays, objects from some providers).
      total += estimateTokens(JSON.stringify(content));
    }
  }

  log.debug({ messageCount: messages.length, estimatedTokens: total }, 'Context size estimated');
  return total;
}

/**
 * Trim tool-result messages in a conversation to prevent any single result
 * from consuming too much of the context window.
 *
 * Only messages with `role === 'tool'` are modified. Other roles are passed
 * through unchanged. Truncated content is suffixed with a notice so the LLM
 * understands data was cut.
 *
 * @param messages     - Full conversation message array (mutated in-place copy).
 * @param maxPerResult - Maximum characters per tool-result content field.
 * @returns New array with trimmed tool results.
 */
export function trimToolResults(
  messages: ToolMessage[],
  maxPerResult: number = DEFAULT_MAX_PER_RESULT,
): ToolMessage[] {
  if (!Array.isArray(messages)) {
    log.warn('trimToolResults called with non-array; returning []');
    return [];
  }

  if (maxPerResult <= 0) {
    log.warn({ maxPerResult }, 'trimToolResults: maxPerResult must be > 0; using default');
    maxPerResult = DEFAULT_MAX_PER_RESULT;
  }

  const trimNotice = '\n\n[...output truncated for context window...]';
  const effectiveMax = maxPerResult - trimNotice.length;

  let trimCount = 0;

  const result = messages.map((msg): ToolMessage => {
    if (msg?.role !== 'tool') return { ...msg };

    const content = msg.content;
    if (typeof content !== 'string' || content.length <= maxPerResult) {
      return { ...msg };
    }

    trimCount++;
    return {
      ...msg,
      content: content.slice(0, effectiveMax) + trimNotice,
    };
  });

  if (trimCount > 0) {
    log.info({ trimCount, maxPerResult }, 'Tool results trimmed to fit context window');
  }

  return result;
}

/**
 * Determine whether a context window is approaching capacity.
 *
 * Returns true when the estimated token count exceeds 80 % of the cap so
 * callers can proactively compact before hitting the hard limit.
 *
 * @param messages - Current conversation messages.
 * @returns True if compaction should be considered.
 */
export function shouldCompact(messages: Array<MessageLike>): boolean {
  const tokens = estimateContextSize(messages);
  const threshold = MAX_CONTEXT_TOKENS * 0.5;
  const needed = tokens >= threshold;

  if (needed) {
    log.info(
      { tokens, threshold, maxContextTokens: MAX_CONTEXT_TOKENS },
      'Context approaching limit — compaction recommended',
    );
  }

  return needed;
}
