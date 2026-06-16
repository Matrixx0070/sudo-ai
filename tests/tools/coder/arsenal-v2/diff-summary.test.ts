/**
 * @file diff-summary.test.ts
 * @description Tests for the bounded diff-summary builder used by the critic.
 */

import { describe, it, expect } from 'vitest';
import { buildDiffSummary } from '../../../../src/core/tools/builtin/coder/arsenal-v2/diff-summary.js';
import type { PatchOpResult } from '../../../../src/core/tools/builtin/coder/arsenal-v2/patch-types.js';

describe('buildDiffSummary', () => {
  it('returns a placeholder for empty input', () => {
    expect(buildDiffSummary([])).toBe('(no patch ops)');
  });

  it('renders an applied str_replace with old + new snippets', () => {
    const r: PatchOpResult = {
      op: { op: 'str_replace', file: 'src/foo.ts', old: 'const x = 1', new: 'const x = 2' },
      status: 'applied',
    };
    const out = buildDiffSummary([r]);
    expect(out).toMatch(/\[✓ applied\] str_replace → src\/foo\.ts/);
    expect(out).toMatch(/--- old ---\nconst x = 1/);
    expect(out).toMatch(/--- new ---\nconst x = 2/);
  });

  it('renders insert_after with anchor + inserted blocks', () => {
    const r: PatchOpResult = {
      op: { op: 'insert_after', file: 'src/foo.ts', anchor: 'const x = 1', content: 'const y = 2' },
      status: 'applied',
    };
    const out = buildDiffSummary([r]);
    expect(out).toMatch(/--- anchor ---\nconst x = 1/);
    expect(out).toMatch(/--- inserted ---\nconst y = 2/);
  });

  it('renders create_file with content block', () => {
    const r: PatchOpResult = {
      op: { op: 'create_file', file: 'src/new.ts', content: 'export const z = 3' },
      status: 'applied',
    };
    const out = buildDiffSummary([r]);
    expect(out).toMatch(/--- content ---\nexport const z = 3/);
  });

  it('renders delete_file as a header-only line', () => {
    const r: PatchOpResult = {
      op: { op: 'delete_file', file: 'src/gone.ts' },
      status: 'applied',
    };
    const out = buildDiffSummary([r]);
    expect(out).toBe('[✓ applied] delete_file → src/gone.ts');
  });

  it('lists skipped ops as header + reason + detail one-liner without snippets', () => {
    const r: PatchOpResult = {
      op: { op: 'str_replace', file: 'src/foo.ts', old: 'AAA', new: 'BBB' },
      status: 'skipped',
      reason: 'drift_detected',
      detail: 'old not found in current file',
    };
    const out = buildDiffSummary([r]);
    expect(out).toMatch(/\[↷ skipped: drift_detected\] str_replace → src\/foo\.ts/);
    expect(out).toMatch(/detail: old not found in current file/);
    expect(out).not.toMatch(/--- old ---/);
  });

  it('lists failed ops similarly', () => {
    const r: PatchOpResult = {
      op: { op: 'delete_file', file: 'src/gone.ts' },
      status: 'failed',
      reason: 'file_not_found',
    };
    const out = buildDiffSummary([r]);
    expect(out).toMatch(/\[✗ failed: file_not_found\] delete_file → src\/gone\.ts/);
  });

  it('truncates per-snippet at the 2KB cap', () => {
    const big = 'x'.repeat(5000);
    const r: PatchOpResult = {
      op: { op: 'str_replace', file: 'src/foo.ts', old: big, new: 'y' },
      status: 'applied',
    };
    const out = buildDiffSummary([r]);
    expect(out).toMatch(/\[\.\.\. truncated 2952 chars \.\.\.\]/);
  });

  it('caps total output and notes the overflow', () => {
    // Each op contributes ~ (header ~ 50) + 2 * 2048 snippet bytes when at cap.
    // 32_768 / ~4150 ≈ 7-8 fit before overflow kicks in. Generate 20 to force it.
    const big = 'x'.repeat(2100); // > SNIPPET_CAP so each rendered op is ~4KB.
    const results: PatchOpResult[] = Array.from({ length: 20 }, (_, i) => ({
      op: { op: 'str_replace', file: `src/f${i}.ts`, old: big, new: big },
      status: 'applied' as const,
    }));
    const out = buildDiffSummary(results);
    expect(out).toMatch(/\[\.\.\. \d+ more op\(s\) omitted — diff summary capped at 32768 chars \.\.\.\]/);
  });
});
