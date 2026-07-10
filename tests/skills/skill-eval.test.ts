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
    const report = await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['p'], runs: 2, concurrency: 1 }); // order-scripted brain needs legacy call order
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

// ---------------------------------------------------------------------------
// Concurrency: the sequential-latency defect class + the bounded fan-out fix
// ---------------------------------------------------------------------------

/**
 * Content-routed brain: replies derive ONLY from the request content (never
 * call order), so reports must be identical at any concurrency. Latency per
 * call varies by call index to scramble completion order.
 */
function contentBrain(latency: (call: number) => number): EvalBrain & { calls: number; maxInFlight: number } {
  const state = {
    calls: 0,
    maxInFlight: 0,
    inFlight: 0,
    async call(req: { messages: Array<{ role: string; content: string }> }) {
      const idx = state.calls++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((r) => setTimeout(r, latency(idx)));
      state.inFlight--;
      const user = req.messages[req.messages.length - 1]!.content;
      const hasSystem = req.messages.some((m) => m.role === 'system');
      if (user.includes('Grade each assertion')) {
        const passed = /--- RESPONSE ---\nWITH::/.test(user);
        return { content: `[{"passed":${passed},"evidence":"e1"},{"passed":${passed},"evidence":"e2"}]` };
      }
      if (user.includes('judging which of two responses')) {
        if (!user.includes('pwin')) return { content: 'even\nSCORES: A=3/5 B=3/5\nWINNER: TIE' };
        const aIsWith = /--- RESPONSE A ---\nWITH::/.test(user);
        return {
          content: aIsWith
            ? 'with better\nSCORES: A=4/5 B=2/5\nWINNER: A'
            : 'with better\nSCORES: A=2/5 B=4/5\nWINNER: B',
        };
      }
      return { content: `${hasSystem ? 'WITH' : 'BASE'}::${user}` };
    },
  };
  return state;
}

/** Strip wall-clock fields so reports compare on substance only. */
function stripMs(report: Awaited<ReturnType<typeof runSkillEval>>): unknown {
  return { ...report, results: report.results.map((r) => ({ ...r, withMs: 0, withoutMs: 0 })) };
}

describe('THE DEFECT CLASS — sequential eval latency scales with call count', () => {
  it('concurrency 1 (legacy shape): 12 independent calls take ~12x per-call latency', async () => {
    const brain = contentBrain(() => 25);
    const start = Date.now();
    await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['pwin a', 'pwin b', 'pwin c'], concurrency: 1 });
    const ms = Date.now() - start;
    expect(brain.calls).toBe(12);
    expect(brain.maxInFlight).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(280); // ~12 x 25ms, linear
  }, 15_000);

  it('bounded fan-out cuts wall-clock to ~stage depth, results identical', async () => {
    const seq = contentBrain(() => 25);
    const par = contentBrain(() => 25);
    const opts = { skillName: 't', markdown: SKILL_MD, prompts: ['pwin a', 'pwin b', 'pwin c'] };
    const t0 = Date.now();
    const seqReport = await runSkillEval({ ...opts, brain: seq, concurrency: 1 });
    const seqMs = Date.now() - t0;
    const t1 = Date.now();
    const parReport = await runSkillEval({ ...opts, brain: par, concurrency: 3 });
    const parMs = Date.now() - t1;
    expect(parMs).toBeLessThan(seqMs / 1.8); // >=1.8x speedup with generous CI margin
    expect(stripMs(parReport)).toEqual(stripMs(seqReport));
  }, 15_000);
});

describe('concurrent eval determinism and bounds', () => {
  it('report is identical at concurrency 1 vs 4 with scrambled completion order (runs=2 + assertions)', async () => {
    const mk = (): Parameters<typeof runSkillEval>[0] => ({
      skillName: 't',
      markdown: SKILL_MD,
      brain: contentBrain((i) => (i * 7) % 13),
      prompts: ['pwin one', 'plain two', 'pwin three'],
      runs: 2,
      assertions: ['a1', 'a2'],
    });
    const sequential = await runSkillEval({ ...mk(), concurrency: 1 });
    const parallel = await runSkillEval({ ...mk(), concurrency: 4 });
    expect(stripMs(parallel)).toEqual(stripMs(sequential));
    expect(parallel.wins).toBe(2);
    expect(parallel.perRunWinRates).toEqual(sequential.perRunWinRates);
    expect(parallel.assertions).toEqual(sequential.assertions);
  });

  it('unit cap bounds in-flight calls (2 units x 2-call stages -> <=4, >=2)', async () => {
    const brain = contentBrain(() => 10);
    await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['p1', 'p2', 'p3'], concurrency: 2 });
    expect(brain.maxInFlight).toBeLessThanOrEqual(4);
    expect(brain.maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('SUDO_SKILL_EVAL_CONCURRENCY=1 forces sequential when no option given', async () => {
    const saved = process.env['SUDO_SKILL_EVAL_CONCURRENCY'];
    process.env['SUDO_SKILL_EVAL_CONCURRENCY'] = '1';
    try {
      const brain = contentBrain(() => 5);
      await runSkillEval({ skillName: 't', markdown: SKILL_MD, brain, prompts: ['p1', 'p2'] });
      expect(brain.maxInFlight).toBe(1);
    } finally {
      if (saved === undefined) delete process.env['SUDO_SKILL_EVAL_CONCURRENCY'];
      else process.env['SUDO_SKILL_EVAL_CONCURRENCY'] = saved;
    }
  });

  it('resolveEvalConcurrency clamps and prioritizes option > env > default', async () => {
    const { resolveEvalConcurrency } = await import('../../src/core/skills/skill-eval.js');
    const saved = process.env['SUDO_SKILL_EVAL_CONCURRENCY'];
    try {
      delete process.env['SUDO_SKILL_EVAL_CONCURRENCY'];
      expect(resolveEvalConcurrency()).toBe(3);
      expect(resolveEvalConcurrency(99)).toBe(8);
      expect(resolveEvalConcurrency(0)).toBe(1);
      process.env['SUDO_SKILL_EVAL_CONCURRENCY'] = '6';
      expect(resolveEvalConcurrency()).toBe(6);
      expect(resolveEvalConcurrency(2)).toBe(2);
      process.env['SUDO_SKILL_EVAL_CONCURRENCY'] = 'garbage';
      expect(resolveEvalConcurrency()).toBe(3);
    } finally {
      if (saved === undefined) delete process.env['SUDO_SKILL_EVAL_CONCURRENCY'];
      else process.env['SUDO_SKILL_EVAL_CONCURRENCY'] = saved;
    }
  });
});
