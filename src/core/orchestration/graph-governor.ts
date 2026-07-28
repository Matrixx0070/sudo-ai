/**
 * graph-governor.ts — AL4.5 resource governor for graph runs.
 *
 * Composes the AL4.2 store, the executor's pause seam, and the billing layer
 * into ONE governed entry point: per-run token budgets and a per-day USD
 * ceiling are enforced at the orchestrator level; exhaustion PAUSES the run
 * in a resumable state (never a hard crash losing state) and fires the alert
 * seam. The governor also owns run-record lifecycle end-to-end — it creates
 * the run, streams events into the store, and ALWAYS persists the final
 * status (success/partial/halted/awaiting_approval/paused), so a caller can
 * never strand a run row in 'running'.
 *
 * Invariant 10: recurring background jobs declare per-run + per-day budgets;
 * exhaustion halts gracefully + alerts. Declare them via `budget`; a graph
 * run without a budget runs unlimited (interactive/owner-driven use).
 */

import { createLogger } from '../shared/logger.js';
import { runGraph } from '../workflows/graph-executor.js';
import type { WorkflowGraph } from '../workflows/graph-types.js';
import type { GraphRunOptions, GraphRunReport } from '../workflows/graph-run-types.js';
import type { GraphRunStore } from './graph-run-store.js';

const log = createLogger('orchestration:graph-governor');

export interface GraphRunBudget {
  /** Max tokens this RUN may spend (sum of NodeOutcome.spend, resume-inclusive). */
  maxRunSpend?: number;
  /** Daily USD ceiling, checked against the injected billing reader. */
  maxDailyUsd?: number;
}

export interface BudgetAlert {
  runId: string;
  graphName: string;
  reason: string;
  spent: number;
}

export interface GovernedRunOptions {
  store: GraphRunStore;
  runId: string;
  graph: WorkflowGraph;
  budget?: GraphRunBudget;
  executors: GraphRunOptions['executors'];
  maxConcurrency?: number;
  /**
   * Billing seam for the per-day ceiling — today's USD spend (compose with
   * billing/: `() => getCostTracker().getTodayCost().totalCost`). Required
   * when budget.maxDailyUsd is set; absent reader + set ceiling fails closed
   * (pauses immediately) rather than running unmetered.
   */
  dailyUsdSpent?: () => number;
  /** Alert seam — fired once when the run pauses on budget. Errors are logged, never thrown. */
  alert?: (info: BudgetAlert) => void | Promise<void>;
}

/**
 * Run a graph under governance: budgets enforced via the executor's pause
 * seam, every event persisted, final status always recorded. Resuming is the
 * same call again — prior spend counts against the per-run budget, settled
 * nodes seed from the store.
 */
export async function runGovernedGraph(options: GovernedRunOptions): Promise<GraphRunReport> {
  const { store, runId, graph, budget, alert } = options;

  store.createRun(runId, graph); // idempotent; throws on same-id different-graph
  const prior = store.getRun(runId)!;
  let spent = prior.budgetSpent; // resumed runs carry their history
  const resume =
    store.getNodes(runId).length > 0 ? store.loadResumeState(runId, graph) : undefined;

  const pause = (): false | string => {
    if (budget?.maxRunSpend !== undefined && spent >= budget.maxRunSpend) {
      return `per-run budget exhausted (${spent}/${budget.maxRunSpend} tokens)`;
    }
    if (budget?.maxDailyUsd !== undefined) {
      if (!options.dailyUsdSpent) {
        return 'daily USD ceiling declared but no billing reader wired — failing closed';
      }
      const usd = options.dailyUsdSpent();
      if (usd >= budget.maxDailyUsd) {
        return `daily USD budget exhausted ($${usd.toFixed(2)}/$${budget.maxDailyUsd.toFixed(2)})`;
      }
    }
    return false;
  };

  const report = await runGraph(graph, {
    executors: options.executors,
    maxConcurrency: options.maxConcurrency,
    resume,
    pause,
    onEvent: (event) => {
      if (event.type === 'node' && event.spend) spent += event.spend;
      store.persistEvent(runId, event);
    },
  });

  // The governor ALWAYS lands the terminal status — no stranded 'running' rows.
  store.finishRun(runId, report);

  if (report.status === 'paused' && alert) {
    const info: BudgetAlert = {
      runId,
      graphName: graph.name,
      reason: report.pauseReason ?? 'paused',
      spent,
    };
    try {
      await alert(info);
    } catch (err) {
      log.warn(
        { runId, err: err instanceof Error ? err.message : String(err) },
        'Budget alert sink failed — run state is already persisted',
      );
    }
  }
  if (report.status === 'paused') {
    log.warn({ runId, graph: graph.name, reason: report.pauseReason, spent }, 'Governed run paused');
  }
  return report;
}
