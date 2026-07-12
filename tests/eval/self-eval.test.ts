/**
 * self-eval (gap #4) — proves the loop A/Bs a behaviour directive against
 * baseline, names keep/revert from the pass delta, and gates adoption.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runSelfEval, getAdoptedDirectives, adoptDirective, __resetSelfEvalCacheForTests, type SelfEvalBrain } from '../../src/core/eval/self-eval.js';

/** Mock brain: only produces the required phrase when the directive is present. */
const directiveHelpsBrain: SelfEvalBrain = {
  async call({ messages }) {
    const hasDirective = messages.some((m) => m.role === 'system');
    return { content: hasDirective ? 'the answer is 42 exactly' : 'i am not sure' };
  },
};

/** Mock brain: directive makes things worse. */
const directiveHurtsBrain: SelfEvalBrain = {
  async call({ messages }) {
    const hasDirective = messages.some((m) => m.role === 'system');
    return { content: hasDirective ? 'off topic rambling' : 'the answer is 42 exactly' };
  },
};

const TASKS = [
  { prompt: 'What is the answer?', mustInclude: ['42'] },
  { prompt: 'Give the exact number.', expect: '42' },
];

describe('runSelfEval — keep/revert verdict', () => {
  it('names KEEP when the directive improves pass-rate', async () => {
    const r = await runSelfEval(directiveHelpsBrain, { directive: 'Always answer with the exact number.', tasks: TASKS });
    expect(r.baselinePass).toBe(0);
    expect(r.candidatePass).toBe(1);
    expect(r.passDelta).toBe(1);
    expect(r.verdict).toBe('keep');
    expect(r.scored).toBe(true);
  });

  it('names REVERT when the directive hurts pass-rate', async () => {
    const r = await runSelfEval(directiveHurtsBrain, { directive: 'Ramble off topic.', tasks: TASKS });
    expect(r.verdict).toBe('revert');
    expect(r.passDelta).toBeLessThan(0);
  });

  it('throws without a directive or tasks', async () => {
    await expect(runSelfEval(directiveHelpsBrain, { directive: '', tasks: TASKS })).rejects.toThrow();
    await expect(runSelfEval(directiveHelpsBrain, { directive: 'x', tasks: [] })).rejects.toThrow();
  });
});

describe('adoption gating (default OFF = byte-stable prompt)', () => {
  afterEach(() => { delete process.env['SUDO_SELF_EVAL_ADOPT']; __resetSelfEvalCacheForTests(); });

  it('does not adopt or inject when SUDO_SELF_EVAL_ADOPT is unset', () => {
    delete process.env['SUDO_SELF_EVAL_ADOPT'];
    __resetSelfEvalCacheForTests();
    expect(adoptDirective('Be concise.', 'test')).toBe(false);
    expect(getAdoptedDirectives()).toEqual([]);
  });
});
