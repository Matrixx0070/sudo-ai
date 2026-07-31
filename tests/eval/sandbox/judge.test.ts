/**
 * ADR-0007 Phase 3 — LLM judge grader (rung 4/5): pass/fail on rubric score,
 * HOLD on same-provider route (invariant 7), HOLD on budget exhaustion, HOLD
 * on unparseable/failed judge calls; merge semantics into the score vector.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  evalJudgeModel,
  gradeJudgeChecks,
  judgeConflictsWithTurn,
  mergeJudgeOutcomes,
  parseJudgeScore,
  type JudgeCheck,
} from '../../../src/core/eval/sandbox/judge.js';
import type { ScoreVector } from '../../../src/core/eval/sandbox/graders.js';

const check = (minScore = 5): JudgeCheck => ({ type: 'judge', rubric: 'answer is correct and complete', minScore });

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['SUDO_EVAL_JUDGE_ROUTE', 'SUDO_EVAL_JUDGE_MAX_USD']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const input = (routes: string[] = ['xai:chat']) => ({ prompt: 'task', output: 'answer', routesServed: routes });

describe('judge route pinning', () => {
  it('defaults to the fleet judge alias (oauth haiku) and honors SUDO_EVAL_JUDGE_ROUTE', () => {
    expect(evalJudgeModel()).toBe('claude-oauth/claude-haiku-4-5-20251001');
    process.env['SUDO_EVAL_JUDGE_ROUTE'] = 'openai/o4-mini';
    expect(evalJudgeModel()).toBe('openai/o4-mini');
  });

  it('detects a provider conflict between judge and turn routes', () => {
    expect(judgeConflictsWithTurn('claude-oauth/claude-haiku-4-5', ['claude-oauth:messages'])).toBe(true);
    expect(judgeConflictsWithTurn('claude-oauth/claude-haiku-4-5', ['xai:chat', 'ollama:chat'])).toBe(false);
    expect(judgeConflictsWithTurn('openai/o4-mini', [])).toBe(false);
  });
});

describe('parseJudgeScore', () => {
  it('parses JSON verdicts, bare numbers, and clamps to 0..10', () => {
    expect(parseJudgeScore('{"score": 7.5, "reason": "ok"}')).toBe(7.5);
    expect(parseJudgeScore('Score: 9 out of 10')).toBe(9);
    expect(parseJudgeScore('{"score": 42}')).toBe(10);
    expect(parseJudgeScore('no digits here')).toBeNull();
  });
});

describe('gradeJudgeChecks', () => {
  it('passes when score >= minScore, fails (not held) when below', async () => {
    const r = await gradeJudgeChecks([check(5), check(9)], input(), {
      callJudge: async () => ({ text: '{"score": 8}', usage: { in: 100, out: 20 } }),
    });
    expect(r.outcomes[0]).toMatchObject({ passed: true });
    expect(r.outcomes[1]).toMatchObject({ passed: false });
    expect(r.outcomes[1]?.held).toBeUndefined();
    expect(r.holdReason).toBeUndefined();
  });

  it('HOLDs every check when the judge provider served the turn (invariant 7)', async () => {
    let called = 0;
    const r = await gradeJudgeChecks([check(), check()], input(['claude-oauth:messages']), {
      callJudge: async () => { called += 1; return { text: '{"score": 10}', usage: { in: 1, out: 1 } }; },
    });
    expect(called).toBe(0); // no judge call is even made
    expect(r.holdReason).toBe('judge-hold: no independent route');
    for (const o of r.outcomes) {
      expect(o.held).toBe(true);
      expect(o.passed).toBe(false);
    }
  });

  it('HOLDs remaining checks once the judge budget is exhausted', async () => {
    process.env['SUDO_EVAL_JUDGE_MAX_USD'] = '0';
    const r = await gradeJudgeChecks([check()], input(), {
      callJudge: async () => ({ text: '{"score": 10}', usage: { in: 1, out: 1 } }),
    });
    expect(r.outcomes[0]?.held).toBe(true);
    expect(r.holdReason).toBe('judge-hold: judge budget exhausted');
  });

  it('HOLDs on an unparseable verdict and on a throwing judge call', async () => {
    const bad = await gradeJudgeChecks([check()], input(), {
      callJudge: async () => ({ text: 'sorry, I refuse', usage: { in: 1, out: 1 } }),
    });
    expect(bad.outcomes[0]?.held).toBe(true);
    const thrown = await gradeJudgeChecks([check()], input(), {
      callJudge: async () => { throw new Error('transport down'); },
    });
    expect(thrown.outcomes[0]?.held).toBe(true);
    expect(thrown.holdReason).toBe('judge-hold: judge call failed');
  });
});

describe('mergeJudgeOutcomes', () => {
  const base = (): ScoreVector => ({
    success: true, checksPassed: 2, checksTotal: 2,
    efficiency: { wallMs: 10, steps: 1 },
    policyViolations: 0, deniedToolAttempts: 0, checkOutcomes: [],
  });

  it('a held judge check forces overall success false with the hold reason', () => {
    const scores = base();
    mergeJudgeOutcomes(scores, {
      outcomes: [{ check: check(), passed: false, held: true, detail: 'no independent route' }],
      holdReason: 'judge-hold: no independent route',
    });
    expect(scores.success).toBe(false);
    expect(scores.holdReason).toBe('judge-hold: no independent route');
    expect(scores.checksTotal).toBe(3);
    expect(scores.checksPassed).toBe(2);
  });

  it('a passing judge check keeps success true and counts', () => {
    const scores = base();
    mergeJudgeOutcomes(scores, { outcomes: [{ check: check(), passed: true, detail: 'score 8/10' }] });
    expect(scores.success).toBe(true);
    expect(scores.checksPassed).toBe(3);
  });
});
