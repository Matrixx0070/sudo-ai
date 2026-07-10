/**
 * Tests for trigger-quality evaluation and optimization: confusion-matrix
 * math, deterministic stratified splits, parse robustness, and the optimize
 * loop's core disciplines (test-blinded proposals, best-by-test selection).
 */
import { describe, it, expect } from 'vitest';
import {
  splitEvalSet,
  confusionMatrix,
  runTriggerEval,
  extractJsonArray,
  parseTriggerList,
  parseEvalCases,
  optimizeTriggers,
  generateTriggerEvalSet,
  buildProposalPrompt,
  type TriggerEvalCase,
  type TriggerBrain,
} from '../../src/core/skills/trigger-eval.js';

const CASES: TriggerEvalCase[] = [
  { query: 'tldr this thread for me', shouldTrigger: true },
  { query: 'give me the tldr on the meeting', shouldTrigger: true },
  { query: 'summarize this article', shouldTrigger: true },
  { query: 'write a summary judgment motion', shouldTrigger: false },
  { query: 'what does tld mean in dns', shouldTrigger: false },
  { query: 'translate this to french', shouldTrigger: false },
];

describe('runTriggerEval + confusionMatrix', () => {
  it('computes tp/fp/tn/fn and derived metrics against the real matcher', () => {
    const report = runTriggerEval('tldr', ['tldr', 'summarize this'], CASES);
    const m = report.matrix;
    expect(m.tp).toBe(3);
    expect(m.fn).toBe(0);
    expect(m.fp).toBe(0);
    expect(m.tn).toBe(3);
    expect(m.accuracy).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
  });

  it('records misses and false fires with the matched phrase', () => {
    const report = runTriggerEval('s', ['summary'], CASES);
    const falseFire = report.results.find((r) => r.query.includes('summary judgment'));
    expect(falseFire?.triggered).toBe(true);
    expect(falseFire?.pass).toBe(false);
    expect(falseFire?.matchedPhrase).toBe('summary');
    const missed = report.results.find((r) => r.query.startsWith('tldr this'));
    expect(missed?.pass).toBe(false);
  });

  it('empty matrix yields precision/recall 1, accuracy 0', () => {
    const m = confusionMatrix([]);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.accuracy).toBe(0);
  });
});

describe('splitEvalSet', () => {
  it('is deterministic for a seed and stratified with ≥1 test case per class', () => {
    const a = splitEvalSet(CASES, 0.4, 7);
    const b = splitEvalSet(CASES, 0.4, 7);
    expect(a).toEqual(b);
    expect(a.test.some((c) => c.shouldTrigger)).toBe(true);
    expect(a.test.some((c) => !c.shouldTrigger)).toBe(true);
    expect(a.train.length + a.test.length).toBe(CASES.length);
  });

  it('holdout 0 puts everything in train', () => {
    const s = splitEvalSet(CASES, 0);
    expect(s.test).toHaveLength(0);
    expect(s.train).toHaveLength(CASES.length);
  });

  it('single-member classes stay in train', () => {
    const s = splitEvalSet([CASES[0]!, CASES[3]!], 0.4, 1);
    expect(s.test).toHaveLength(0);
  });
});

describe('parsers', () => {
  it('extractJsonArray tolerates prose wrapping and junk', () => {
    expect(extractJsonArray('sure: ["a"] done')).toEqual(['a']);
    expect(extractJsonArray('nope')).toEqual([]);
  });

  it('parseTriggerList dedupes, lowercases, caps length and count', () => {
    const long = 'x'.repeat(99);
    expect(parseTriggerList(JSON.stringify(['TLDR', 'tldr', '  ', long]))).toEqual(['tldr']);
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `phrase ${i}`));
    expect(parseTriggerList(many)).toHaveLength(20);
  });

  it('parseEvalCases accepts snake and camel case flags', () => {
    const parsed = parseEvalCases('[{"query":"a","should_trigger":true},{"query":"b","shouldTrigger":false},{"query":""}]', 10);
    expect(parsed).toEqual([
      { query: 'a', shouldTrigger: true },
      { query: 'b', shouldTrigger: false },
    ]);
  });
});

function scriptedBrain(replies: string[], record?: string[]): TriggerBrain {
  let i = 0;
  return {
    async call(req) {
      record?.push(req.messages[0]!.content);
      return { content: replies[Math.min(i++, replies.length - 1)] };
    },
  };
}

describe('optimizeTriggers', () => {
  it('improves via proposals and exits when train passes', async () => {
    // Start with a bad set (misses everything); brain proposes a good one.
    const brain = scriptedBrain(['["tldr", "summarize this"]']);
    const report = await optimizeTriggers({
      skillName: 'tldr',
      triggers: ['zzz nonexistent phrase'],
      cases: CASES,
      brain,
      holdout: 0,
      maxIterations: 3,
    });
    expect(report.exitReason).toContain('all_train_passed');
    expect(report.bestTriggers).toEqual(['tldr', 'summarize this']);
    expect(report.finalReport.matrix.accuracy).toBe(1);
  });

  it('proposal prompts are test-blinded and carry anti-repeat history', async () => {
    const prompts: string[] = [];
    const brain = scriptedBrain(['["still bad phrase"]', '["also bad"]'], prompts);
    await optimizeTriggers({
      skillName: 's',
      triggers: ['zzz'],
      cases: CASES,
      brain,
      holdout: 0.4,
      seed: 7,
      maxIterations: 3,
    });
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).not.toMatch(/test accuracy|held-?out/i);
    }
    // Second proposal must list the first attempt as do-not-repeat history.
    expect(prompts[1]).toContain('do NOT repeat');
    expect(prompts[1]).toContain('still bad phrase');
  });

  it('selects best by TEST accuracy when holdout exists', async () => {
    // Iter1 (zzz): 0 train acc... proposal A fixes only some; verify reduce picks max test.
    const brain = scriptedBrain(['["tldr", "summarize this"]']);
    const report = await optimizeTriggers({
      skillName: 'tldr',
      triggers: ['zzz'],
      cases: CASES,
      brain,
      holdout: 0.4,
      seed: 7,
      maxIterations: 2,
    });
    const bestIter = report.history.find((h) => h.triggers === report.bestTriggers || JSON.stringify(h.triggers) === JSON.stringify(report.bestTriggers))!;
    const maxTest = Math.max(...report.history.map((h) => h.testAccuracy ?? 0));
    expect(bestIter.testAccuracy).toBe(maxTest);
  });

  it('stops with proposal_unparseable on junk proposals', async () => {
    const brain = scriptedBrain(['no json here']);
    const report = await optimizeTriggers({ skillName: 's', triggers: ['zzz'], cases: CASES, brain, holdout: 0, maxIterations: 3 });
    expect(report.exitReason).toContain('proposal_unparseable');
  });
});

describe('generateTriggerEvalSet', () => {
  it('parses a usable two-class set', async () => {
    const brain = scriptedBrain(['[{"query":"tldr this","should_trigger":true},{"query":"b","should_trigger":true},{"query":"c","should_trigger":false},{"query":"d","should_trigger":false}]']);
    const cases = await generateTriggerEvalSet('s', '---\nname: s\n---\nbody', brain, 8);
    expect(cases).toHaveLength(4);
  });

  it('throws when the set is unusable', async () => {
    const brain = scriptedBrain(['[{"query":"only one","should_trigger":true}]']);
    await expect(generateTriggerEvalSet('s', 'md', brain)).rejects.toThrow(/eval set/);
  });
});

describe('buildProposalPrompt', () => {
  it('labels misses and false fires distinctly', () => {
    const p = buildProposalPrompt('s', 'desc', ['a'], [
      { query: 'q1', shouldTrigger: true, triggered: false, pass: false },
      { query: 'q2', shouldTrigger: false, triggered: true, matchedPhrase: 'a', pass: false },
    ], []);
    expect(p).toContain('MISSED');
    expect(p).toContain('FALSE FIRE');
    expect(p).toContain('"q2"');
  });
});
