/**
 * BrainCompletion — the subset of a resolved generateText result that Brain's
 * `_callSingleModel` consumes. Extracted from brain.ts (F103 mechanical slimming).
 */

// generateText is imported ONLY for its result type (BrainCompletion below);
// no ai-SDK wire call remains in brain (F97 — the IR transport owns the wire).
import { generateText } from 'ai';

/**
 * The subset of a resolved generateText result that `_callSingleModel` consumes.
 * A full generateText result is structurally assignable to this; the streaming
 * path (`_completeOnce` for claude-oauth) reconstructs it from streamText's
 * aggregate promises. `reasoning`/`providerMetadata` stay `unknown` because the
 * downstream code already accesses them through casts and tolerates absence.
 */
export type BrainCompletion = {
  text: Awaited<ReturnType<typeof generateText>>['text'];
  toolCalls: Awaited<ReturnType<typeof generateText>>['toolCalls'];
  usage: Awaited<ReturnType<typeof generateText>>['usage'];
  finishReason: Awaited<ReturnType<typeof generateText>>['finishReason'];
  reasoning: unknown;
  reasoningText: string | undefined;
  providerMetadata: unknown;
};
