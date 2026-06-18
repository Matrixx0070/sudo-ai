/**
 * Tests for StringVerifier — Phase 1 eval gate.
 */

import { describe, it, expect } from 'vitest';
import { StringVerifier } from '../../../src/core/eval/verifiers/string-verifier.js';
import type { BenchTask } from '../../../src/core/shared/wave10-types.js';

const TASK: BenchTask = {
  id: 'test',
  name: 'Test',
  prompt: 'test',
  expectedOutput: 'test',
  complexityTier: 'simple',
};

describe('StringVerifier', () => {
  it('throws when rules array is empty', () => {
    expect(() => new StringVerifier({ rules: [] })).toThrow('at least one rule is required');
  });

  it('passes when all string rules match (default mode "all")', async () => {
    const v = new StringVerifier({ rules: ['hello', 'world'] });
    const r = await v.verify(TASK, 'hello world!');
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.type).toBe('string');
  });

  it('fails when one rule misses in "all" mode', async () => {
    const v = new StringVerifier({ rules: ['hello', 'mars'] });
    const r = await v.verify(TASK, 'hello world!');
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.detail).toContain('mars');
  });

  it('passes in "any" mode when one rule matches', async () => {
    const v = new StringVerifier({ mode: 'any', rules: ['greetings', 'hello', 'mars'] });
    const r = await v.verify(TASK, 'hello there');
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(1 / 3, 3);
  });

  it('fails in "any" mode when no rule matches', async () => {
    const v = new StringVerifier({ mode: 'any', rules: ['a', 'b'] });
    const r = await v.verify(TASK, 'xyz');
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });

  it('matches strings case-insensitively', async () => {
    const v = new StringVerifier({ rules: ['HELLO'] });
    const r = await v.verify(TASK, 'hello world');
    expect(r.passed).toBe(true);
  });

  it('supports RegExp rules', async () => {
    const v = new StringVerifier({ rules: [/\b\d{4}\b/] });
    const r = await v.verify(TASK, 'the answer is 5754 by my count');
    expect(r.passed).toBe(true);
  });

  it('reports missed rule descriptions in detail', async () => {
    const v = new StringVerifier({ rules: ['present', 'missing', /also-missing/] });
    const r = await v.verify(TASK, 'only present here');
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('"missing"');
    expect(r.detail).toContain('also-missing');
  });
});
