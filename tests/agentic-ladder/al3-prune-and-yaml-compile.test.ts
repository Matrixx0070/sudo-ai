/**
 * @file al3-prune-and-yaml-compile.test.ts
 * @description AL3.3 prune-branch failure policy + AL3.5 YAML→graph
 * compilation (docs/OPUS_HANDOFF_AGENTIC_LADDER.md):
 *   - prune-branch cancels only the failed node's downstream subgraph; sibling
 *     branches finish; `all` merges fed by a pruned arm prune; quorum merges
 *     degrade to the surviving arms; the report names every pruned node.
 *   - existing linear .lobster.yaml workflows compile to trivial graphs and
 *     produce IDENTICAL per-step results through the graph path (regression:
 *     same fixture run through runWorkflow AND compile+runGraph).
 */

import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  compileWorkflowToGraph,
  createStepNodeExecutors,
  loadWorkflow,
  runGraph,
  runWorkflow,
  validateGraph,
  type GraphNode,
  type GraphNodeExecutor,
  type GraphRunReport,
  type NodeOutcome,
  type StepResult,
  type WorkflowGraph,
} from '../../src/core/workflows/index.js';

const node = (id: string, kind: GraphNode['kind'] = 'agent', extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, ...extra });

const agentExec =
  (handlers: Record<string, (inputs: unknown[]) => Promise<NodeOutcome> | NodeOutcome>): GraphNodeExecutor =>
  async (n, inputs) => handlers[n.id]!(inputs.map((i) => i.output));

const runAgents = (
  graph: WorkflowGraph,
  handlers: Record<string, (inputs: unknown[]) => Promise<NodeOutcome> | NodeOutcome>,
): Promise<GraphRunReport> => {
  validateGraph(graph);
  return runGraph(graph, { executors: { agent: agentExec(handlers) } });
};

const statusOf = (report: GraphRunReport, id: string): string =>
  [...report.results].reverse().find((r) => r.id === id)!.status;

// ---------------------------------------------------------------------------
// AL3.3 prune-branch
// ---------------------------------------------------------------------------

describe('AL3.3 prune-branch failure policy', () => {
  it('prunes only the failed node’s downstream; the sibling branch completes (status partial)', async () => {
    const graph: WorkflowGraph = {
      name: 'prune-sibling',
      nodes: [
        node('s'),
        node('b', 'agent', { onFailure: 'prune-branch' }),
        node('c'),
        node('d'),
        node('e'),
      ],
      edges: [
        { from: 's', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 's', to: 'd' },
        { from: 'd', to: 'e' },
      ],
    };
    let cRan = false;
    const report = await runAgents(graph, {
      s: () => ({ success: true, output: 'seed' }),
      b: () => ({ success: false, error: 'boom' }),
      c: () => ((cRan = true), { success: true }),
      d: () => ({ success: true, output: 'd-ok' }),
      e: () => ({ success: true, output: 'e-ok' }),
    });

    expect(report.status).toBe('partial');
    expect(cRan).toBe(false);
    expect(report.failedNodes).toEqual(['b']);
    expect(report.prunedNodes).toEqual(['c']);
    expect(statusOf(report, 'd')).toBe('success');
    expect(statusOf(report, 'e')).toBe('success');
  });

  it('an `all` merge fed by a pruned arm prunes (barrier broken), and its downstream prunes too', async () => {
    const graph: WorkflowGraph = {
      name: 'prune-barrier',
      nodes: [
        node('s'),
        node('x', 'agent', { onFailure: 'prune-branch' }),
        node('y'),
        node('m', 'merge'),
        node('after'),
      ],
      edges: [
        { from: 's', to: 'x' },
        { from: 's', to: 'y' },
        { from: 'x', to: 'm' },
        { from: 'y', to: 'm' },
        { from: 'm', to: 'after' },
      ],
    };
    const report = await runAgents(graph, {
      s: () => ({ success: true }),
      x: () => ({ success: false, error: 'arm died' }),
      y: () => ({ success: true, output: 'y-ok' }),
      after: () => ({ success: true }),
    });

    expect(report.status).toBe('partial');
    expect(report.failedNodes).toEqual(['x']);
    expect(statusOf(report, 'y')).toBe('success');
    expect(report.prunedNodes.sort()).toEqual(['after', 'm']);
  });

  it('a quorum merge degrades to the surviving arms when a pruned arm dies', async () => {
    const graph: WorkflowGraph = {
      name: 'prune-quorum',
      nodes: [
        node('s'),
        node('f1'),
        node('f2', 'agent', { onFailure: 'prune-branch' }),
        node('f3'),
        node('pick', 'merge', { config: { merge: { mode: 'quorum', count: 2 } } }),
      ],
      edges: [
        { from: 's', to: 'f1' },
        { from: 's', to: 'f2' },
        { from: 's', to: 'f3' },
        { from: 'f1', to: 'pick' },
        { from: 'f2', to: 'pick' },
        { from: 'f3', to: 'pick' },
      ],
    };
    const report = await runAgents(graph, {
      s: () => ({ success: true }),
      f1: () => ({ success: true, output: 'hit-1' }),
      f2: () => ({ success: false, error: 'finder died' }),
      f3: () => ({ success: true, output: 'hit-3' }),
    });

    expect(report.status).toBe('partial');
    expect(statusOf(report, 'pick')).toBe('success');
    expect(report.failedNodes).toEqual(['f2']);
    expect(report.prunedNodes).toEqual([]);
    const pickOutput = [...report.results].reverse().find((r) => r.id === 'pick')!.output;
    expect((pickOutput as unknown[]).sort()).toEqual(['hit-1', 'hit-3']);
  });

  it('rejects onFailure on structural nodes and bad values at validation', () => {
    expect(() =>
      validateGraph({
        name: 'bad',
        nodes: [node('a'), node('b'), node('m', 'merge', { onFailure: 'prune-branch' })],
        edges: [
          { from: 'a', to: 'm' },
          { from: 'b', to: 'm' },
        ],
      }),
    ).toThrow(/onFailure is only valid/);
    expect(() =>
      validateGraph({
        name: 'bad2',
        nodes: [node('a', 'agent', { onFailure: 'explode' as never })],
        edges: [],
      }),
    ).toThrow(/onFailure must be/);
  });
});

// ---------------------------------------------------------------------------
// AL3.5 YAML → graph compilation
// ---------------------------------------------------------------------------

let scratch: string;
const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

async function loadFixture(yaml: string, filename: string) {
  scratch = await mkdtemp(path.join(tmpdir(), 'al35-'));
  cleanups.push(scratch);
  const file = path.join(scratch, filename);
  await writeFile(file, yaml, 'utf8');
  return loadWorkflow(file, { basePath: scratch });
}

/** Run a linear workflow through BOTH engines; return comparable per-step results. */
async function bothEngines(yaml: string, filename: string) {
  const workflow = await loadFixture(yaml, filename);

  const linear = await runWorkflow(workflow);
  const linearById = new Map(linear.completedSteps.map((r) => [r.id, r]));

  const graph = compileWorkflowToGraph(workflow);
  validateGraph(graph);
  const { executors, completedSteps } = createStepNodeExecutors();
  const report = await runGraph(graph, { executors });

  return { workflow, graph, linearById, graphById: completedSteps, report };
}

const comparable = (r: StepResult | undefined) =>
  r === undefined ? undefined : { status: r.status, stdout: r.stdout, exitCode: r.exitCode };

describe('AL3.5 YAML → graph compilation', () => {
  it('a legacy linear fixture (templates + conditions) produces identical per-step results through the graph path', async () => {
    const yaml = [
      'name: legacy-linear',
      'steps:',
      '  - id: emit',
      '    command: echo alpha',
      '  - id: pass',
      '    command: cat',
      '    stdin: "{{prev}}"',
      '  - id: when-ok',
      '    command: echo ran',
      '    condition: steps.emit.exitCode === 0',
      '  - id: never',
      '    command: echo nope',
      '    condition: steps.emit.exitCode !== 0',
      '  - id: last',
      '    command: echo done',
      '',
    ].join('\n');
    const { linearById, graphById, report } = await bothEngines(yaml, 'legacy-linear.yaml');

    expect(report.status).toBe('success');
    for (const id of ['emit', 'pass', 'when-ok', 'never', 'last']) {
      expect(comparable(graphById.get(id)), `step ${id}`).toEqual(comparable(linearById.get(id)));
    }
    // The skipped step skipped in BOTH engines, and the chain continued.
    expect(linearById.get('never')!.status).toBe('skipped');
    expect(graphById.get('pass')!.stdout).toContain('alpha');
  });

  it('a parallel_group block compiles to fan-out + synthetic barrier join with identical results', async () => {
    const yaml = [
      'name: legacy-fanout',
      'steps:',
      '  - id: seed',
      '    command: echo base',
      '  - id: p1',
      '    command: echo one',
      '    parallel_group: g',
      '  - id: p2',
      '    command: echo two',
      '    parallel_group: g',
      '  - id: tail',
      '    command: cat',
      '    stdin: "{{prev}}"',
      '  - id: after',
      '    command: cat',
      '    stdin: "{{steps.p1.stdout}}"',
      '',
    ].join('\n');
    const { graph, linearById, graphById, report } = await bothEngines(yaml, 'legacy-fanout.yaml');

    expect(report.status).toBe('success');
    // Structure: seed fans out to p1/p2, re-joined by a synthetic merge.
    const join = graph.nodes.find((n) => n.kind === 'merge');
    expect(join?.id).toBe('join-g');
    expect(graph.edges).toContainEqual({ from: 'seed', to: 'p1' });
    expect(graph.edges).toContainEqual({ from: 'p2', to: 'join-g' });
    expect(graph.edges).toContainEqual({ from: 'join-g', to: 'tail' });
    for (const id of ['seed', 'p1', 'p2', 'tail', 'after']) {
      expect(comparable(graphById.get(id)), `step ${id}`).toEqual(comparable(linearById.get(id)));
    }
    // {{prev}} after the block = last member in source order (p2) in both engines.
    expect(graphById.get('tail')!.stdout).toContain('two');
  });

  it('retry lifts onto the graph node and the engine (not the adapter) re-runs the step', async () => {
    // The minimal YAML parser has no nested objects — retry-bearing workflows
    // are authored programmatically, same as the existing AL2.3 retry tests.
    const workflow = {
      name: 'legacy-retry',
      steps: [{ id: 'flaky', type: 'tool' as const, command: 'stub.x', retry: { max_attempts: 3 } }],
    };
    const graph = compileWorkflowToGraph(workflow);
    validateGraph(graph);
    expect(graph.nodes[0]!.retry).toEqual({ max_attempts: 3 });

    let calls = 0;
    const { executors, completedSteps } = createStepNodeExecutors({
      toolExecutor: async () => {
        calls++;
        return calls < 3 ? { success: false, stderr: 'transient' } : { success: true, stdout: 'ok' };
      },
    });
    const report = await runGraph(graph, { executors });
    expect(report.status).toBe('success');
    expect(calls).toBe(3);
    expect(completedSteps.get('flaky')!.stdout).toBe('ok');
  });

  it('approval steps compile to gate nodes: approvalCallback=true proceeds, absent fails honestly', async () => {
    const yaml = ['name: legacy-gate', 'steps:', '  - id: ask', '    command: echo ok', '    approval: true', ''].join('\n');
    const workflow = await loadFixture(yaml, 'legacy-gate.yaml');
    const graph = compileWorkflowToGraph(workflow);
    validateGraph(graph);
    expect(graph.nodes[0]!.kind).toBe('gate');

    const approved = createStepNodeExecutors({ approvalCallback: async () => true });
    const okReport = await runGraph(graph, { executors: approved.executors });
    expect(okReport.status).toBe('success');
    expect(approved.completedSteps.get('ask')!.stdout).toContain('ok');

    const denied = createStepNodeExecutors();
    const failReport = await runGraph(graph, { executors: denied.executors });
    expect(failReport.status).toBe('halted');
    expect(failReport.results[0]!.error).toMatch(/requires approval/);
  });
});
