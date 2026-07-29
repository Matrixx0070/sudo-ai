/**
 * @file al4-graph-run-store.test.ts
 * @description AL4.2 graph-run state store (docs/OPUS_HANDOFF_AGENTIC_LADDER.md):
 * durable graph_runs / graph_run_nodes rows beside the task queue, written
 * through the executor's onEvent seam, and crash-resume for a DIAMOND graph
 * (the AL2.4 pattern lifted to graphs): settled nodes never re-execute, the
 * failed node re-runs, outputs round-trip through SQLite, and a resume against
 * an edited graph refuses on canonical-hash mismatch.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  runGraph,
  validateGraph,
  type GraphNode,
  type GraphNodeExecutor,
  type GraphRunOptions,
  type NodeOutcome,
  type WorkflowGraph,
} from '../../src/core/workflows/index.js';
import { GraphRunStore, computeGraphHash } from '../../src/core/orchestration/index.js';

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'al42-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const node = (id: string, kind: GraphNode['kind'] = 'agent', extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, ...extra });

const diamond: WorkflowGraph = {
  name: 'diamond',
  nodes: [node('start'), node('fork', 'branch'), node('left'), node('right'), node('join', 'merge')],
  edges: [
    { from: 'start', to: 'fork' },
    { from: 'fork', to: 'left' },
    { from: 'fork', to: 'right' },
    { from: 'left', to: 'join' },
    { from: 'right', to: 'join' },
  ],
};

/** Executor counting calls per node, with per-node behavior. */
function countingExecutor(
  handlers: Record<string, () => NodeOutcome>,
): { exec: GraphNodeExecutor; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const exec: GraphNodeExecutor = async (n) => {
    calls[n.id] = (calls[n.id] ?? 0) + 1;
    return handlers[n.id]!();
  };
  return { exec, calls };
}

const storeWired = (store: GraphRunStore, runId: string, executor: GraphNodeExecutor): GraphRunOptions => ({
  executors: { agent: executor },
  onEvent: (event) => store.persistEvent(runId, event),
});

describe('AL4.2 graph-run state store — diamond crash-resume', () => {
  it('persists per-node rows, refuses edited-graph resume, resumes without re-running settled nodes', async () => {
    validateGraph(diamond);
    const store = new GraphRunStore(path.join(scratch, 'mind.db'));
    const runId = 'run-diamond-1';
    store.createRun(runId, diamond);

    // ---- Run 1: right fails (default halt-graph) — the "crash" persisted state.
    const first = countingExecutor({
      start: () => ({ success: true, output: 'seed', spend: 100 }),
      left: () => ({ success: true, output: { hits: [1, 2] }, spend: 50 }),
      right: () => ({ success: false, error: 'transient outage', spend: 25 }),
    });
    const report1 = await runGraph(diamond, storeWired(store, runId, first.exec));
    store.finishRun(runId, report1);

    expect(report1.status).toBe('halted');
    const run1 = store.getRun(runId)!;
    expect(run1.status).toBe('halted');
    expect(run1.budgetSpent).toBe(175); // 100 + 50 + 25 — failures spend too
    const nodes1 = Object.fromEntries(store.getNodes(runId).map((n) => [n.nodeId, n.status]));
    expect(nodes1).toEqual({
      start: 'success',
      fork: 'success',
      left: 'success',
      right: 'failure',
      join: 'skipped',
    });

    // ---- Edited graph → resume refuses on hash mismatch.
    const edited: WorkflowGraph = { ...diamond, nodes: [...diamond.nodes, node('extra')] };
    expect(() => store.loadResumeState(runId, edited)).toThrow(/graph has changed/);
    expect(computeGraphHash(edited)).not.toBe(computeGraphHash(diamond));

    // ---- Resume: identical graph, right now healthy. Settled nodes must NOT re-run.
    const second = countingExecutor({
      start: () => ({ success: true, output: 'seed-2' }),
      left: () => ({ success: true, output: 'left-2' }),
      right: () => ({ success: true, output: 'right-ok', spend: 30 }),
    });
    const resume = store.loadResumeState(runId, diamond);
    const report2 = await runGraph(diamond, {
      ...storeWired(store, runId, second.exec),
      resume,
    });
    store.finishRun(runId, report2);

    expect(report2.status).toBe('success');
    expect(second.calls['start']).toBeUndefined(); // seeded — never re-executed
    expect(second.calls['left']).toBeUndefined();
    expect(second.calls['right']).toBe(1); // recorded failure re-runs (AL2.4 semantics)
    // join consumed left's output ROUND-TRIPPED through SQLite + right's fresh output.
    const join2 = [...report2.results].reverse().find((r) => r.id === 'join')!;
    expect(join2.status).toBe('success');
    expect(join2.output).toEqual([{ hits: [1, 2] }, 'right-ok']);

    const run2 = store.getRun(runId)!;
    expect(run2.status).toBe('success');
    expect(run2.budgetSpent).toBe(205); // 175 + 30 from the resumed right
    const nodes2 = Object.fromEntries(store.getNodes(runId).map((n) => [n.nodeId, n.status]));
    expect(nodes2['right']).toBe('success');
    expect(nodes2['join']).toBe('success');
    store.close();
  });

  it('persists loop-edge iteration counters through the event seam', async () => {
    const loopGraph: WorkflowGraph = {
      name: 'refine',
      nodes: [node('gen'), node('check')],
      edges: [
        { from: 'gen', to: 'check' },
        {
          from: 'check',
          to: 'gen',
          condition: { '!==': [{ var: 'check.output' }, 'pass'] },
          loop: { maxIterations: 3 },
        },
      ],
    };
    validateGraph(loopGraph);
    const store = new GraphRunStore(path.join(scratch, 'loop.db'));
    const runId = 'run-loop-1';
    store.createRun(runId, loopGraph);

    let checks = 0;
    const outputs = ['fail', 'pass'];
    const { exec } = countingExecutor({
      gen: () => ({ success: true, output: 'draft' }),
      check: () => ({ success: true, output: outputs[checks++] }),
    });
    const report = await runGraph(loopGraph, storeWired(store, runId, exec));
    store.finishRun(runId, report);

    expect(report.status).toBe('success');
    expect(store.getRun(runId)!.loopIterations).toEqual({ 'check->gen': 1 });
    store.close();
  });

  it('createRun is idempotent for the same graph and throws for a different one under the same run id', () => {
    const store = new GraphRunStore(path.join(scratch, 'dup.db'));
    store.createRun('r1', diamond);
    expect(() => store.createRun('r1', diamond)).not.toThrow();
    const other: WorkflowGraph = { ...diamond, name: 'diamond-2' };
    expect(() => store.createRun('r1', other)).toThrow(/hash mismatch/);
    store.close();
  });
});
