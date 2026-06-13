/**
 * @file microcompact.ts
 * @description Two-tier compaction TIER 1 — zero-cost, role-aware message
 * compaction (gap #14).
 *
 * The existing 3-layer compaction in loop-helpers.ts fires the LLM-based
 * `runCompaction` first (paid, slow) and only runs string-level microCompact
 * as a fallback. Claude Code's design is the opposite: TIER 1 zero-cost
 * trimming recovers 30-50% of the context window in the common case, and
 * TIER 2 LLM summarisation only fires when TIER 1 was not enough. This
 * module is the TIER 1 primitive; the wiring lives in loop-helpers.ts behind
 * SUDO_TWO_TIER_COMPACT=1.
 *
 * Role-aware behaviour:
 *
 *   - system / first user        — preserved unmodified (head-preserve count).
 *   - last N messages            — preserved unmodified (tail-preserve count).
 *   - middle `tool` messages     — clamped to the smallest cap (tool output is
 *                                  the biggest space hog in agentic flows; we
 *                                  keep a short prefix + suffix so diagnostic
 *                                  text and exit codes survive).
 *   - middle `assistant` / `user` — clamped only when content exceeds the role
 *                                   cap; small turns pass through untouched.
 *
 * The result preserves message COUNT and ORDER (no dropped messages) — the
 * sliding window in loop-helpers.ts LAYER 3 still owns that concern. We only
 * shrink content. This keeps tool_call/tool_result pairing intact, which the
 * Vercel AI SDK validates strictly (AI_MissingToolResultsError).
 */

export interface MicroCompactMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool-call metadata is preserved as-is — TIER 1 never touches it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

export interface MicroCompactOptions {
  /** Number of head messages preserved unmodified. Default 2. */
  preserveHeadCount?: number;
  /** Number of tail messages preserved unmodified. Default 6. */
  preserveTailCount?: number;
  /** Max chars retained for middle `tool` messages. Default 800. */
  toolMessageMaxChars?: number;
  /** Max chars retained for middle `assistant` messages. Default 4000. */
  assistantMessageMaxChars?: number;
  /** Max chars retained for middle `user` messages. Default 4000. */
  userMessageMaxChars?: number;
}

export interface MicroCompactResult<M extends MicroCompactMessage> {
  /** New message array (caller decides whether to assign back to session). */
  messages: M[];
  /** Total content chars across all messages before the pass. */
  charsBefore: number;
  /** Total content chars across all messages after the pass. */
  charsAfter: number;
  /** Number of messages whose content was shortened. */
  clamped: number;
  /** Always 0 — TIER 1 never drops messages (preserves tool-call pairing). */
  dropped: number;
}

const DEFAULTS = {
  preserveHeadCount: 2,
  preserveTailCount: 6,
  toolMessageMaxChars: 800,
  assistantMessageMaxChars: 4000,
  userMessageMaxChars: 4000,
} as const;

/**
 * Clamp `s` to at most `maxChars` by keeping the head and tail with a
 * `[trimmed N chars]` marker in the middle. Below the cap, returns `s`
 * unchanged. For very small caps (≤ 64), falls back to a head-only slice
 * since splitting head+tail wouldn't fit a meaningful marker (~20 chars
 * minimum for `\n…[trimmed N chars]\n`). Two-pass marker construction so
 * the diagnostic count reports the actually-dropped middle bytes, not the
 * naive `s.length - maxChars` (which under-counts by `marker.length`).
 */
function clamp(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  if (maxChars <= 64) return s.slice(0, maxChars);
  // Pass 1: build a probe marker against an over-count to learn its width
  // (the digit count is stable across the ~1-byte rounding the real count
  // induces — once we know `marker.length`, `remaining` is fixed). One pass
  // is enough for the digit count to settle in practice.
  const probe = `\n…[trimmed ${s.length} chars]\n`;
  const remaining = maxChars - probe.length;
  if (remaining <= 0) return s.slice(0, maxChars);
  const head = Math.ceil(remaining * 0.6); // 60% prefix, 40% suffix
  const tail = remaining - head;
  const dropped = s.length - (head + tail);
  const marker = `\n…[trimmed ${dropped} chars]\n`;
  return s.slice(0, head) + marker + s.slice(-tail);
}

function totalChars(messages: readonly MicroCompactMessage[]): number {
  let n = 0;
  for (const m of messages) n += m.content?.length ?? 0;
  return n;
}

/**
 * Role-aware microcompaction. Returns a new array; never mutates the input.
 *
 * The caller decides whether to assign the result back to the session. The
 * `charsBefore`/`charsAfter` fields let the caller measure recovery and
 * decide whether to escalate to TIER 2 (LLM-based summarisation).
 *
 * Invariant: messages.length and message[i].role are unchanged. Tool-call
 * IDs and any non-`content` metadata pass through by structural spread, so
 * downstream tool-result pairing is never broken.
 */
export function microCompactMessages<M extends MicroCompactMessage>(
  messages: readonly M[],
  options: MicroCompactOptions = {},
): MicroCompactResult<M> {
  const head = options.preserveHeadCount ?? DEFAULTS.preserveHeadCount;
  const tail = options.preserveTailCount ?? DEFAULTS.preserveTailCount;
  const toolCap = options.toolMessageMaxChars ?? DEFAULTS.toolMessageMaxChars;
  const asstCap = options.assistantMessageMaxChars ?? DEFAULTS.assistantMessageMaxChars;
  const userCap = options.userMessageMaxChars ?? DEFAULTS.userMessageMaxChars;

  const charsBefore = totalChars(messages);

  // Nothing to do when head+tail covers the entire list — there's no middle.
  if (messages.length <= head + tail) {
    return {
      messages: messages.slice() as M[],
      charsBefore,
      charsAfter: charsBefore,
      clamped: 0,
      dropped: 0,
    };
  }

  let clamped = 0;
  const out: M[] = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const inMiddle = i >= head && i < messages.length - tail;
    if (!inMiddle) {
      out[i] = m;
      continue;
    }

    const content = m.content ?? '';
    let cap: number | null = null;
    if (m.role === 'tool') cap = toolCap;
    else if (m.role === 'assistant') cap = asstCap;
    else if (m.role === 'user') cap = userCap;
    // 'system' middle messages pass through untouched — they are typically
    // small directives that should not be lossily compressed.

    if (cap === null || content.length <= cap) {
      out[i] = m;
      continue;
    }

    const clampedContent = clamp(content, cap);
    out[i] = { ...m, content: clampedContent };
    clamped++;
  }

  return {
    messages: out,
    charsBefore,
    charsAfter: totalChars(out),
    clamped,
    dropped: 0,
  };
}
