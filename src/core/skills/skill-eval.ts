/**
 * @file skill-eval.ts
 * @description Prove-before-adopt skill efficacy evaluation.
 *
 * Runs each test prompt through the brain twice — once WITH the candidate
 * skill installed as system guidance, once WITHOUT — then has a judge pick
 * the better answer blind. The judge sees anonymous "Response A/B" labels
 * and is consulted TWICE per prompt with the order swapped; only verdicts
 * that agree across both orderings count (position bias is a known LLM-judge
 * failure mode — an inconsistent pair means the judge was picking a POSITION,
 * not an answer, so it is discarded rather than counted).
 *
 * The output is a win-rate over consistent verdicts plus an adoption
 * recommendation, giving skill.apply / skill.install an objective "does this
 * skill actually help" signal instead of adopting on vibes. Costs are
 * bounded: K prompts (default 3) means 2K generation + 2K judge calls on the
 * fast tier, run sequentially.
 *
 * Honest limitations (v1): generation is single-turn brain calls, so skills
 * whose value shows only in multi-step tool use are under-measured; cost is
 * reported as latency + response size (per-call token counts are not on the
 * BrainLike surface — api_call_log has them if a future slice wants exact
 * numbers).
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('skills:skill-eval');

// ---------------------------------------------------------------------------
// Brain surface (structurally mirrors Brain.call / loop-helpers BrainLike)
// ---------------------------------------------------------------------------

export interface EvalBrain {
  call(
    request: { messages: Array<{ role: string; content: string }>; source?: string },
    opts?: { tier?: string; strategy?: string },
  ): Promise<{ content?: string }>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptResult {
  prompt: string;
  /** Judge verdict after debiasing: which arm won this prompt. */
  winner: 'with' | 'without' | 'tie' | 'inconsistent';
  /** One-line judge rationale from the first pass (advisory). */
  reason: string;
  withChars: number;
  withoutChars: number;
  withMs: number;
  withoutMs: number;
}

export interface SkillEvalReport {
  skillName: string;
  prompts: number;
  wins: number;
  losses: number;
  ties: number;
  inconsistent: number;
  /** wins / (wins + losses) over consistent, non-tie verdicts; null when that denominator is 0. */
  winRate: number | null;
  threshold: number;
  recommendation: 'adopt' | 'reject' | 'inconclusive';
  results: PromptResult[];
}

// ---------------------------------------------------------------------------
// Judge plumbing (pure helpers, exported for tests)
// ---------------------------------------------------------------------------

const VERDICT_RE = /WINNER:\s*(A|B|TIE)\b/i;

/** Parse a judge reply into a verdict; unparseable replies are ties (fail-neutral). */
export function parseVerdict(reply: string): 'A' | 'B' | 'tie' {
  const m = VERDICT_RE.exec(reply ?? '');
  if (!m) return 'tie';
  const v = m[1]!.toUpperCase();
  return v === 'A' ? 'A' : v === 'B' ? 'B' : 'tie';
}

/**
 * Combine two order-swapped verdicts into one debiased result.
 * Pass 1 shows WITH as A; pass 2 shows WITH as B. Agreement on the same
 * underlying ARM (not the same letter) is required; disagreement (other than
 * an honest tie on either side) is 'inconsistent' and never counted as a win.
 */
export function debias(pass1: 'A' | 'B' | 'tie', pass2: 'A' | 'B' | 'tie'): PromptResult['winner'] {
  const arm1 = pass1 === 'A' ? 'with' : pass1 === 'B' ? 'without' : 'tie';
  const arm2 = pass2 === 'B' ? 'with' : pass2 === 'A' ? 'without' : 'tie';
  if (arm1 === arm2) return arm1;
  if (arm1 === 'tie' || arm2 === 'tie') return 'tie';
  return 'inconsistent';
}

/** Aggregate per-prompt winners into the adoption verdict. */
export function aggregate(
  skillName: string,
  results: PromptResult[],
  threshold: number,
): SkillEvalReport {
  const wins = results.filter((r) => r.winner === 'with').length;
  const losses = results.filter((r) => r.winner === 'without').length;
  const ties = results.filter((r) => r.winner === 'tie').length;
  const inconsistent = results.filter((r) => r.winner === 'inconsistent').length;
  const denom = wins + losses;
  const winRate = denom > 0 ? wins / denom : null;
  // Inconclusive when fewer than half the prompts produced a decisive,
  // consistent verdict — a judge that mostly ties or flip-flops has not
  // actually measured anything.
  const recommendation: SkillEvalReport['recommendation'] =
    denom === 0 || denom < results.length / 2
      ? 'inconclusive'
      : (winRate ?? 0) >= threshold
        ? 'adopt'
        : 'reject';
  return { skillName, prompts: results.length, wins, losses, ties, inconsistent, winRate, threshold, recommendation, results };
}

/** Extract the first JSON array of strings found in a model reply. */
export function parsePromptList(reply: string, max: number): string[] {
  try {
    const start = reply.indexOf('[');
    const end = reply.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    const arr = JSON.parse(reply.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function judgePrompt(userTask: string, a: string, b: string): string {
  return [
    'You are judging which of two responses better serves a user request. Judge on:',
    'usefulness to the stated request, correctness, clarity, and appropriate length.',
    'Ignore superficial style differences that do not affect the user.',
    '',
    `--- USER REQUEST ---\n${userTask}`,
    `--- RESPONSE A ---\n${a}`,
    `--- RESPONSE B ---\n${b}`,
    '',
    'Reply with ONE line of rationale, then on the final line exactly:',
    'WINNER: A   or   WINNER: B   or   WINNER: TIE',
  ].join('\n');
}

function genPromptsPrompt(skillName: string, markdown: string, k: number): string {
  return [
    `Write ${k} realistic, concrete user test prompts for evaluating the following assistant skill.`,
    'Each prompt must be something a real user would type (specific details, natural phrasing),',
    'and substantive enough that skill guidance could plausibly change the answer quality.',
    'Return ONLY a JSON array of strings.',
    '',
    `--- SKILL ${skillName} ---`,
    markdown.slice(0, 6000),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunSkillEvalOptions {
  skillName: string;
  markdown: string;
  brain: EvalBrain;
  /** Explicit test prompts; when absent, K prompts are auto-generated. */
  prompts?: string[];
  /** Auto-generation count / prompt cap. Default 3, max 8. */
  maxPrompts?: number;
  /** Win-rate needed for an 'adopt' recommendation. Default 0.6. */
  threshold?: number;
  tier?: string;
}

async function timedCall(
  brain: EvalBrain,
  messages: Array<{ role: string; content: string }>,
  tier: string,
): Promise<{ text: string; ms: number }> {
  const start = Date.now();
  const resp = await brain.call({ messages, source: 'skill-eval' }, { tier, strategy: 'single' });
  return { text: (resp.content ?? '').trim(), ms: Date.now() - start };
}

/**
 * Run the full with/without evaluation. Throws on missing inputs; individual
 * judge parse failures degrade to ties rather than aborting the run.
 */
export async function runSkillEval(opts: RunSkillEvalOptions): Promise<SkillEvalReport> {
  const { skillName, markdown, brain } = opts;
  const tier = opts.tier ?? 'fast';
  const threshold = opts.threshold ?? 0.6;
  const maxPrompts = Math.min(Math.max(opts.maxPrompts ?? 3, 1), 8);

  let prompts = (opts.prompts ?? []).filter((p) => p.trim().length > 0).slice(0, maxPrompts);
  if (prompts.length === 0) {
    const gen = await timedCall(brain, [{ role: 'user', content: genPromptsPrompt(skillName, markdown, maxPrompts) }], tier);
    prompts = parsePromptList(gen.text, maxPrompts);
    if (prompts.length === 0) {
      throw new Error('Could not auto-generate test prompts — provide prompts explicitly.');
    }
    log.info({ skillName, generated: prompts.length }, 'skill-eval: test prompts auto-generated');
  }

  const results: PromptResult[] = [];
  for (const prompt of prompts) {
    const withSkill = await timedCall(brain, [
      { role: 'system', content: `Follow this skill's instructions where applicable:\n\n${markdown}` },
      { role: 'user', content: prompt },
    ], tier);
    const withoutSkill = await timedCall(brain, [{ role: 'user', content: prompt }], tier);

    // Pass 1: WITH is A. Pass 2: WITH is B (order swapped).
    const j1 = await timedCall(brain, [{ role: 'user', content: judgePrompt(prompt, withSkill.text, withoutSkill.text) }], tier);
    const j2 = await timedCall(brain, [{ role: 'user', content: judgePrompt(prompt, withoutSkill.text, withSkill.text) }], tier);
    const winner = debias(parseVerdict(j1.text), parseVerdict(j2.text));

    results.push({
      prompt,
      winner,
      reason: (j1.text.split('\n')[0] ?? '').slice(0, 200),
      withChars: withSkill.text.length,
      withoutChars: withoutSkill.text.length,
      withMs: withSkill.ms,
      withoutMs: withoutSkill.ms,
    });
    log.info({ skillName, winner, prompt: prompt.slice(0, 80) }, 'skill-eval: prompt judged');
  }

  const report = aggregate(skillName, results, threshold);
  log.info(
    { skillName, winRate: report.winRate, recommendation: report.recommendation, wins: report.wins, losses: report.losses, ties: report.ties, inconsistent: report.inconsistent },
    'skill-eval: report complete',
  );
  return report;
}
