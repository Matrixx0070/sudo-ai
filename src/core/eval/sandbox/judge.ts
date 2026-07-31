/**
 * @file judge.ts
 * @description LLM judge grading for eval-sandbox runs (ADR-0007 Phase 3,
 * Verifiability Ladder rungs 4–5). Judge checks are graded AFTER the turn in
 * the PARENT process — never in the child — against the agent's final output.
 *
 * Invariant 7 (CLAUDE.md): the judge route must be independent of every route
 * that served the turn under test. The child's llm_calls ledger (preserved as
 * <runDir>/replay.db) is the ground truth for which routes served the turn;
 * when the judge's provider appears among them the check returns verdict HOLD
 * (`held: true` — neither pass nor fail, overall success false with reason
 * 'judge-hold: no independent route'). Independence reuses src/llm/judge.ts
 * semantics: provider-level distinctness (same provider = same training
 * lineage = grading your own homework).
 *
 * Budget (invariant 10): judge calls count against SUDO_EVAL_JUDGE_MAX_USD
 * (default $0.10 per run, estimated via limits.estimateCostUsd); on exhaustion
 * the remaining judge checks are marked held.
 */

import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { providerOf, resolveJudgeModel } from '../../../llm/judge.js';
import { estimateCostUsd } from '../../../llm/limits.js';
import type { GradingCheck } from './scenario.js';
import type { CheckOutcome, ScoreVector } from './graders.js';

export type JudgeCheck = Extract<GradingCheck, { type: 'judge' }>;

/** Pinned judge route: SUDO_EVAL_JUDGE_ROUTE overrides the fleet-wide
 * `sudo/judge` alias (default claude-oauth haiku — same mechanism as
 * src/llm/judge.ts resolveJudgeModel / LLM_ALIAS_JUDGE). */
export function evalJudgeModel(): string {
  const v = process.env['SUDO_EVAL_JUDGE_ROUTE']?.trim();
  return v !== undefined && v !== '' ? v : resolveJudgeModel();
}

/** Per-run judge spend cap in USD (SUDO_EVAL_JUDGE_MAX_USD, default 0.10). */
export function judgeBudgetUsd(): number {
  const n = Number(process.env['SUDO_EVAL_JUDGE_MAX_USD']);
  return Number.isFinite(n) && n >= 0 ? n : 0.1;
}

/**
 * Distinct routes that served the turn, from the run's preserved llm_calls
 * ledger (replay.db). Missing/unreadable ledger → [] — the caller then has no
 * evidence of a conflict and the judge may run (the child logs every call, so
 * an empty ledger means no LLM served the turn at all).
 */
export function routesServedFromReplayDb(replayDbPath: string): string[] {
  if (!existsSync(replayDbPath)) return [];
  try {
    const db = new Database(replayDbPath, { readonly: true });
    try {
      const rows = db
        .prepare(`SELECT DISTINCT route FROM llm_calls WHERE route IS NOT NULL`)
        .all() as Array<{ route: string }>;
      return rows.map((r) => r.route);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Route key ('claude-oauth:messages') → provider prefix ('claude-oauth'). */
function routeProvider(route: string): string {
  const idx = route.indexOf(':');
  return (idx === -1 ? route : route.slice(0, idx)).toLowerCase();
}

/** Invariant 7: judge conflicts when its provider served the turn. */
export function judgeConflictsWithTurn(judgeModel: string, routesServed: string[]): boolean {
  const judgeProvider = providerOf(judgeModel);
  return routesServed.some((r) => routeProvider(r) === judgeProvider);
}

export interface JudgeCallResult {
  text: string;
  usage: { in: number; out: number };
}

export interface JudgeDeps {
  /** Injected judge call for tests. Default: callIR on the pinned judge route
   * (caller 'eval-judge' — runWithPolicy wraps every callIR attempt). */
  callJudge?: (judgeModel: string, system: string, user: string) => Promise<JudgeCallResult>;
}

const JUDGE_SYSTEM =
  'You are an evaluation judge. Score the ASSISTANT OUTPUT against the RUBRIC on a 0-10 scale ' +
  '(0 = complete failure, 10 = flawless). Respond with ONLY a JSON object: {"score": <number>, "reason": "<one sentence>"}.';

/**
 * The one place an eval judge call is made. Exported so the ladder's judged
 * rungs (4/5) reuse this transport path instead of forking a second one.
 */
export async function callJudgeRoute(
  judgeModel: string,
  system: string,
  user: string,
): Promise<JudgeCallResult> {
  const { callIR } = await import('../../../llm/transport.js');
  const res = await callIR({
    alias: judgeModel,
    caller: 'eval-judge',
    purpose: 'eval-sandbox judge check',
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    priority: 'background',
    trace_id: '',
    max_tokens: 512,
  });
  const text = res.blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (res.stop_reason === 'error') throw new Error(`judge call failed: ${text || 'stop_reason=error'}`.slice(0, 300));
  return { text, usage: { in: res.usage.in, out: res.usage.out } };
}

/** Extract the 0–10 score from a judge reply. null = unparseable. */
export function parseJudgeScore(text: string): number | null {
  const m = /"score"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(text) ?? /(?<![\d.])(\d+(?:\.\d+)?)/.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, n));
}

export interface JudgeGradeInput {
  /** The scenario prompt the agent was given (context for the judge). */
  prompt: string;
  /** Agent's final reply text. */
  output: string;
  /** Routes that served the turn (replay.db llm_calls.route ground truth). */
  routesServed: string[];
}

export interface JudgeGradeResult {
  outcomes: CheckOutcome[];
  /** First hold reason, when any check held. */
  holdReason?: string;
}

/**
 * Grade all judge checks. Every outcome is pass, fail, or HELD — a held check
 * is never a pass (mergeJudgeOutcomes forces overall success false).
 */
export async function gradeJudgeChecks(
  checks: JudgeCheck[],
  input: JudgeGradeInput,
  deps: JudgeDeps = {},
): Promise<JudgeGradeResult> {
  const outcomes: CheckOutcome[] = [];
  if (checks.length === 0) return { outcomes };

  const judgeModel = evalJudgeModel();
  let holdReason: string | undefined;

  if (judgeConflictsWithTurn(judgeModel, input.routesServed)) {
    holdReason = 'judge-hold: no independent route';
    for (const check of checks) {
      outcomes.push({
        check, passed: false, held: true,
        detail: `judge route ${judgeModel} served the turn (${input.routesServed.join(', ')}) — not independent (invariant 7)`,
      });
    }
    return { outcomes, holdReason };
  }

  const callJudge = deps.callJudge ?? callJudgeRoute;
  const maxUsd = judgeBudgetUsd();
  let spentUsd = 0;

  for (const check of checks) {
    if (spentUsd >= maxUsd) {
      holdReason = holdReason ?? 'judge-hold: judge budget exhausted';
      outcomes.push({
        check, passed: false, held: true,
        detail: `judge budget exhausted ($${spentUsd.toFixed(4)} >= $${maxUsd.toFixed(2)})`,
      });
      continue;
    }
    try {
      const user = `RUBRIC:\n${check.rubric}\n\nTASK GIVEN TO THE ASSISTANT:\n${input.prompt}\n\nASSISTANT OUTPUT:\n${input.output}`;
      const res = await callJudge(judgeModel, JUDGE_SYSTEM, user);
      spentUsd += estimateCostUsd(judgeModel, res.usage.in, res.usage.out);
      const score = parseJudgeScore(res.text);
      if (score === null) {
        // Unparseable verdict: HELD, never a silent pass or fail.
        holdReason = holdReason ?? 'judge-hold: unparseable judge verdict';
        outcomes.push({ check, passed: false, held: true, detail: `unparseable judge reply: ${res.text.slice(0, 120)}` });
        continue;
      }
      const passed = score >= check.minScore;
      outcomes.push({ check, passed, detail: `judge score ${score}/10 (minScore ${check.minScore}, route ${judgeModel})` });
    } catch (err) {
      // A judge transport failure is HELD — the answer was never graded.
      holdReason = holdReason ?? 'judge-hold: judge call failed';
      outcomes.push({ check, passed: false, held: true, detail: `judge call failed: ${String(err).slice(0, 200)}` });
    }
  }
  return { outcomes, ...(holdReason !== undefined ? { holdReason } : {}) };
}

/** Fold judge outcomes into the code-graded ScoreVector (in place). */
export function mergeJudgeOutcomes(scores: ScoreVector, judged: JudgeGradeResult): void {
  scores.checkOutcomes.push(...judged.outcomes);
  scores.checksTotal += judged.outcomes.length;
  scores.checksPassed += judged.outcomes.filter((o) => o.passed).length;
  if (judged.outcomes.some((o) => !o.passed)) scores.success = false;
  if (judged.holdReason !== undefined) scores.holdReason = judged.holdReason;
}
