/**
 * @file loop-fallback.ts
 * @description Build the user-facing reply when the AgentLoop's cross-iteration
 * LoopGuard fires AND the model produced no text content.
 *
 * Pre-2026-06-16, the canned fallback was a fixed string. When two or three
 * consecutive turns all hit this fallback path, the user saw the same
 * byte-identical reply each time, with no signal that the bot was in a
 * sustained loop (the WEAKEST POINT from the 2026-06-16 audit). This module
 * adds streak detection: each consecutive fallback bumps a "(N× in a row)"
 * counter so the user sees motion turn-over-turn even when the model is
 * stuck.
 *
 * Pure function — no IO, no logger. Easy to test.
 */

import type { BrainMessage } from '../brain/types.js';

/**
 * Plain-prose first hit. Kept stable so existing telemetry / dashboards that
 * count this exact line don't break. Streak text below uses a different
 * prefix so the two are distinguishable.
 */
export const LOOP_FALLBACK_FIRST_HIT =
  'I kept trying to use tools but got stuck in a loop. Here is what I know so far. Let me know if you need me to try a different approach.';

/** Streak prefix (must stay matchable by extractLoopStreak). */
const STREAK_PREFIX = "I'm stuck in the same tool-loop";

/** Match the streak number out of a previous streak message. */
const STREAK_NUMBER_RE = /\((\d+)× in a row\)/;

/**
 * Build the fallback reply text.
 * Looks back at the most recent assistant message in `messages`. If that
 * message was a LoopGuard fallback (first hit OR streak), this run is part
 * of a streak and the text is varied accordingly.
 */
export function buildLoopFallbackReply(messages: ReadonlyArray<BrainMessage>): string {
  const previousAssistant = findLastAssistantContent(messages);
  if (!previousAssistant) return LOOP_FALLBACK_FIRST_HIT;

  if (previousAssistant === LOOP_FALLBACK_FIRST_HIT) {
    return streakReply(2);
  }
  if (previousAssistant.startsWith(STREAK_PREFIX)) {
    return streakReply(extractLoopStreak(previousAssistant) + 1);
  }
  return LOOP_FALLBACK_FIRST_HIT;
}

/** Compose a streak reply at count N (>=2). */
function streakReply(n: number): string {
  return `${STREAK_PREFIX} (${n}× in a row). The same tools keep firing without progress — try /reset, or rephrase your question. Retrying the same prompt will keep hitting this loop.`;
}

/**
 * Read the streak count out of a streak-prefixed message. Returns 1 when no
 * count is parseable (defensive — treats unrecognised streak text as
 * "previous was a first hit" which conservatively bumps the next reply to 2).
 */
export function extractLoopStreak(text: string): number {
  const m = text.match(STREAK_NUMBER_RE);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Find the most recent assistant message's text content, or undefined. */
function findLastAssistantContent(
  messages: ReadonlyArray<BrainMessage>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0) {
      return m.content;
    }
  }
  return undefined;
}
