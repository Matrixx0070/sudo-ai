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
  for (const k of ['SUDO_BENCH_NIGHTLY_MAX_TASKS', 'SUDO_BENCH_NIGHTLY_MAX_USD', 'SUDO_BENCH_NIGHTLY_ALERT_BELOW', 'SUDO_EVAL_NIGHTLY']) {
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

// ---------------------------------------------------------------------------
// Eval-sandbox nightly sweep (ADR-0007 Phase 3)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EvalRunReport } from '../../src/core/eval/sandbox/eval-runner.js';
import type { Scenario } from '../../src/core/eval/sandbox/scenario.js';

const SCENARIO_YAML = (id: string): string => `
id: ${id}
version: '1'
title: sweep fixture ${id}
taskType: coding
prompt: do the thing
grading:
  checks:
    - type: outputContains
      substring: done
budgets:
  maxUsd: 0.05
  maxSteps: 2
  maxWallMs: 1000
`;

function fakeEvalReport(scenario: Scenario, score: number, usd = 0.01): EvalRunReport {
  return {
    runId: `fake-${scenario.id}`,
    scenarioId: scenario.id,
    passed: score >= 1,
    scores: {
      success: score >= 1, checksPassed: Math.round(score), checksTotal: 1,
      efficiency: { wallMs: 5, steps: 1 }, policyViolations: 0, deniedToolAttempts: 0, checkOutcomes: [],
    },
    journalPath: '', workspaceDir: '',
    turn: { text: 'done', steps: 1, usd },
  };
}

describe('runNightlyBench eval-sandbox sweep', () => {
  let dir: string;
  const savedSweep: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-sweep-'));
    fs.mkdirSync(path.join(dir, 'scenarios'));
    for (const id of ['s-alpha', 's-beta']) {
      fs.writeFileSync(path.join(dir, 'scenarios', `${id}.yaml`), SCENARIO_YAML(id));
    }
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({
      's-alpha': { minScore: 1.0 },
      's-beta': { minScore: 0.0 },
    }));
    savedSweep['SUDO_EVAL_NIGHTLY'] = process.env['SUDO_EVAL_NIGHTLY'];
    delete process.env['SUDO_EVAL_NIGHTLY'];
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    const v = savedSweep['SUDO_EVAL_NIGHTLY'];
    if (v === undefined) delete process.env['SUDO_EVAL_NIGHTLY']; else process.env['SUDO_EVAL_NIGHTLY'] = v;
  });

  function sweepDeps(run: (s: Scenario) => Promise<EvalRunReport>) {
    return {
      scenarioDir: path.join(dir, 'scenarios'),
      baselinePath: path.join(dir, 'baseline.json'),
      run,
    };
  }

  it('flag off (default): no scenarios run, runner never called', async () => {
    const { store } = fakeStore();
    const run = vi.fn(async (sc: Scenario) => fakeEvalReport(sc, 1));
    const s = await runNightlyBench({
      runner: fakeRunner({ passed: true, costUsd: 0 }), benchStore: store,
      evalSandbox: sweepDeps(run),
    });
    expect(run).not.toHaveBeenCalled();
    expect(s.evalScenariosRun).toBe(0);
    expect(s.evalReport).toBe('');
  });

  it('flag on: runs every scenario and reports against the baseline (no regressions)', async () => {
    process.env['SUDO_EVAL_NIGHTLY'] = '1';
    const { store } = fakeStore();
    const s = await runNightlyBench({
      runner: fakeRunner({ passed: true, costUsd: 0 }), benchStore: store,
      evalSandbox: sweepDeps(async (sc) => fakeEvalReport(sc, 1)),
    });
    expect(s.evalScenariosRun).toBe(2);
    expect(s.evalRegressions).toEqual([]);
    expect(s.evalReport).toContain('s-alpha: ok');
  });

  it('REGRESSION #1: agent tasks exhausting their cap must NOT starve the sweep', async () => {
    // Live 2026-08-01: agent bench spent $2.22 of its own $2 cap, and the sweep
    // (then sharing that cap) skipped ALL scenarios — evalScenariosRun 0 every
    // night. The sweep now has its own budget and must run regardless.
    process.env['SUDO_EVAL_NIGHTLY'] = '1';
    process.env['SUDO_BENCH_NIGHTLY_MAX_USD'] = '2';
    const { store } = fakeStore();
    const s = await runNightlyBench({
      runner: fakeRunner({ passed: true, costUsd: 2.5 }), // blows the shared cap
      benchStore: store,
      evalSandbox: sweepDeps(async (sc) => fakeEvalReport(sc, 1)),
    });
    expect(s.budgetHalted).toBe(true);      // agent phase halted, as designed
    expect(s.evalScenariosRun).toBe(2);      // ...but the sweep still ran
    expect(s.evalScenariosSkipped).toBe(0);
  });

  it('sweep halts on its OWN budget and names what it skipped (no silent cap)', async () => {
    process.env['SUDO_EVAL_NIGHTLY'] = '1';
    const prev = process.env['SUDO_EVAL_NIGHTLY_MAX_USD'];
    process.env['SUDO_EVAL_NIGHTLY_MAX_USD'] = '0.6'; // floor is 0.5
    try {
      const { store } = fakeStore();
      const s = await runNightlyBench({
        runner: fakeRunner({ passed: true, costUsd: 0 }), benchStore: store,
        evalSandbox: sweepDeps(async (sc) => fakeEvalReport(sc, 1, 0.4)),
      });
      expect(s.evalScenariosRun).toBe(1);     // first runs ($0.40 spent)
      expect(s.evalScenariosSkipped).toBe(1); // remaining $0.20 < $0.50 floor
      expect(s.evalReport).toContain('not run (budget/flag)');
    } finally {
      if (prev === undefined) delete process.env['SUDO_EVAL_NIGHTLY_MAX_USD'];
      else process.env['SUDO_EVAL_NIGHTLY_MAX_USD'] = prev;
    }
  });

  it('flags a regression when a scenario scores below its baseline minScore', async () => {
    process.env['SUDO_EVAL_NIGHTLY'] = '1';
    const { store } = fakeStore();
    const notify = vi.fn();
    const s = await runNightlyBench({
      runner: fakeRunner({ passed: true, costUsd: 0 }), benchStore: store, notify,
      evalSandbox: sweepDeps(async (sc) => fakeEvalReport(sc, sc.id === 's-alpha' ? 0 : 1)),
    });
    expect(s.evalRegressions).toEqual(['s-alpha']);
    expect(s.evalReport).toContain('s-alpha: REGRESSED');
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('regression'),
      expect.stringContaining('s-alpha'),
    );
  });

  it('rotates least-recently-run first so a budget-capped sweep still covers every scenario', async () => {
    process.env['SUDO_EVAL_NIGHTLY'] = '1';
    const { store } = fakeStore();
    const ran: string[] = [];
    // s-alpha ran recently, s-beta never → beta must go FIRST.
    const s = await runNightlyBench({
      runner: fakeRunner({ passed: true, costUsd: 0 }), benchStore: store,
      evalSandbox: {
        ...sweepDeps(async (sc) => { ran.push(sc.id); return fakeEvalReport(sc, 1); }),
        lastRunAt: async () => ({ 's-alpha': Date.now() }),
      },
    });
    expect(ran[0]).toBe('s-beta');
    expect(s.evalScenariosRun).toBe(2);
  });

  it('falls back to file order when the last-run lookup fails (never blocks the sweep)', async () => {
    process.env['SUDO_EVAL_NIGHTLY'] = '1';
    const { store } = fakeStore();
    const ran: string[] = [];
    const s = await runNightlyBench({
      runner: fakeRunner({ passed: true, costUsd: 0 }), benchStore: store,
      evalSandbox: {
        ...sweepDeps(async (sc) => { ran.push(sc.id); return fakeEvalReport(sc, 1); }),
        lastRunAt: async () => { throw new Error('db gone'); },
      },
    });
    expect(s.evalScenariosRun).toBe(2);
    expect(ran).toEqual(['s-alpha', 's-beta']);
  });

  it('agent-task spend no longer suppresses the sweep (this test previously PINNED the bug)', async () => {
    // Before the own-budget fix this asserted `run` was NEVER called when the
    // agent tasks burned the shared cap — i.e. the suite encoded the starvation
    // as correct, which is why it stayed green while the sweep never ran in
    // production. The expectation is now inverted.
    process.env['SUDO_EVAL_NIGHTLY'] = '1';
    process.env['SUDO_BENCH_NIGHTLY_MAX_USD'] = '2';
    process.env['SUDO_BENCH_NIGHTLY_MAX_TASKS'] = '2';
    const { store } = fakeStore();
    const run = vi.fn(async (sc: Scenario) => fakeEvalReport(sc, 1));
    const s = await runNightlyBench({
      runner: fakeRunner({ passed: true, costUsd: 0.8 }), benchStore: store,
      evalSandbox: sweepDeps(run),
    });
    expect(run).toHaveBeenCalled();
    expect(s.evalScenariosRun).toBe(2);
    expect(s.evalScenariosSkipped).toBe(0);
    expect(s.evalRegressions).toEqual([]);
  });
});
