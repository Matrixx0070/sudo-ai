import { describe, expect, it } from 'vitest';
import {
  gradeRung4, gradeRung5, judgeIsIndependent, consistencyK,
} from '../../../src/core/eval/sandbox/ladder-judged.js';
import { runLadderRung } from '../../../src/core/eval/sandbox/ladder.js';

const judge = (score: number) => async () => ({ text: `{"score": ${score}, "reason": "x"}`, usage: { in: 1, out: 1 } });

describe('invariant 7 — judge independence', () => {
  it('detects same-provider vs cross-provider', () => {
    expect(judgeIsIndependent('claude-oauth/haiku', 'claude-oauth/opus')).toBe(false);
    expect(judgeIsIndependent('claude-oauth/haiku', 'ollama/glm')).toBe(true);
  });

  it('HOLDS a judged rung when the judge shares the provider — before any spend', async () => {
    let called = false;
    const rep = await runLadderRung(4, 'claude-oauth/claude-opus-5', {
      noCache: true,
      judgeModel: 'claude-oauth/claude-haiku-4-5',
      callRoute: async () => { called = true; throw new Error('must not be called'); },
    });
    expect(rep.judgeHeld).toBe(true);
    expect(rep.admitted).toBe(false);
    expect(rep.reason).toContain('invariant 7');
    expect(rep.spentUsd).toBe(0);
    expect(called).toBe(false); // refused BEFORE spending
  });
});

describe('rung 4', () => {
  it('requires a rubric', async () => {
    const r = await gradeRung4({}, 'x', 'j/m', judge(10));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('rubric');
  });

  it('fails on the programmatic assertion WITHOUT calling the judge', async () => {
    let judged = false;
    const r = await gradeRung4(
      { rubric: 'anything', outputContains: 'Lisbon' },
      'no city here',
      'j/m',
      async () => { judged = true; return { text: '{"score":10}', usage: { in: 1, out: 1 } }; },
    );
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('assertion');
    expect(judged).toBe(false);
  });

  it('passes/fails on the judge score against minScore', async () => {
    expect((await gradeRung4({ rubric: 'r' }, 'out', 'j/m', judge(9))).passed).toBe(true);
    expect((await gradeRung4({ rubric: 'r' }, 'out', 'j/m', judge(3))).passed).toBe(false);
    expect((await gradeRung4({ rubric: 'r', minScore: 2 }, 'out', 'j/m', judge(3))).passed).toBe(true);
  });

  it('fails (never throws) when the judge call errors or is unparseable', async () => {
    const err = await gradeRung4({ rubric: 'r' }, 'o', 'j/m', async () => { throw new Error('boom'); });
    expect(err.passed).toBe(false);
    expect(err.detail).toContain('judge call failed');
    const bad = await gradeRung4({ rubric: 'r' }, 'o', 'j/m', async () => ({ text: 'no json', usage: { in: 1, out: 1 } }));
    expect(bad.passed).toBe(false);
  });
});

describe('rung 5 self-consistency', () => {
  it('needs at least 2 usable samples — one answer can never prove consistency', async () => {
    const r = await gradeRung5({}, ['only one'], 'j/m', judge(10));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('>=2');
    const empty = await gradeRung5({}, ['a', '   ', ''], 'j/m', judge(10));
    expect(empty.passed).toBe(false);
  });

  it('passes when the judge scores consistency at/above minScore', async () => {
    expect((await gradeRung5({}, ['a', 'a'], 'j/m', judge(9))).passed).toBe(true);
    expect((await gradeRung5({}, ['a', 'b'], 'j/m', judge(4))).passed).toBe(false);
  });

  it('rejects unknown expect keys', async () => {
    const r = await gradeRung5({ nope: 1 }, ['a', 'b'], 'j/m', judge(10));
    expect(r.detail).toContain('unknown rung-5 expect key');
  });

  it('samples each item k times through the route', async () => {
    const prev = process.env['SUDO_EVAL_LADDER_CONSISTENCY_K'];
    process.env['SUDO_EVAL_LADDER_CONSISTENCY_K'] = '2';
    try {
      expect(consistencyK()).toBe(2);
      let calls = 0;
      const rep = await runLadderRung(5, 'ollama/glm', {
        noCache: true, judgeModel: 'claude-oauth/haiku', judgeCall: judge(10),
        callRoute: async () => {
          calls += 1;
          return { blocks: [{ type: 'text', text: 'same answer' }], usage: { in: 1, out: 1 }, stopReason: 'end_turn' };
        },
      });
      expect(calls).toBe(rep.n * 2); // k samples per item
      expect(rep.passRate).toBe(1);
      expect(rep.admitted).toBe(false); // n=4 < minN 20
    } finally {
      if (prev === undefined) delete process.env['SUDO_EVAL_LADDER_CONSISTENCY_K'];
      else process.env['SUDO_EVAL_LADDER_CONSISTENCY_K'] = prev;
    }
  });
});
