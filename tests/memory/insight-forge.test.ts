/**
 * @file tests/memory/insight-forge.test.ts
 * @description Tests for reciprocalRankFusion and forgeInsights (typed generics).
 */

import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion, forgeInsights, type SubQuestion } from '../../src/core/memory/insight-forge.js';

interface Hit { id: string; content: string; }

describe('reciprocalRankFusion', () => {
  it('IF-1: merges sets by RRF score, best-supported item first', () => {
    const setA: Hit[] = [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }];
    const setB: Hit[] = [{ id: 'b', content: 'B again' }, { id: 'c', content: 'C' }];
    const merged = reciprocalRankFusion([setA, setB], 'id', 60);
    // b: 1/61 + 1/60 > a: 1/60 > c: 1/61
    expect(merged.map((m) => m.id)).toEqual(['b', 'a', 'c']);
    expect(merged[0]!._rrfScore).toBeCloseTo(1 / 61 + 1 / 60);
    // First-seen copy is kept (setA's 'b'), score attached
    expect(merged[0]!.content).toBe('B');
  });

  it('IF-2: items missing the idKey are skipped', () => {
    const sets = [[{ id: 'a' }, { content: 'no id' } as { id?: string; content?: string }]];
    const merged = reciprocalRankFusion(sets, 'id');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('a');
  });

  it('IF-3: empty input yields empty output', () => {
    expect(reciprocalRankFusion<Hit>([], 'id')).toEqual([]);
    expect(reciprocalRankFusion<Hit>([[], []], 'id')).toEqual([]);
  });
});

describe('forgeInsights', () => {
  const decompose = async (): Promise<SubQuestion[]> => [
    { question: 'q1', intent: 'factual' },
    { question: 'q2', intent: 'contextual' },
  ];

  it('IF-4: searches each sub-question and merges typed hits', async () => {
    const search = async (query: string): Promise<Hit[]> =>
      query === 'q1' ? [{ id: 'x', content: 'X' }] : [{ id: 'x', content: 'X2' }, { id: 'y', content: 'Y' }];
    const result = await forgeInsights(search, decompose, 'original');
    expect(result.subQuestions).toHaveLength(2);
    expect(result.results.map((r) => r.subQuestion)).toEqual(['q1', 'q2']);
    expect(result.merged[0]!.id).toBe('x');
    expect(result.merged[0]!.content).toBe('X');
    expect(typeof result.merged[0]!._rrfScore).toBe('number');
  });

  it('IF-5: decompose failure falls back to the original query; search failure yields empty hits', async () => {
    const failingDecompose = async (): Promise<SubQuestion[]> => { throw new Error('boom'); };
    const failingSearch = async (): Promise<Hit[]> => { throw new Error('boom'); };
    const result = await forgeInsights(failingSearch, failingDecompose, 'original');
    expect(result.subQuestions).toEqual([{ question: 'original', intent: 'factual' }]);
    expect(result.results).toEqual([{ subQuestion: 'original', hits: [] }]);
    expect(result.merged).toEqual([]);
  });
});
