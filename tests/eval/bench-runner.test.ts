/**
 * Tests for bench-runner.ts — Wave 10 Builder 2.
 *
 * Covers:
 *   - Mock brain calls, result aggregation, BenchReport generation
 *   - Multi-model sweep
 *   - Conditions filter
 *   - Missing brain → synthetic failure results
 *   - Markdown summary content
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BenchRunner } from '../../src/core/eval/bench-runner.js';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  return path.join(dir, 'bench.db');
}

function makeSuccessBrain(): import('../../src/core/eval/bench-runner.js').BrainCallable {
  return {
    call: vi.fn().mockResolvedValue({ content: 'Test response from model' }),
  };
}

// ---------------------------------------------------------------------------
// BenchRunner tests
// ---------------------------------------------------------------------------

describe('BenchRunner — basic sweep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs with a single model and returns a BenchReport', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain  = makeSuccessBrain();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['test-model'],
      conditions: ['no_skills'],
      seeds:      1,
      brain,
      store,
    });

    expect(report).toBeDefined();
    expect(typeof report.runId).toBe('string');
    expect(report.totalTasks).toBe(5); // 5 built-in tasks × 1 condition × 1 seed
    expect(report.successRate).toBe(1); // mock brain always succeeds
    expect(report.markdownSummary).toContain('Benchmark Report');
    store.close();
  });

  it('reports 0 successRate when brain is absent (synthetic)', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['fallback-model'],
      conditions: ['no_skills'],
      seeds:      1,
      store,
    });

    expect(report.successRate).toBe(0); // no brain → all fail
    expect(report.totalTasks).toBe(5);
    store.close();
  });

  it('sweeps multiple models and aggregates byModel correctly', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain  = makeSuccessBrain();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['model-a', 'model-b'],
      conditions: ['no_skills'],
      seeds:      1,
      brain,
      store,
    });

    expect(Object.keys(report.byModel)).toContain('model-a');
    expect(Object.keys(report.byModel)).toContain('model-b');
    expect(report.totalTasks).toBe(10); // 5 tasks × 2 models × 1 condition × 1 seed
    store.close();
  });

  it('sweeps multiple conditions and aggregates byCondition', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain  = makeSuccessBrain();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['model-x'],
      conditions: ['no_skills', 'skills_on'],
      seeds:      1,
      brain,
      store,
    });

    expect(report.byCondition['no_skills']).toBeDefined();
    expect(report.byCondition['skills_on']).toBeDefined();
    expect(report.byCondition['skills_optimized']).toBeDefined();
    expect(report.totalTasks).toBe(10); // 5 × 2 conditions
    store.close();
  });

  it('runs multiple seeds per cell', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain  = makeSuccessBrain();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['model-x'],
      conditions: ['no_skills'],
      seeds:      3,
      brain,
      store,
    });

    expect(report.totalTasks).toBe(15); // 5 tasks × 3 seeds
    store.close();
  });

  it('accepts custom taskIds subset', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain  = makeSuccessBrain();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['model-x'],
      conditions: ['no_skills'],
      taskIds:    ['task-hello', 'task-arithmetic'],
      seeds:      1,
      brain,
      store,
    });

    expect(report.totalTasks).toBe(2);
    store.close();
  });

  it('throws when models array is empty', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const runner = new BenchRunner(store);

    await expect(runner.run({ models: [], conditions: ['no_skills'], seeds: 1, store }))
      .rejects.toThrow('models array must not be empty');
    store.close();
  });

  it('handles brain failure gracefully and marks result as failure', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain: import('../../src/core/eval/bench-runner.js').BrainCallable = {
      call: vi.fn().mockRejectedValue(new Error('brain timeout')),
    };
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['model-fail'],
      conditions: ['no_skills'],
      seeds:      1,
      brain,
      store,
    });

    expect(report.successRate).toBe(0);
    store.close();
  });
});

describe('BenchRunner — BenchReport content', () => {
  it('markdownSummary contains expected sections', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain  = makeSuccessBrain();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['grok'],
      conditions: ['no_skills'],
      seeds:      1,
      brain,
      store,
    });

    expect(report.markdownSummary).toContain('## Benchmark Report');
    expect(report.markdownSummary).toContain('By Condition');
    expect(report.markdownSummary).toContain('By Model');
    expect(report.markdownSummary).toContain('grok');
    store.close();
  });

  it('persists report to store and can be retrieved', async () => {
    const dbPath = makeTempDb();
    const store  = new BenchStore(dbPath);
    const brain  = makeSuccessBrain();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models:     ['model-persist'],
      conditions: ['no_skills'],
      seeds:      1,
      brain,
      store,
    });

    const retrieved = store.getReport(report.runId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.runId).toBe(report.runId);
    expect(retrieved!.totalTasks).toBe(report.totalTasks);
    store.close();
  });
});
