/**
 * @file bench-nightly.ts
 * @description Nightly AgentBench sweep — runs the registered agent tasks
 * end-to-end (real agent loop, held-out verifiers) and persists results to
 * BenchStore so regressions in agent capability surface within a day instead
 * of at the next incident.
 *
 * History: the AL7.1 ledger long claimed results were "unverified until the
 * cron fires" — no cron ever existed and bench.db sat empty. Built 2026-07-31
 * under Frank's handoff delegation, with invariant-10 budgets:
 *
 *   • SUDO_BENCH_NIGHTLY_MAX_TASKS  (default 10) — tasks per run
 *   • SUDO_BENCH_NIGHTLY_MAX_USD    (default 2)  — cumulative run spend; the
 *     run halts gracefully at the cap and reports what it skipped
 *   • per-task spend additionally rides the live SUDO_AGENT_RUN_MAX_USD halt
 *
 * Alerting: pass-rate below SUDO_BENCH_NIGHTLY_ALERT_BELOW (default 0.7)
 * fires the injected notifier once per run.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { AgentBenchRunner } from './agent-bench-runner.js';
import { ALL_AGENT_TASKS } from './agent-tasks/index.js';
import type { AgentBenchResult } from './agent-bench-types.js';
import type { BenchStore } from './bench-store.js';
import type { BenchResult } from '../shared/wave10-types.js';

const log = createLogger('eval:bench-nightly');

export interface NightlyBenchDeps {
  runner: AgentBenchRunner;
  benchStore: BenchStore;
  /** Fire-and-forget owner alert (e.g. proactive notifier). */
  notify?: (title: string, body: string) => void;
}

export interface NightlyBenchSummary {
  runId: string;
  tasksRun: number;
  tasksSkipped: number;
  passed: number;
  totalCostUsd: number;
  budgetHalted: boolean;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function toBenchRow(runId: string, r: AgentBenchResult): BenchResult {
  return {
    id: randomUUID(),
    runId,
    model: r.model,
    agentId: 'nightly-bench',
    taskId: r.taskId,
    condition: 'without_skill',
    seedIndex: 0,
    success: r.passed,
    latencyMs: r.wallTimeMs,
    costUsd: r.costUsd ?? 0,
    complexityTier: 'medium',
    timestamp: new Date().toISOString(),
  } as BenchResult;
}

/**
 * Run the nightly sweep. Never throws — every failure path degrades to a
 * logged, persisted, reported outcome (a broken bench must not take the
 * daemon's cron loop with it).
 */
export async function runNightlyBench(deps: NightlyBenchDeps): Promise<NightlyBenchSummary> {
  const runId = randomUUID();
  const maxTasks = envNum('SUDO_BENCH_NIGHTLY_MAX_TASKS', 10);
  const maxUsd = envNum('SUDO_BENCH_NIGHTLY_MAX_USD', 2);
  const alertBelow = envNum('SUDO_BENCH_NIGHTLY_ALERT_BELOW', 0.7);

  const tasks = ALL_AGENT_TASKS.slice(0, maxTasks);
  const summary: NightlyBenchSummary = {
    runId, tasksRun: 0, tasksSkipped: 0, passed: 0, totalCostUsd: 0, budgetHalted: false,
  };

  log.info({ runId, tasks: tasks.length, maxUsd }, 'nightly bench starting');

  for (const [i, task] of tasks.entries()) {
    if (summary.totalCostUsd >= maxUsd) {
      summary.budgetHalted = true;
      summary.tasksSkipped = tasks.length - i;
      log.warn({ runId, spent: summary.totalCostUsd, maxUsd, skipped: summary.tasksSkipped },
        'nightly bench: budget exhausted — halting gracefully');
      break;
    }
    try {
      const result = await deps.runner.run(task);
      summary.tasksRun++;
      if (result.passed) summary.passed++;
      summary.totalCostUsd += result.costUsd ?? 0;
      deps.benchStore.insertResult(toBenchRow(runId, result));
      log.info({ runId, taskId: task.id, passed: result.passed, costUsd: result.costUsd },
        'nightly bench: task done');
    } catch (err) {
      summary.tasksRun++;
      deps.benchStore.insertResult(toBenchRow(runId, {
        taskId: task.id, model: 'unknown', passed: false, score: 0,
        detail: `runner threw: ${String(err)}`, agentText: '', wallTimeMs: 0, costUsd: 0,
      } as AgentBenchResult));
      log.warn({ runId, taskId: task.id, err: String(err) }, 'nightly bench: task errored');
    }
  }

  const passRate = summary.tasksRun > 0 ? summary.passed / summary.tasksRun : 0;
  log.info({ ...summary, passRate: +passRate.toFixed(2) }, 'nightly bench complete');

  if (deps.notify && summary.tasksRun > 0 && passRate < alertBelow) {
    try {
      deps.notify(
        `Nightly bench: ${summary.passed}/${summary.tasksRun} passed`,
        `pass-rate ${(passRate * 100).toFixed(0)}% below ${(alertBelow * 100).toFixed(0)}% — ` +
        `$${summary.totalCostUsd.toFixed(2)} spent${summary.budgetHalted ? ' (budget-halted)' : ''}; see bench.db runId ${runId}`,
      );
    } catch { /* notifier failure never breaks the bench */ }
  }
  return summary;
}
