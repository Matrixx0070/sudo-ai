/**
 * @file arsenal-v2/retry-prompt.ts
 * @description Builds the appendix injected into the patcher's user prompt
 * when the critic returned NEEDS_REVISION on a prior attempt.
 *
 * Shape (bounded — see caps below):
 *
 *   --- PRIOR ATTEMPT(S) — REVIEWED AND REJECTED ---
 *   Your previous attempt(s) at this task were reviewed and rejected for the
 *   reasons listed below. Produce a NEW patch that addresses these critiques.
 *   Do not repeat the rejected approach.
 *
 *   === Attempt 1 ===
 *   DIFF SUMMARY:
 *   <bounded view of what landed>
 *   CRITIC:
 *   <critique from the critic>
 *
 *   === Attempt 2 ===
 *   ...
 *
 * Caps:
 *   - Per-attempt diff summary truncated at 3072 chars (smaller than the
 *     critic's 32KB cap — we want context, not the full thing).
 *   - Per-attempt critique truncated at 1024 chars.
 *   - Total appendix capped at 16384 chars; if exceeded, drops the OLDEST
 *     attempts first (most recent critique is the most informative).
 */

export interface PreviousAttempt {
  /** Bounded diff summary (already trimmed by buildDiffSummary). */
  diffSummary: string;
  /** Critic's critique text for this attempt. */
  critique: string;
}

const DIFF_CAP = 3072;
const CRITIQUE_CAP = 1024;
const TOTAL_CAP = 16_384;

export function buildRetryAppendix(previousAttempts: PreviousAttempt[]): string {
  if (previousAttempts.length === 0) return '';

  const header = [
    '',
    '--- PRIOR ATTEMPT(S) — REVIEWED AND REJECTED ---',
    'Your previous attempt(s) at this task were reviewed and rejected for the',
    'reasons listed below. Produce a NEW patch that addresses these critiques.',
    'Do not repeat the rejected approach.',
    '',
  ].join('\n');

  // Render newest-first into a buffer so we can drop oldest entries if the
  // total exceeds TOTAL_CAP. We still LABEL them in original order ("Attempt
  // 1", "Attempt 2", ...) because that's what the LLM expects to see.
  const total = previousAttempts.length;
  const rendered: string[] = [];
  let used = header.length;
  // Walk newest -> oldest so we keep the freshest critiques when truncating.
  for (let i = total - 1; i >= 0; i--) {
    const block = renderOne(i + 1, previousAttempts[i]!);
    if (used + block.length > TOTAL_CAP) break;
    rendered.unshift(block); // unshift so final order is Attempt 1, 2, 3, ...
    used += block.length;
  }
  const dropped = total - rendered.length;

  const parts = [header, ...rendered];
  if (dropped > 0) {
    parts.push(`[... ${dropped} earlier attempt(s) omitted to fit prompt budget ...]\n`);
  }
  return parts.join('\n');
}

function renderOne(num: number, a: PreviousAttempt): string {
  return [
    `=== Attempt ${num} ===`,
    'DIFF SUMMARY:',
    truncate(a.diffSummary, DIFF_CAP),
    'CRITIC:',
    truncate(a.critique, CRITIQUE_CAP),
    '',
  ].join('\n');
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n[... truncated ${s.length - cap} chars ...]`;
}

/**
 * Decides whether the retry loop should continue.
 *
 * Returns true ONLY when:
 *   - the critic ran and emitted `needs_revision`, AND
 *   - we have remaining attempts in the budget, AND
 *   - at least one patch op landed (no point re-criting an empty diff).
 *
 * Returns false for everything else — approve (done), critic error
 * (inconclusive, stop), critic skipped (treated as implicit approve),
 * budget exhausted, or zero ops applied this round.
 */
export function shouldRetry(args: {
  criticVerdict: 'approve' | 'needs_revision' | 'error' | null;
  criticSkipped: boolean;
  attemptIndex: number; // 1-based
  maxAttempts: number;
  applied: number;
}): boolean {
  if (args.criticSkipped) return false;
  if (args.criticVerdict !== 'needs_revision') return false;
  if (args.attemptIndex >= args.maxAttempts) return false;
  if (args.applied === 0) return false;
  return true;
}

/**
 * Clamps a requested maxAttempts to the supported range [1, 5]. Returns the
 * default (3) for missing / non-finite / out-of-range inputs.
 */
export function clampMaxAttempts(requested: unknown): number {
  if (requested == null) return 3;
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n)) return 3;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  if (floored > 5) return 5;
  return floored;
}
