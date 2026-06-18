/**
 * Tests for skill-bench.ts — Wave 10 Builder 2.
 *
 * Covers:
 *   - 3-condition sweep generates correct report shape
 *   - markdownReport contains condition comparison table
 *   - Best condition logic
 *   - Delegation to BenchRunner
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSkillBench } from '../../src/core/eval/skill-bench.js';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import type { BenchTask } from '../../src/core/shared/wave10-types.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-bench-'));
  return path.join(dir, 'bench.db');
}

/** 5 verifier-less tasks — runner falls back to legacy non-empty-response check. */
function makeSimpleTasks(): BenchTask[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: `simple-${i}`,
    name: `Simple task ${i}`,
    prompt: `Echo task ${i}.`,
    expectedOutput: 'non-empty response',
    complexityTier: 'simple',
  }));
}

describe('runSkillBench — 4-condition sweep', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs all 4 conditions and returns report with byCondition', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = { call: vi.fn().mockResolvedValue({ content: 'ok' }) };

    const { report } = await runSkillBench({
      models:  ['model-a'],
      seeds:   1,
      brain,
      store,
      tasks:   makeSimpleTasks(),
    });

    expect(report.byCondition['no_skills']).toBeDefined();
    expect(report.byCondition['skills_on']).toBeDefined();
    expect(report.byCondition['skills_optimized']).toBeDefined();
    expect(report.byCondition['skills_post_optimizer']).toBeDefined();
    expect(report.totalTasks).toBe(20); // 5 tasks × 4 conditions × 1 seed
    store.close();
  });

  it('markdownReport contains condition comparison table', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = { call: vi.fn().mockResolvedValue({ content: 'response text' }) };

    const { markdownReport } = await runSkillBench({
      models:  ['model-x'],
      seeds:   1,
      brain,
      store,
      tasks:   makeSimpleTasks(),
    });

    expect(markdownReport).toContain('Skill Condition Comparison');
    expect(markdownReport).toContain('no_skills');
    expect(markdownReport).toContain('skills_on');
    expect(markdownReport).toContain('skills_optimized');
    expect(markdownReport).toContain('skills_post_optimizer');
    expect(markdownReport).toContain('Best condition');
    store.close();
  });

  it('also includes the BenchRunner markdownSummary', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = { call: vi.fn().mockResolvedValue({ content: 'response' }) };

    const { markdownReport } = await runSkillBench({
      models:  ['my-model'],
      seeds:   1,
      brain,
      store,
      tasks:   makeSimpleTasks(),
    });

    expect(markdownReport).toContain('Benchmark Report');
    store.close();
  });

  it('returns SkillBenchResult with both report and markdownReport', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = { call: vi.fn().mockResolvedValue({ content: 'ok' }) };

    const result = await runSkillBench({ models: ['model'], seeds: 1, brain, store, tasks: makeSimpleTasks() });
    expect(result).toHaveProperty('report');
    expect(result).toHaveProperty('markdownReport');
    expect(typeof result.markdownReport).toBe('string');
    store.close();
  });

  it('works without brain (synthetic results)', async () => {
    const store = new BenchStore(makeTempDb());

    const { report } = await runSkillBench({ models: ['synthetic'], seeds: 1, store, tasks: makeSimpleTasks() });
    expect(report.successRate).toBe(0);
    expect(report.totalTasks).toBe(20); // 5 tasks × 4 conditions × 1 seed
    store.close();
  });

  it('uses subset of tasks when taskIds provided', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = { call: vi.fn().mockResolvedValue({ content: 'ok' }) };

    const { report } = await runSkillBench({
      models:   ['model'],
      taskIds:  ['task-hello'],
      seeds:    1,
      brain,
      store,
    });

    // 1 task × 4 conditions × 1 seed
    expect(report.totalTasks).toBe(4);
    store.close();
  });
});
