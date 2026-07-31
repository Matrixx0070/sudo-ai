/**
 * @file governed-run.ts
 * @description A2b — the production entry for the governed graph lane.
 *
 * Composes the AL3/AL4 pieces that previously had zero prod callers:
 * compileWorkflowToGraph (AL3.3) → createStepNodeExecutors (linear-primitive
 * adapter) → GraphRunStore (AL4.2 durable state) → runGovernedGraph (AL4.5
 * budgets + park alerts + policy pressure). meta.run-workflow routes here
 * when SUDO_WORKFLOWS_GRAPH=1 (default OFF — lobster stays the live engine).
 *
 * Resume model: calling again with the SAME runId seeds settled nodes from
 * the store and re-runs only the remainder (crash-safe by construction).
 * Budget: SUDO_WORKFLOWS_GRAPH_DAILY_USD sets a daily USD ceiling; the
 * governor fails closed if a ceiling is set without a billing reader, so
 * this module always wires the reader when the ceiling parses.
 */

import { compileWorkflowToGraph, createStepNodeExecutors } from './graph-compile.js';
import { runGovernedGraph, type BudgetAlert, type GraphRunBudget } from '../orchestration/graph-governor.js';
import { GraphRunStore } from '../orchestration/graph-run-store.js';
import type { Workflow, WorkflowStep, StepResult, ToolStepExecutor } from './types.js';
import type { GraphRunReport } from './graph-run-types.js';

/** Canonical graph-run store — same DB the AL4.5 dashboard panel reads. */
export const GRAPH_RUN_DB = 'data/mind.db';

export interface GovernedWorkflowOptions {
  runId: string;
  toolExecutor?: ToolStepExecutor;
  approvalCallback?: (step: WorkflowStep) => Promise<boolean>;
  maxParallel?: number;
  /** Store path override (tests inject a tmp DB; prod uses GRAPH_RUN_DB). */
  dbPath?: string;
  /** Owner-alert seam — budget pauses and approval parks land here. */
  alert?: (info: BudgetAlert) => void | Promise<void>;
  /** Billing reader for the daily USD ceiling (prod: cost-tracker today total). */
  dailyUsdSpent?: () => number;
  /** Env seam for tests (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export interface GovernedWorkflowResult {
  report: GraphRunReport;
  /** Per-step results in settle order — the linear-engine-compatible view. */
  completedSteps: StepResult[];
}

/** Parse the optional daily USD ceiling from env. */
export function readGraphDailyUsd(env: Record<string, string | undefined> = process.env): number | undefined {
  const n = Number.parseFloat(env['SUDO_WORKFLOWS_GRAPH_DAILY_USD'] ?? '');
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Tool-facing wrapper for meta.run-workflow's graph lane: runs governed and
 * formats the ToolResult-shaped summary (status line, per-step ✓/✗, resume
 * hint on park/pause). Kept here so run-workflow.ts stays a thin branch.
 */
export async function runGovernedLaneForTool(
  workflow: Workflow,
  opts: GovernedWorkflowOptions,
): Promise<{ success: boolean; output: string }> {
  const { report, completedSteps } = await runWorkflowGoverned(workflow, opts);
  const stepLines = completedSteps.map(
    (s) => `${s.status === 'success' ? '✓' : '✗'} ${s.id} (${s.durationMs}ms)`,
  );
  const resumable = report.status === 'awaiting_approval' || report.status === 'paused';
  return {
    success: report.status === 'success' || report.status === 'partial',
    output: [
      `workflow "${workflow.name}" [graph lane] — status: ${report.status}` +
        (report.pauseReason ? ` (${report.pauseReason})` : ''),
      ...stepLines,
      ...(resumable ? [`resume: meta.run-workflow { resumeRunId: "${opts.runId}" }`] : []),
    ].join('\n'),
  };
}

export async function runWorkflowGoverned(
  workflow: Workflow,
  opts: GovernedWorkflowOptions,
): Promise<GovernedWorkflowResult> {
  const graph = compileWorkflowToGraph(workflow);
  const { executors, completedSteps } = createStepNodeExecutors({
    ...(opts.toolExecutor ? { toolExecutor: opts.toolExecutor } : {}),
    ...(opts.approvalCallback ? { approvalCallback: opts.approvalCallback } : {}),
  });

  const env = opts.env ?? process.env;
  const maxDailyUsd = readGraphDailyUsd(env);
  const budget: GraphRunBudget | undefined = maxDailyUsd !== undefined ? { maxDailyUsd } : undefined;

  const store = new GraphRunStore(opts.dbPath ?? GRAPH_RUN_DB);
  try {
    const report = await runGovernedGraph({
      store,
      runId: opts.runId,
      graph,
      executors,
      ...(opts.maxParallel !== undefined ? { maxConcurrency: opts.maxParallel } : {}),
      ...(budget ? { budget } : {}),
      ...(budget && opts.dailyUsdSpent ? { dailyUsdSpent: opts.dailyUsdSpent } : {}),
      ...(opts.alert ? { alert: opts.alert } : {}),
    });
    return { report, completedSteps: [...completedSteps.values()] };
  } finally {
    store.close();
  }
}
