/**
 * Tests for prove-before-adopt skill evaluation.
 *
 * Core contracts: position-debiased judging (order-swapped verdicts must
 * agree on the same ARM or the pair is discarded), threshold-driven
 * adopt/reject/inconclusive, and fail-neutral verdict parsing.
 */
import { describe, it, expect } from 'vitest';
import {
  parseVerdict,
  debias,
  aggregate,
  parsePromptList,
  runSkillEval,
  type EvalBrain,
  type PromptResult,
} from '../../src/core/skills/skill-eval.js';
import { evalTool } from '../../src/core/tools/builtin/skill/tools/eval.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const SKILL_MD = '---\nname: t\nversion: 1.0.0\ndescription: test\ncapabilities: []\n---\n# T\nBe concise.';

function result(winner: PromptResult['winner']): PromptResult {
  return { prompt: 'p', winner, reason: '', withChars: 1, withoutChars: 1, withMs: 1, withoutMs: 1 };
}

describe('parseVerdict', () => {
  it('parses A/B/TIE case-insensitively and fails neutral', () => {
    expect(parseVerdict('rationale\nWINNER: A')).toBe('A');
    expect(parseVerdict('winner: b')).toBe('B');
    expect(parseVerdict('WINNER: TIE')).toBe('tie');
    expect(parseVerdict('no verdict here')).toBe('tie');
    expect(parseVerdict('')).toBe('tie');
  });
});

describe('debias (pass1: WITH=A; pass2: WITH=B)', () => {
  it('consistent with-win: (A, B) -> with', () => expect(debias('A', 'B')).toBe('with'));
  it('consistent without-win: (B, A) -> without', () => expect(debias('B', 'A')).toBe('without'));
  it('double tie -> tie', () => expect(debias('tie', 'tie')).toBe('tie'));
  it('position-following judge: (A, A) -> inconsistent', () => expect(debias('A', 'A')).toBe('inconsistent'));
  it('position-following judge: (B, B) -> inconsistent', () => expect(debias('B', 'B')).toBe('inconsistent'));
  it('half-tie degrades to tie, never a win', () => {
    expect(debias('A', 'tie')).toBe('tie');
    expect(debias('tie', 'B')).toBe('tie');
  });
});

describe('aggregate', () => {
  it('adopts at/above threshold', () => {
    const r = aggregate('s', [result('with'), result('with'), result('without')], 0.6);
    expect(r.winRate).toBeCloseTo(2 / 3);
    expect(r.recommendation).toBe('adopt');
  });
  it('rejects below threshold', () => {
    const r = aggregate('s', [result('with'), result('without'), result('without')], 0.6);
    expect(r.recommendation).toBe('reject');
  });
  it('inconclusive when most verdicts are ties/inconsistent', () => {
    const r = aggregate('s', [result('with'), result('tie'), result('tie'), result('inconsistent')], 0.6);
    expect(r.recommendation).toBe('inconclusive');
  });
  it('winRate null with zero decisive verdicts', () => {
    const r = aggregate('s', [result('tie')], 0.6);
    expect(r.winRate).toBeNull();
    expect(r.recommendation).toBe('inconclusive');
  });
});

describe('parsePromptList', () => {
  it('extracts a JSON array from surrounding prose and caps it', () => {
    expect(parsePromptList('Here you go: ["a", "b", "c"] enjoy', 2)).toEqual(['a', 'b']);
  });
  it('returns empty on junk', () => {
    expect(parsePromptList('no array', 3)).toEqual([]);
    expect(parsePromptList('{"not": "array"}', 3)).toEqual([]);
    expect(parsePromptList('[1, 2]', 3)).toEqual([]);
  });
});

/** Scripted brain: generation replies then judge replies, in call order. */
function scriptedBrain(replies: string[]): EvalBrain {
  let i = 0;
  return {
    async call() {
      return { content: replies[Math.min(i++, replies.length - 1)] };
    },
  };
}

describe('runSkillEval', () => {
  it('with-skill win via consistent order-swapped verdicts', async () => {
    // Calls per prompt: with-gen, without-gen, judge pass1, judge pass2.
    const brain = scriptedBrain(['with answer', 'without answer', 'good\nWINNER: A', 'good\nWINNER: B']);
    const report = await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['test prompt'] });
    expect(report.wins).toBe(1);
    expect(report.recommendation).toBe('adopt');
  });

  it('position-following judge counts as inconsistent, not a win', async () => {
    const brain = scriptedBrain(['with', 'without', 'WINNER: A', 'WINNER: A']);
    const report = await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['p'] });
    expect(report.inconsistent).toBe(1);
    expect(report.wins).toBe(0);
    expect(report.recommendation).toBe('inconclusive');
  });

  it('auto-generates prompts when none provided', async () => {
    const brain = scriptedBrain(['["generated prompt"]', 'with', 'without', 'WINNER: A', 'WINNER: B']);
    const report = await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, maxPrompts: 1 });
    expect(report.prompts).toBe(1);
    expect(report.results[0]!.prompt).toBe('generated prompt');
  });

  it('throws when prompt generation fails', async () => {
    const brain = scriptedBrain(['not an array at all']);
    await expect(runSkillEval({ skillName: 't', markdown: SKILL_MD, brain })).rejects.toThrow(/test prompts/);
  });
});

describe('skill.eval tool', () => {
  const mkCtx = (brain?: EvalBrain): ToolContext =>
    ({ sessionId: 's', workingDir: '/tmp', config: brain ? { brain } : {}, logger: null } as unknown as ToolContext);

  it('evaluates inline markdown end to end', async () => {
    const brain = scriptedBrain(['with', 'without', 'r\nWINNER: A', 'r\nWINNER: B']);
    const res = await evalTool.execute({ markdown: SKILL_MD, prompts: ['do the thing'] }, mkCtx(brain));
    expect(res.success).toBe(true);
    expect(res.output).toContain('ADOPT');
    expect((res.data as { report: { wins: number } }).report.wins).toBe(1);
  });

  it('fails gracefully without a brain', async () => {
    const res = await evalTool.execute({ markdown: SKILL_MD }, mkCtx(undefined));
    expect(res.success).toBe(false);
    expect(res.output).toContain('brain is not available');
  });

  it('requires a name or markdown', async () => {
    const brain = scriptedBrain(['x']);
    const res = await evalTool.execute({}, mkCtx(brain));
    expect(res.success).toBe(false);
    expect(res.output).toContain('Provide a skill');
  });
});

describe('v2: rubric scores, variance, majority, assertions', () => {
  it('parseScores parses the SCORES line leniently and normalizes', async () => {
    const { parseScores } = await import('../../src/core/skills/skill-eval.js');
    expect(parseScores('rationale\nSCORES: A=17/20 B=14/20\nWINNER: A')).toEqual({ a: 0.85, b: 0.7 });
    expect(parseScores('scores: a = 3/5 b = 4/5')).toEqual({ a: 0.6, b: 0.8 });
    expect(parseScores('no scores here')).toBeNull();
    expect(parseScores('SCORES: A=1/0 B=1/1')).toBeNull();
  });

  it('sampleStddev computes n-1 stddev', async () => {
    const { sampleStddev } = await import('../../src/core/skills/skill-eval.js');
    expect(sampleStddev([1, 1, 1])).toBe(0);
    expect(sampleStddev([0, 1])).toBeCloseTo(Math.SQRT1_2, 5);
    expect(sampleStddev([1])).toBeUndefined();
  });

  it('majorityWinner needs a strict plurality', async () => {
    const { majorityWinner } = await import('../../src/core/skills/skill-eval.js');
    expect(majorityWinner(['with', 'with', 'without'])).toBe('with');
    expect(majorityWinner(['with', 'without'])).toBe('tie');
    expect(majorityWinner(['inconsistent', 'inconsistent', 'tie'])).toBe('inconsistent');
  });

  it('runs=2 produces per-run win rates, stddev, and averaged rubric scores', async () => {
    // Per run: with-gen, without-gen, j1, j2. Two runs, one prompt.
    const brain = scriptedBrain([
      'w1', 'wo1', 'r\nSCORES: A=18/20 B=10/20\nWINNER: A', 'r\nSCORES: A=10/20 B=18/20\nWINNER: B',
      'w2', 'wo2', 'r\nSCORES: A=16/20 B=12/20\nWINNER: A', 'r\nSCORES: A=12/20 B=16/20\nWINNER: B',
    ]);
    const report = await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['p'], runs: 2 });
    expect(report.runsPerPrompt).toBe(2);
    expect(report.results[0]!.winner).toBe('with');
    expect(report.results[0]!.runWinners).toEqual(['with', 'with']);
    expect(report.perRunWinRates).toEqual([1, 1]);
    expect(report.winRateStddev).toBe(0);
    expect(report.results[0]!.withScore).toBeCloseTo(0.85, 5);
    expect(report.results[0]!.withoutScore).toBeCloseTo(0.55, 5);
  });

  it('assertions grade both arms and flag non-discriminating ones', async () => {
    // Order: with-gen, without-gen, j1, j2, assertions-vs-with, assertions-vs-without.
    const brain = scriptedBrain([
      'with', 'without', 'WINNER: A', 'WINNER: B',
      '[{"passed":true,"evidence":"bold line present"},{"passed":true,"evidence":"exists"}]',
      '[{"passed":false,"evidence":""},{"passed":true,"evidence":"also exists"}]',
    ]);
    const report = await runSkillEval({
      skillName: 't', markdown: SKILL_MD, brain, prompts: ['p'],
      assertions: ['has a bolded takeaway', 'mentions the topic'],
    });
    expect(report.assertions).toHaveLength(2);
    expect(report.assertions![0]).toMatchObject({ withPassed: true, withoutPassed: false, discriminating: true });
    expect(report.assertions![1]).toMatchObject({ withPassed: true, withoutPassed: true, discriminating: false });
    expect(report.nonDiscriminatingAssertions).toEqual(['mentions the topic']);
  });

  it('evalAssertions fails closed on unparseable grader replies', async () => {
    const { evalAssertions } = await import('../../src/core/skills/skill-eval.js');
    const brain = scriptedBrain(['not json']);
    const res = await evalAssertions(brain, 'fast', 'task', 'output', ['a1']);
    expect(res[0]!.passed).toBe(false);
    expect(res[0]!.evidence).toContain('failed closed');
  });

  it('v1-shaped calls are unchanged (runs default 1, no extras)', async () => {
    const brain = scriptedBrain(['with', 'without', 'r\nWINNER: A', 'r\nWINNER: B']);
    const report = await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['p'] });
    expect(report.runsPerPrompt).toBe(1);
    expect(report.perRunWinRates).toBeUndefined();
    expect(report.assertions).toBeUndefined();
    expect(report.recommendation).toBe('adopt');
  });
});
