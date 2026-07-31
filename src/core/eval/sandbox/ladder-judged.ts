/**
 * @file ladder-judged.ts
 * @description Judged ladder rungs 4–5 (ADR-0002).
 *
 * Rung 4 — task completion: programmatic assertions FIRST (cheap, certain),
 * then an LLM judge for goal satisfaction only when assertions can't decide it.
 * A route that fails the programmatic part never reaches the judge: no point
 * paying a judge to bless output we can already prove wrong.
 *
 * Rung 5 — self-consistency: the same prompt is sampled k times and the judge
 * decides whether the answers agree substantively. This is what ADR-0002 gates
 * judge eligibility on (>=90%), together with rung 2 (>=95%).
 *
 * INVARIANT 7 (CLAUDE.md, non-negotiable): the judge must be independent of the
 * route under test. Because a ladder run grades ONE route, independence is
 * decided per RUN, not per item: if the judge's provider is the route's
 * provider, the whole rung HOLDS — admitted=false with an explicit hold reason,
 * never a pass. Grading your own homework is not a verdict.
 */

import { createLogger } from '../../shared/logger.js';
import { evalJudgeModel, callJudgeRoute, parseJudgeScore, type JudgeCallResult } from './judge.js';
import { providerOf } from '../../../llm/judge.js';
import { gradeRung0, type GradeOutcome } from './ladder-graders.js';

const log = createLogger('eval:ladder-judged');

export type JudgeCall = (judgeModel: string, system: string, user: string) => Promise<JudgeCallResult>;

/** Invariant 7: is the pinned judge independent of the route under test? */
export function judgeIsIndependent(judgeModel: string, routeUnderTest: string): boolean {
  return providerOf(judgeModel) !== providerOf(routeUnderTest);
}

const RUBRIC_SYSTEM =
  'You are an evaluation judge. Score the ASSISTANT OUTPUT against the RUBRIC on a 0-10 scale ' +
  '(0 = complete failure, 10 = flawless). Respond with ONLY a JSON object: {"score": <number>, "reason": "<one sentence>"}.';

const CONSISTENCY_SYSTEM =
  'You are an evaluation judge assessing SELF-CONSISTENCY. You are given several independent answers ' +
  'to the SAME question. Score 0-10 how substantively CONSISTENT they are with each other ' +
  '(10 = all agree on the substantive answer, differing only in wording; 0 = they contradict). ' +
  'Ignore style, length and phrasing. Respond with ONLY a JSON object: {"score": <number>, "reason": "<one sentence>"}.';

/**
 * Rung 4 — task completion. `expect` may carry any rung-0 assertion key
 * (outputContains / outputMatches / jsonParses / nonEmpty) plus:
 *   rubric   — judged goal-satisfaction criterion (required)
 *   minScore — judge pass threshold, default 7
 */
export async function gradeRung4(
  expect: Record<string, unknown>,
  text: string,
  judgeModel: string,
  call: JudgeCall = callJudgeRoute,
): Promise<GradeOutcome & { judgeUsage?: { in: number; out: number } }> {
  const rubric = expect['rubric'];
  if (typeof rubric !== 'string' || rubric === '') {
    return { passed: false, detail: 'rung-4 expect.rubric must be a non-empty string' };
  }
  const minRaw = expect['minScore'];
  const minScore = typeof minRaw === 'number' ? minRaw : 7;

  // Programmatic assertions first — cheap and certain.
  const assertions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(expect)) {
    if (k !== 'rubric' && k !== 'minScore') assertions[k] = v;
  }
  if (Object.keys(assertions).length > 0) {
    const pre = gradeRung0(assertions, text);
    if (!pre.passed) return { passed: false, detail: `assertion: ${pre.detail}` };
  }

  let res: JudgeCallResult;
  try {
    res = await call(judgeModel, RUBRIC_SYSTEM, `RUBRIC:\n${rubric}\n\nASSISTANT OUTPUT:\n${text}`);
  } catch (err) {
    return { passed: false, detail: `judge call failed: ${String(err).slice(0, 120)}` };
  }
  const score = parseJudgeScore(res.text);
  if (score === null) return { passed: false, detail: 'judge reply unparseable', judgeUsage: res.usage };
  return {
    passed: score >= minScore,
    detail: `judge ${score}/10 (min ${minScore})`,
    judgeUsage: res.usage,
  };
}

/**
 * Rung 5 — self-consistency across k independent samples of the same prompt.
 * `expect.minScore` (default 8) is the consistency bar on the judge's 0-10.
 * Fewer than 2 samples cannot show consistency — that is a FAIL, not a pass.
 */
export async function gradeRung5(
  expect: Record<string, unknown>,
  samples: string[],
  judgeModel: string,
  call: JudgeCall = callJudgeRoute,
): Promise<GradeOutcome & { judgeUsage?: { in: number; out: number } }> {
  for (const key of Object.keys(expect)) {
    if (key !== 'minScore') return { passed: false, detail: `unknown rung-5 expect key '${key}'` };
  }
  const minRaw = expect['minScore'];
  const minScore = typeof minRaw === 'number' ? minRaw : 8;

  const usable = samples.filter((s) => s.trim() !== '');
  if (usable.length < 2) {
    return { passed: false, detail: `need >=2 non-empty samples, got ${usable.length}` };
  }

  const body = usable.map((s, i) => `ANSWER ${i + 1}:\n${s}`).join('\n\n');
  let res: JudgeCallResult;
  try {
    res = await call(judgeModel, CONSISTENCY_SYSTEM, body);
  } catch (err) {
    return { passed: false, detail: `judge call failed: ${String(err).slice(0, 120)}` };
  }
  const score = parseJudgeScore(res.text);
  if (score === null) return { passed: false, detail: 'judge reply unparseable', judgeUsage: res.usage };
  return {
    passed: score >= minScore,
    detail: `consistency ${score}/10 over ${usable.length} samples (min ${minScore})`,
    judgeUsage: res.usage,
  };
}

/** Samples-per-item for rung 5 (SUDO_EVAL_LADDER_CONSISTENCY_K, default 3). */
export function consistencyK(): number {
  const n = Number(process.env['SUDO_EVAL_LADDER_CONSISTENCY_K']);
  return Number.isInteger(n) && n >= 2 ? n : 3;
}

/** Log + describe an invariant-7 hold so the reason is identical everywhere. */
export function judgeHoldReason(judgeModel: string, route: string): string {
  log.warn({ judgeModel, route }, 'ladder: judge shares the provider under test — HOLDING rung');
  return `judge-hold: judge '${judgeModel}' shares provider with route under test '${route}' (invariant 7) — no independent judge, verdict HELD`;
}
