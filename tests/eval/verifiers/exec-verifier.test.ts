/**
 * Tests for ExecVerifier — Phase 1 eval gate.
 *
 * Pure-helper tests run everywhere. The integration test (actually executing python in
 * the sandbox) is skipped when bwrap is not installed locally; CI installs bubblewrap so
 * it exercises the real path.
 */

import { describe, it, expect } from 'vitest';
import {
  ExecVerifier,
  extractLastCodeBlock,
  isSandboxAvailable,
  _resetSandboxCheckCache,
} from '../../../src/core/eval/verifiers/exec-verifier.js';
import type { BenchTask } from '../../../src/core/shared/wave10-types.js';

const TASK: BenchTask = {
  id: 'test',
  name: 'Test',
  prompt: 'test',
  expectedOutput: 'test',
  complexityTier: 'simple',
};

describe('extractLastCodeBlock', () => {
  const RE = /```(?:python|py)?\s*\n([\s\S]*?)```/gi;

  it('returns null when no code block found', () => {
    expect(extractLastCodeBlock('just prose, no fences', RE)).toBeNull();
  });

  it('extracts a single python code block', () => {
    const text = 'before\n```python\nprint("hi")\n```\nafter';
    expect(extractLastCodeBlock(text, RE)).toBe('print("hi")\n');
  });

  it('returns the LAST code block when multiple are present', () => {
    const text = '```python\nfirst = 1\n```\nthen\n```python\nsecond = 2\n```';
    expect(extractLastCodeBlock(text, RE)).toBe('second = 2\n');
  });

  it('matches bare ``` fences without a language', () => {
    const text = '```\nbare = 3\n```';
    expect(extractLastCodeBlock(text, RE)).toBe('bare = 3\n');
  });
});

describe('ExecVerifier — constructor', () => {
  it('throws when heldOutTests is empty', () => {
    expect(() => new ExecVerifier({ heldOutTests: '' })).toThrow('heldOutTests is required');
    expect(() => new ExecVerifier({ heldOutTests: '   ' })).toThrow('heldOutTests is required');
  });
});

describe('ExecVerifier — graceful degradation', () => {
  it('returns "no code block found" when response has no fences', async () => {
    const v = new ExecVerifier({ heldOutTests: 'assert True' });
    const r = await v.verify(TASK, 'plain prose only');
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.detail).toBe('no code block found in response');
    expect(r.type).toBe('exec');
  });

  it('returns "sandbox unavailable" when bwrap is missing', async () => {
    _resetSandboxCheckCache();
    if (isSandboxAvailable()) {
      // Real sandbox present — skip this assertion path
      return;
    }
    const v = new ExecVerifier({ heldOutTests: 'assert True' });
    const r = await v.verify(TASK, '```python\nx = 1\n```');
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.detail).toContain('sandbox unavailable');
  });
});

describe('ExecVerifier — integration with bwrap', () => {
  const HAS_BWRAP = (_resetSandboxCheckCache(), isSandboxAvailable());

  it.skipIf(!HAS_BWRAP)('passes when extracted python satisfies held-out tests', async () => {
    const v = new ExecVerifier({
      language: 'python',
      heldOutTests: 'assert add(2, 3) == 5\nprint("PASS")',
      timeoutMs: 8_000,
    });
    const response = '```python\ndef add(a, b):\n    return a + b\n```';
    const r = await v.verify(TASK, response);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it.skipIf(!HAS_BWRAP)('fails with non-zero exit when held-out tests reject the code', async () => {
    const v = new ExecVerifier({
      language: 'python',
      heldOutTests: 'assert add(2, 3) == 99, "wrong sum"',
      timeoutMs: 8_000,
    });
    const response = '```python\ndef add(a, b):\n    return a + b\n```';
    const r = await v.verify(TASK, response);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/exit=/);
  });
});
