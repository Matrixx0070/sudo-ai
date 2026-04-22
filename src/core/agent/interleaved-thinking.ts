/**
 * Interleaved-thinking helpers for SUDO-AI v5 agent runs.
 *
 * Provides typed structures and factory utilities for the "thinking" content
 * blocks used by extended-reasoning-capable models, and a guard that decides
 * whether interleaved thinking should be activated for a given effort level.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  budgetTokens: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Construct a ThinkingBlock with a clamped token budget.
 *
 * The Anthropic extended-reasoning API requires the budget to be between
 * 256 and 65 536 tokens inclusive.  Values outside that range are silently
 * clamped so callers do not need to guard independently.
 *
 * @param prompt       - The reasoning prompt / scratchpad seed.
 * @param budgetTokens - Requested token budget (will be clamped to [256, 65536]).
 * @returns A well-formed ThinkingBlock ready to include in a message content array.
 */
export function buildThinkingBlock(prompt: string, budgetTokens: number): ThinkingBlock {
  return {
    type: 'thinking',
    thinking: prompt,
    budgetTokens: Math.max(256, Math.min(budgetTokens, 65536)),
  };
}

/**
 * Return true when the given effort level warrants interleaved thinking.
 *
 * Only 'high' and 'max' effort levels enable interleaved thinking — lower
 * levels use standard (non-interleaved) generation to keep latency and token
 * costs proportionate to the task complexity.
 *
 * @param effortLevel - Effort level string (e.g. 'normal', 'high', 'max').
 */
export function shouldUseInterleavedThinking(effortLevel: string): boolean {
  return effortLevel === 'high' || effortLevel === 'max';
}
