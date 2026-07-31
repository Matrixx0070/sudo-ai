/**
 * @file bench-nightly.test.ts
 * @description Nightly AgentBench sweep — budget halt (invariant 10), result
 * persistence, low-pass-rate alerting, and fail-soft on a throwing runner.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runNightlyBench } from '../../src/core/eval/bench-nightly.js';
import { ALL_AGENT_TASKS } from '../../src/core/eval/agent-tasks/index.js';
import type { AgentBenchRunner } from '../../src/core/eval/agent-bench-runner.js';
import type { BenchStore } from '../../src/core/eval/bench-store.js';

function fakeRunner(perTask: { passed: boolean; costUsd: number; throwErr?: boolean }): AgentBenchRunner {
  return {
    run: async (task: { id: string }) => {
      if (perTask.throwErr) throw new Error('boom');
      return {
        taskId: task.id, model: 'test-model', passed: perTask.passed, score: perTask.passed ? 1 : 0,
        detail: '', agentText: 'done', wallTimeMs: 5, costUsd: perTask.costUsd,
      };
    },
  } as unknown as AgentBenchRunner;
}

function fakeStore(): { store: BenchStore; rows: unknown[] } {
  const rows: unknown[] = [];
  return { store: { insertResult: (r: unknown) => rows.push(r) } as unknown as BenchStore, rows };
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['SUDO_BENCH_NIGHTLY_MAX_TASKS', 'SUDO_BENCH_NIGHTLY_MAX_USD', 'SUDO_BENCH_NIGHTLY_ALERT_BELOW']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('runNightlyBench', () => {
  it('runs all tasks under budget and persists one row each', async () => {
    const { store, rows } = fakeStore();
    const s = await runNightlyBench({ runner: fakeRunner({ passed: true, costUsd: 0.01 }), benchStore: store });
    expect(s.tasksRun).toBe(ALL_AGENT_TASKS.length);
    expect(s.passed).toBe(ALL_AGENT_TASKS.length);
    expect(rows.length).toBe(ALL_AGENT_TASKS.length);
    expect(s.budgetHalted).toBe(false);
  });

  it('halts gracefully at the USD budget and reports skipped tasks', async () => {
    process.env['SUDO_BENCH_NIGHTLY_MAX_USD'] = '1';
    const { store } = fakeStore();
    const s = await runNightlyBench({ runner: fakeRunner({ passed: true, costUsd: 0.6 }), benchStore: store });
    expect(s.budgetHalted).toBe(true);
    expect(s.tasksRun).toBe(2); // 0.6 + 0.6 crosses 1.0 before task 3
    expect(s.tasksSkipped).toBe(ALL_AGENT_TASKS.length - 2);
  });

  it('fires the notifier once when pass-rate is below threshold', async () => {
    const { store } = fakeStore();
    const notify = vi.fn();
    await runNightlyBench({ runner: fakeRunner({ passed: false, costUsd: 0 }), benchStore: store, notify });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a throwing runner records a failed row and never throws out', async () => {
    const { store, rows } = fakeStore();
    const s = await runNightlyBench({ runner: fakeRunner({ passed: false, costUsd: 0, throwErr: true }), benchStore: store });
    expect(s.tasksRun).toBe(ALL_AGENT_TASKS.length);
    expect(s.passed).toBe(0);
    expect(rows.length).toBe(ALL_AGENT_TASKS.length);
  });

  it('respects the max-tasks cap', async () => {
    process.env['SUDO_BENCH_NIGHTLY_MAX_TASKS'] = '3';
    const { store } = fakeStore();
    const s = await runNightlyBench({ runner: fakeRunner({ passed: true, costUsd: 0 }), benchStore: store });
    expect(s.tasksRun).toBe(3);
  });
});
