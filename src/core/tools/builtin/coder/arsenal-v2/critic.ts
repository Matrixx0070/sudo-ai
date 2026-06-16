/**
 * @file arsenal-v2/critic.ts
 * @description Slice 4 — second-pass LLM review of the applied patch.
 *
 * After the patcher LLM emits a JSON patch block and the applier writes
 * the changes to disk, a *critic* LLM reads (a) the original task, (b) the
 * mode, (c) the bounded diff summary from {@link ./diff-summary.ts}, and
 * (d) the tsc + test outcomes, and returns a structured verdict:
 *
 *   VERDICT: APPROVE          — the patch addresses the task without
 *                               obvious regressions; ship it.
 *   VERDICT: NEEDS_REVISION   — issues found (root cause missed, fragile
 *                               approach, behavior break, etc.). The
 *                               critique below the verdict line explains.
 *
 * The critic does NOT generate a follow-up patch in this slice — that's
 * the retry loop in slice 5. It also doesn't see full file contents, only
 * the diff summary. Out-of-scope details by design: keep token spend
 * bounded and the contract narrow.
 *
 * Operational signals:
 *   - SUDO_ARSENAL_V2_SKIP_CRITIC=1   — opt-out, returns skipped.
 *   - SUDO_ARSENAL_V2_CRITIC_MODEL    — model override.
 *   - LLM errors degrade gracefully — verdict 'error', skipped=true,
 *     skipReason='critic_error'. The tool does not abort.
 */

import type { ArsenalV2Mode } from './system-prompt.js';

/** Shape of the injected LLM caller. Mirrors the patcher's call shape. */
export type CriticLlm = (args: {
  modelId: string;
  system: string;
  user: string;
}) => Promise<string>;

export type CriticVerdict = 'approve' | 'needs_revision' | 'error';

export interface CriticOptions {
  task: string;
  mode: ArsenalV2Mode;
  diffSummary: string;
  tscSummary: string | null;
  testSummary: string | null;
  llm: CriticLlm;
  modelId: string;
  env?: NodeJS.ProcessEnv;
}

export interface CriticResult {
  ran: boolean;
  skipped: boolean;
  skipReason?: 'disabled_env' | 'critic_error';
  verdict: CriticVerdict;
  /** Free-text rationale from the critic. Empty when not run. */
  critique: string;
  /** Model id that was actually consulted. */
  modelId: string;
}

const CRITIC_SYSTEM_PROMPT = `You are a senior engineer reviewing a code change.

You receive:
  • The original TASK the patcher was asked to do.
  • The MODE (fix / build / refactor / test).
  • A DIFF SUMMARY showing what the patcher actually changed.
  • TYPECHECK + TEST results after the patch landed.

Your job: decide whether to APPROVE or request revision.

Approve when:
  • The change addresses the stated task.
  • No obvious behavior regression visible in the diff.
  • Typecheck is clean (or strictly improved from baseline) AND tests pass
    (or were skipped for valid reasons listed in the test summary).

Request revision when:
  • The patch papers over a symptom instead of fixing the root cause.
  • The diff introduces a regression, fragile coupling, or violates the
    mode's discipline (e.g. refactor that changes behavior, test mode
    that asserts on implementation details).
  • Tests or tsc went red and the patch caused it.

Output format — EXACTLY this shape, nothing before the verdict line:
  VERDICT: APPROVE
  <one to five sentences of rationale>

  -- or --

  VERDICT: NEEDS_REVISION
  <one to five sentences explaining what's wrong and what to change>

Do not include code blocks, follow-up patches, or speculative changes.
Just the verdict line + rationale.`;

/**
 * Run the critic against an applied patch. Returns a structured verdict;
 * never throws. Caller decides whether to block tool success on the result.
 */
export async function runCritic(opts: CriticOptions): Promise<CriticResult> {
  const env = opts.env ?? process.env;

  if (env['SUDO_ARSENAL_V2_SKIP_CRITIC'] === '1') {
    return {
      ran: false,
      skipped: true,
      skipReason: 'disabled_env',
      verdict: 'approve', // skipped == do-not-block; treat as implicit approve.
      critique: '',
      modelId: opts.modelId,
    };
  }

  const user = [
    `TASK: ${opts.task}`,
    `MODE: ${opts.mode}`,
    '',
    'DIFF SUMMARY:',
    opts.diffSummary,
    '',
    'TYPECHECK:',
    opts.tscSummary ?? '(not run)',
    '',
    'TESTS:',
    opts.testSummary ?? '(not run)',
  ].join('\n');

  let raw: string;
  try {
    raw = await opts.llm({
      modelId: opts.modelId,
      system: CRITIC_SYSTEM_PROMPT,
      user,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ran: true,
      skipped: true,
      skipReason: 'critic_error',
      verdict: 'error',
      critique: `Critic LLM call failed: ${detail.slice(0, 240)}`,
      modelId: opts.modelId,
    };
  }

  const parsed = parseCriticOutput(raw);
  return {
    ran: true,
    skipped: false,
    verdict: parsed.verdict,
    critique: parsed.critique,
    modelId: opts.modelId,
  };
}

/**
 * Extract the verdict + critique from the critic's raw response.
 * Tolerant of leading whitespace, markdown bold, and trailing whitespace.
 * Unparseable output is treated as 'error' so the wrapping tool can decide
 * how to handle it — same shape as a critic LLM call failure.
 */
export function parseCriticOutput(raw: string): { verdict: CriticVerdict; critique: string } {
  const text = raw.trim();
  // Strip markdown bold/italic wrappers around the verdict line.
  const m = text.match(/^\**\s*VERDICT\s*:\s*(APPROVE|NEEDS_REVISION)\**\s*$/im);
  if (!m) {
    return {
      verdict: 'error',
      critique: `Critic output did not include a VERDICT line. Raw (first 400 chars):\n${text.slice(0, 400)}`,
    };
  }
  const verdict: CriticVerdict = m[1] === 'APPROVE' ? 'approve' : 'needs_revision';
  // Everything after the verdict line is the critique. The verdict's match
  // index gives us a deterministic split point.
  const after = text.slice(m.index! + m[0].length).trim();
  return { verdict, critique: after };
}
