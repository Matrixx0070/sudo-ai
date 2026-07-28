/**
 * @file al4-governor.test.ts
 * @description AL4.5 resource governor (docs/OPUS_HANDOFF_AGENTIC_LADDER.md):
 * per-run token + per-day USD budgets enforced at the orchestrator level;
 * exhaustion PAUSES the run resumably (never a crash losing state) + fires
 * the alert seam; the governor always persists the terminal run status; a
 * declared USD ceiling with no billing reader fails closed; resume with a
 * raised budget completes without re-running settled nodes.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  validateGraph,
  type GraphNode,
  type GraphNodeExecutor,
  type WorkflowGraph,
} from '../../src/core/workflows/index.js';
import { GraphRunStore, runGovernedGraph, type BudgetAlert } from '../../src/core/orchestration/index.js';

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'al45-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const node = (id: string): GraphNode => ({ id, kind: 'agent' });

/** a → b → c, each spending 60 tokens. */
const chain: WorkflowGraph = {
  name: 'spender',
  nodes: [node('a'), node('b'), node('c')],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ],
};
validateGraph(chain);

function spendingExecutor(spendPerNode: number): { exec: GraphNodeExecutor; calls: string[] } {
  const calls: string[] = [];
  const exec: GraphNodeExecutor = async (n) => {
    calls.push(n.id);
    return { success: true, output: `${n.id}-out`, spend: spendPerNode };
  };
  return { exec, calls };
}

describe('AL4.5 resource governor', () => {
  it('pauses resumably on per-run budget exhaustion, alerts once, and a raised budget completes the run', async () => {
    const store = new GraphRunStore(path.join(scratch, 'gov.db'));
    const runId = 'run-budget-1';
    const alert = vi.fn(async (_info: BudgetAlert) => {});

    // Budget 100: a (60) runs, b dispatches (spent 60 < 100), then spent=120 → c never runs.
    const first = spendingExecutor(60);
    const r1 = await runGovernedGraph({
      store,
      runId,
      graph: chain,
      executors: { agent: first.exec },
      budget: { maxRunSpend: 100 },
      alert,
    });

    expect(r1.status).toBe('paused');
    expect(r1.pauseReason).toMatch(/per-run budget exhausted \(120\/100 tokens\)/);
    expect(first.calls).toEqual(['a', 'b']);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0]![0]).toMatchObject({ runId, graphName: 'spender', spent: 120 });
    // Terminal status persisted by the governor itself — no stranded 'running' row.
    expect(store.getRun(runId)!.status).toBe('paused');
    expect(store.getRun(runId)!.budgetSpent).toBe(120);

    // Resume WITHOUT raising the budget → pauses immediately, runs nothing.
    const second = spendingExecutor(60);
    const r2 = await runGovernedGraph({
      store,
      runId,
      graph: chain,
      executors: { agent: second.exec },
      budget: { maxRunSpend: 100 },
    });
    expect(r2.status).toBe('paused');
    expect(second.calls).toEqual([]);

    // Operator raises the budget → resume completes; settled nodes never re-run.
    const third = spendingExecutor(60);
    const r3 = await runGovernedGraph({
      store,
      runId,
      graph: chain,
      executors: { agent: third.exec },
      budget: { maxRunSpend: 300 },
    });
    expect(r3.status).toBe('success');
    expect(third.calls).toEqual(['c']);
    expect(store.getRun(runId)!.status).toBe('success');
    expect(store.getRun(runId)!.budgetSpent).toBe(180);
    store.close();
  });

  it('enforces the per-day USD ceiling through the billing seam and fails closed without a reader', async () => {
    const store = new GraphRunStore(path.join(scratch, 'gov.db'));
    const { exec, calls } = spendingExecutor(1);

    // Over the daily ceiling → pauses before ANY node runs.
    const over = await runGovernedGraph({
      store,
      runId: 'run-daily-over',
      graph: chain,
      executors: { agent: exec },
      budget: { maxDailyUsd: 5 },
      dailyUsdSpent: () => 7.5,
    });
    expect(over.status).toBe('paused');
    expect(over.pauseReason).toMatch(/daily USD budget exhausted \(\$7\.50\/\$5\.00\)/);
    expect(calls).toEqual([]);

    // Ceiling declared but NO billing reader wired → fail closed, not unmetered.
    const blind = await runGovernedGraph({
      store,
      runId: 'run-daily-blind',
      graph: chain,
      executors: { agent: exec },
      budget: { maxDailyUsd: 5 },
    });
    expect(blind.status).toBe('paused');
    expect(blind.pauseReason).toMatch(/no billing reader wired — failing closed/);
    expect(calls).toEqual([]);

    // Under the ceiling → runs to completion.
    const under = await runGovernedGraph({
      store,
      runId: 'run-daily-under',
      graph: chain,
      executors: { agent: exec },
      budget: { maxDailyUsd: 5 },
      dailyUsdSpent: () => 1.2,
    });
    expect(under.status).toBe('success');
    expect(calls).toEqual(['a', 'b', 'c']);
    store.close();
  });

  it('no budget → unlimited; a node failure still lands a persisted terminal status', async () => {
    const store = new GraphRunStore(path.join(scratch, 'gov.db'));
    const failing: GraphNodeExecutor = async (n) =>
      n.id === 'b' ? { success: false, error: 'boom' } : { success: true, spend: 60 };

    const r = await runGovernedGraph({
      store,
      runId: 'run-fail',
      graph: chain,
      executors: { agent: failing },
    });
    expect(r.status).toBe('halted');
    expect(store.getRun('run-fail')!.status).toBe('halted'); // governor landed it
    store.close();
  });

  it('listRuns surfaces per-run status + spend for the telemetry tab', () => {
    const store = new GraphRunStore(path.join(scratch, 'gov.db'));
    const runs = store.listRuns();
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
    expect(byId['run-budget-1']).toMatchObject({ status: 'success', budgetSpent: 180 });
    expect(byId['run-fail']!.status).toBe('halted');
    expect(runs.length).toBeGreaterThanOrEqual(5);
    store.close();
  });
});
