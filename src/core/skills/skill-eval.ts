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
  /** Judge verdict after debiasing: which arm won this prompt (majority across runs). */
  winner: 'with' | 'without' | 'tie' | 'inconsistent';
  /** One-line judge rationale from the first pass (advisory). */
  reason: string;
  withChars: number;
  withoutChars: number;
  withMs: number;
  withoutMs: number;
  /** Normalized judge rubric scores (0..1), averaged over passes/runs when present. */
  withScore?: number;
  withoutScore?: number;
  /** Per-run winners when runs > 1. */
  runWinners?: Array<'with' | 'without' | 'tie' | 'inconsistent'>;
}

export interface AssertionResult {
  text: string;
  withPassed: boolean;
  withoutPassed: boolean;
  /** Evidence cited for the with-skill verdict. */
  evidence: string;
  /** False when the assertion passes (or fails) on BOTH arms — it cannot tell the arms apart. */
  discriminating: boolean;
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
  /** Runs per prompt (1 = v1 behavior). */
  runsPerPrompt: number;
  /** Win-rate per complete run pass, when runs > 1 (variance signal). */
  perRunWinRates?: Array<number | null>;
  /** Sample stddev (n-1) of perRunWinRates, when computable. */
  winRateStddev?: number;
  /** Assertion matrix across both arms, when assertions were provided. */
  assertions?: AssertionResult[];
  /** Assertions that cannot distinguish the arms (same outcome on both). */
  nonDiscriminatingAssertions?: string[];
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
  return { skillName, prompts: results.length, wins, losses, ties, inconsistent, winRate, threshold, recommendation, results, runsPerPrompt: 1 };
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
    'You are judging which of two responses better serves a user request.',
    'First derive 3-4 criteria that matter for THIS specific request (e.g. correctness,',
    'completeness, clarity, fit-to-request) and score each response 1-5 on each criterion.',
    'Ignore superficial style differences that do not affect the user.',
    '',
    `--- USER REQUEST ---\n${userTask}`,
    `--- RESPONSE A ---\n${a}`,
    `--- RESPONSE B ---\n${b}`,
    '',
    'Reply with ONE line of rationale, then on the last two lines exactly:',
    'SCORES: A=<total>/<max> B=<total>/<max>',
    'WINNER: A   or   WINNER: B   or   WINNER: TIE',
  ].join('\n');
}

/** Parse the optional "SCORES: A=17/20 B=14/20" judge line (lenient; null when absent). */
export function parseScores(reply: string): { a: number; b: number } | null {
  const m = /SCORES:\s*A\s*=\s*(\d+)\s*\/\s*(\d+)\s*B\s*=\s*(\d+)\s*\/\s*(\d+)/i.exec(reply ?? '');
  if (!m) return null;
  const maxA = Number(m[2]); const maxB = Number(m[4]);
  if (maxA <= 0 || maxB <= 0) return null;
  return { a: Number(m[1]) / maxA, b: Number(m[3]) / maxB };
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
  /** Complete passes per prompt for variance (default 1, max 3; cost scales linearly). */
  runs?: number;
  /** Format/outcome contracts checked against BOTH arms' outputs (grader mode). */
  assertions?: string[];
}

/** Sample standard deviation (n-1); undefined below 2 samples. */
export function sampleStddev(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Majority vote across run winners; decisive only on a strict plurality of with/without. */
export function majorityWinner(runWinners: readonly PromptResult['winner'][]): PromptResult['winner'] {
  const count = (w: PromptResult['winner']): number => runWinners.filter((x) => x === w).length;
  const withN = count('with'); const withoutN = count('without');
  if (withN > withoutN) return 'with';
  if (withoutN > withN) return 'without';
  return count('inconsistent') > count('tie') ? 'inconsistent' : 'tie';
}

function assertionPrompt(userTask: string, output: string, assertions: readonly string[]): string {
  return [
    'Grade each assertion against the response below. PASS only when the response gives',
    'clear evidence the assertion holds — the burden of proof is ON the assertion; when',
    'uncertain or the evidence is superficial, FAIL it. Cite the evidence.',
    '',
    `--- USER REQUEST ---\n${userTask}`,
    `--- RESPONSE ---\n${output}`,
    '',
    'Assertions:',
    ...assertions.map((a, i) => `${i + 1}. ${a}`),
    '',
    'Return ONLY a JSON array, one entry per assertion in order:',
    '[{"passed": true|false, "evidence": "short quote or reason"}, ...]',
  ].join('\n');
}

/** Evaluate assertions against one output; fail-closed per assertion on parse trouble. */
export async function evalAssertions(
  brain: EvalBrain,
  tier: string,
  userTask: string,
  output: string,
  assertions: readonly string[],
): Promise<Array<{ passed: boolean; evidence: string }>> {
  const resp = await brain.call(
    { messages: [{ role: 'user', content: assertionPrompt(userTask, output, assertions) }], source: 'skill-eval' },
    { tier, strategy: 'single' },
  );
  const text = resp.content ?? '';
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    const arr = JSON.parse(text.slice(start, end + 1)) as Array<{ passed?: unknown; evidence?: unknown }>;
    return assertions.map((_, i) => ({
      passed: arr[i]?.passed === true,
      evidence: typeof arr[i]?.evidence === 'string' ? (arr[i]!.evidence as string).slice(0, 200) : '',
    }));
  } catch {
    return assertions.map(() => ({ passed: false, evidence: 'grader reply unparseable — failed closed' }));
  }
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

  const runs = Math.min(Math.max(opts.runs ?? 1, 1), 3);
  const assertions = (opts.assertions ?? []).filter((a) => a.trim() !== '').slice(0, 10);

  const results: PromptResult[] = [];
  // Winners per run index (column) across prompts, for per-run win rates.
  const winnersByRun: PromptResult['winner'][][] = Array.from({ length: runs }, () => []);
  const assertionAgg = assertions.map((text) => ({ text, withPass: 0, withoutPass: 0, evidence: '' }));

  for (const prompt of prompts) {
    const runWinners: PromptResult['winner'][] = [];
    let reason = '';
    let withChars = 0; let withoutChars = 0; let withMs = 0; let withoutMs = 0;
    const withScores: number[] = []; const withoutScores: number[] = [];

    for (let run = 0; run < runs; run++) {
      const withSkill = await timedCall(brain, [
        { role: 'system', content: `Follow this skill's instructions where applicable:\n\n${markdown}` },
        { role: 'user', content: prompt },
      ], tier);
      const withoutSkill = await timedCall(brain, [{ role: 'user', content: prompt }], tier);

      // Pass 1: WITH is A. Pass 2: WITH is B (order swapped).
      const j1 = await timedCall(brain, [{ role: 'user', content: judgePrompt(prompt, withSkill.text, withoutSkill.text) }], tier);
      const j2 = await timedCall(brain, [{ role: 'user', content: judgePrompt(prompt, withoutSkill.text, withSkill.text) }], tier);
      const winner = debias(parseVerdict(j1.text), parseVerdict(j2.text));
      runWinners.push(winner);
      winnersByRun[run]!.push(winner);

      // Rubric scores (orientation: pass1 A=with; pass2 A=without).
      const s1 = parseScores(j1.text); const s2 = parseScores(j2.text);
      if (s1) { withScores.push(s1.a); withoutScores.push(s1.b); }
      if (s2) { withScores.push(s2.b); withoutScores.push(s2.a); }

      if (run === 0) {
        reason = (j1.text.split('\n')[0] ?? '').slice(0, 200);
        withChars = withSkill.text.length; withoutChars = withoutSkill.text.length;
        withMs = withSkill.ms; withoutMs = withoutSkill.ms;
        // Grader mode: check the contracts against BOTH arms (first run only,
        // cost control). An assertion behaving identically on both arms cannot
        // measure the skill — flagged non-discriminating below.
        if (assertions.length > 0) {
          const withA = await evalAssertions(brain, tier, prompt, withSkill.text, assertions);
          const withoutA = await evalAssertions(brain, tier, prompt, withoutSkill.text, assertions);
          assertions.forEach((_, i) => {
            if (withA[i]!.passed) assertionAgg[i]!.withPass++;
            if (withoutA[i]!.passed) assertionAgg[i]!.withoutPass++;
            if (!assertionAgg[i]!.evidence && withA[i]!.evidence) assertionAgg[i]!.evidence = withA[i]!.evidence;
          });
        }
      }
    }

    const winner = majorityWinner(runWinners);
    const avg = (xs: number[]): number | undefined =>
      xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
    results.push({
      prompt,
      winner,
      reason,
      withChars,
      withoutChars,
      withMs,
      withoutMs,
      withScore: avg(withScores),
      withoutScore: avg(withoutScores),
      runWinners: runs > 1 ? runWinners : undefined,
    });
    log.info({ skillName, winner, runs, prompt: prompt.slice(0, 80) }, 'skill-eval: prompt judged');
  }

  const report = aggregate(skillName, results, threshold);
  report.runsPerPrompt = runs;
  if (runs > 1) {
    const perRun = winnersByRun.map((col) => {
      const w = col.filter((x) => x === 'with').length;
      const l = col.filter((x) => x === 'without').length;
      return w + l > 0 ? w / (w + l) : null;
    });
    report.perRunWinRates = perRun;
    report.winRateStddev = sampleStddev(perRun.filter((x): x is number => x !== null));
  }
  if (assertions.length > 0) {
    const half = prompts.length / 2;
    report.assertions = assertionAgg.map((a) => {
      const withPassed = a.withPass > half;
      const withoutPassed = a.withoutPass > half;
      return { text: a.text, withPassed, withoutPassed, evidence: a.evidence, discriminating: withPassed !== withoutPassed };
    });
    report.nonDiscriminatingAssertions = report.assertions.filter((a) => !a.discriminating).map((a) => a.text);
  }
  log.info(
    { skillName, winRate: report.winRate, recommendation: report.recommendation, wins: report.wins, losses: report.losses, ties: report.ties, inconsistent: report.inconsistent, runs, stddev: report.winRateStddev },
    'skill-eval: report complete',
  );
  return report;
}
