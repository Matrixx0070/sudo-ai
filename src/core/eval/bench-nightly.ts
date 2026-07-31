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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT } from '../shared/paths.js';
import { AgentBenchRunner } from './agent-bench-runner.js';
import { ALL_AGENT_TASKS } from './agent-tasks/index.js';
import type { AgentBenchResult } from './agent-bench-types.js';
import { checkSandboxBaseline, type SandboxBaseline, type SandboxScenarioResult } from './bench-regression.js';
import type { BenchStore } from './bench-store.js';
import type { BenchResult } from '../shared/wave10-types.js';
import type { EvalRunReport } from './sandbox/eval-runner.js';
import type { Scenario } from './sandbox/scenario.js';

const log = createLogger('eval:bench-nightly');

/** Stop starting new eval-sandbox scenarios when remaining budget < this. */
const EVAL_SWEEP_BUDGET_FLOOR_USD = 0.5;

export interface NightlyEvalSandboxDeps {
  /** Scenario manifest dir. Default: evals/sandbox/scenarios/. */
  scenarioDir?: string;
  /** Committed baseline file. Default: evals/sandbox/baseline.json. */
  baselinePath?: string;
  /** Injected scenario runner for tests. Default: sandbox runEval (results
   * land in bench.db via the runner itself). */
  run?: (scenario: Scenario) => Promise<EvalRunReport>;
}

export interface NightlyBenchDeps {
  runner: AgentBenchRunner;
  benchStore: BenchStore;
  /** Fire-and-forget owner alert (e.g. proactive notifier). */
  notify?: (title: string, body: string) => void;
  /** Eval-sandbox sweep seams (ADR-0007 Phase 3). */
  evalSandbox?: NightlyEvalSandboxDeps;
}

export interface NightlyBenchSummary {
  runId: string;
  tasksRun: number;
  tasksSkipped: number;
  passed: number;
  totalCostUsd: number;
  budgetHalted: boolean;
  /** Eval-sandbox sweep (SUDO_EVAL_NIGHTLY=1; 0 when the flag is off). */
  evalScenariosRun: number;
  evalScenariosSkipped: number;
  /** Scenario ids that fell below the committed baseline minScore. */
  evalRegressions: string[];
  /** Baseline-check report appended to the nightly report ('' when no sweep). */
  evalReport: string;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function benchRow(runId: string, partial: {
  taskId: string; model: string; success: boolean; latencyMs: number;
  costUsd: number; score?: number; detail?: string;
}): BenchResult {
  return {
    id: randomUUID(),
    runId,
    model: partial.model,
    agentId: 'nightly-bench',
    taskId: partial.taskId,
    condition: 'no_skills',
    seedIndex: 0,
    success: partial.success,
    latencyMs: partial.latencyMs,
    costUsd: partial.costUsd,
    complexityTier: 'moderate',
    timestamp: new Date().toISOString(),
    score: partial.score,
    verifierDetail: partial.detail,
  };
}

function toBenchRow(runId: string, r: AgentBenchResult): BenchResult {
  return benchRow(runId, {
    taskId: r.taskId, model: r.model, success: r.passed,
    latencyMs: r.wallTimeMs, costUsd: r.costUsd ?? 0, score: r.score, detail: r.detail,
  });
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
    evalScenariosRun: 0, evalScenariosSkipped: 0, evalRegressions: [], evalReport: '',
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
      deps.benchStore.insertResult(benchRow(runId, {
        taskId: task.id, model: 'unknown', success: false,
        latencyMs: 0, costUsd: 0, score: 0, detail: `runner threw: ${String(err)}`,
      }));
      log.warn({ runId, taskId: task.id, err: String(err) }, 'nightly bench: task errored');
    }
  }

  // Eval-sandbox sweep (ADR-0007 Phase 3): flag-gated, rides the SAME
  // SUDO_BENCH_NIGHTLY_MAX_USD accounting as the agent tasks above. Fail-soft.
  if (process.env['SUDO_EVAL_NIGHTLY'] === '1') {
    try {
      await runEvalSandboxSweep(deps.evalSandbox ?? {}, summary, maxUsd);
    } catch (err) {
      log.warn({ runId, err: String(err) }, 'nightly bench: eval-sandbox sweep failed');
    }
    if (deps.notify && summary.evalRegressions.length > 0) {
      try {
        deps.notify(
          `Nightly eval-sandbox: ${summary.evalRegressions.length} regression(s)`,
          `${summary.evalRegressions.join(', ')} fell below baseline\n${summary.evalReport}`,
        );
      } catch { /* notifier failure never breaks the bench */ }
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

/**
 * Run every scenario in evals/sandbox/scenarios/ through the sandbox runner,
 * within the nightly USD budget: stop STARTING new scenarios once remaining
 * budget drops below {@link EVAL_SWEEP_BUDGET_FLOOR_USD}. Bench rows land in
 * bench.db via the runner; this only tracks spend + the baseline comparison.
 */
async function runEvalSandboxSweep(
  evalDeps: NightlyEvalSandboxDeps,
  summary: NightlyBenchSummary,
  maxUsd: number,
): Promise<void> {
  const scenarioDir = evalDeps.scenarioDir ?? join(PROJECT_ROOT, 'evals', 'sandbox', 'scenarios');
  const baselinePath = evalDeps.baselinePath ?? join(PROJECT_ROOT, 'evals', 'sandbox', 'baseline.json');
  if (!existsSync(scenarioDir)) {
    log.warn({ scenarioDir }, 'eval-sandbox sweep: scenario dir missing — skipping');
    return;
  }
  const files = readdirSync(scenarioDir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort();

  // Lazy imports keep sandbox module load off every runNightlyBench call site.
  const { loadScenarioFile } = await import('./sandbox/scenario.js');
  const run = evalDeps.run ?? (await import('./sandbox/eval-runner.js')).runEval;

  const results: SandboxScenarioResult[] = [];
  for (const [i, file] of files.entries()) {
    if (maxUsd - summary.totalCostUsd < EVAL_SWEEP_BUDGET_FLOOR_USD) {
      summary.budgetHalted = true;
      summary.evalScenariosSkipped = files.length - i;
      log.warn(
        { spent: summary.totalCostUsd, maxUsd, skipped: summary.evalScenariosSkipped },
        'eval-sandbox sweep: budget floor reached — halting gracefully',
      );
      break;
    }
    try {
      const scenario = loadScenarioFile(join(scenarioDir, file));
      const report = await run(scenario);
      summary.evalScenariosRun++;
      summary.totalCostUsd += report.turn.usd ?? 0;
      results.push({
        scenarioId: scenario.id,
        score: report.scores.checksTotal > 0 ? report.scores.checksPassed / report.scores.checksTotal : 0,
      });
      log.info({ scenarioId: scenario.id, passed: report.passed, usd: report.turn.usd }, 'eval-sandbox sweep: scenario done');
    } catch (err) {
      // A scenario that cannot run scores 0 — the baseline check should alarm.
      summary.evalScenariosRun++;
      results.push({ scenarioId: file.replace(/\.(ya?ml|json)$/, ''), score: 0 });
      log.warn({ file, err: String(err) }, 'eval-sandbox sweep: scenario errored');
    }
  }

  let baseline: SandboxBaseline = {};
  try {
    if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as SandboxBaseline;
    else log.warn({ baselinePath }, 'eval-sandbox sweep: baseline file missing — no regression gate');
  } catch (err) {
    log.warn({ baselinePath, err: String(err) }, 'eval-sandbox sweep: unreadable baseline — no regression gate');
  }
  const verdict = checkSandboxBaseline(baseline, results);
  summary.evalRegressions = verdict.regressions;
  summary.evalReport = verdict.report;
}
