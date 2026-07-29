/**
 * @file al3-golden-graphs.test.ts
 * @description AL3.4 golden graphs (docs/OPUS_HANDOFF_AGENTIC_LADDER.md) —
 * exact execution semantics of the AL3.1 schema + AL3.2 executor:
 *   (a) diamond — branch → 2 parallel arms → barrier merge, plus the
 *       conditional variant where the branch routes ONE arm and the barrier
 *       degrades to the active subset;
 *   (b) quorum merge — 3 finders, first-2 wins, the slowest is cancelled via
 *       its AbortSignal;
 *   (c) declared loop — refine-until-pass re-executes the loop body, and
 *       maxIterations is honored when the exit condition never holds.
 * Plus the AL3 DONE-MEANS concurrency proof (4 parallel nodes, cap 2 → high
 * water of exactly 2), AL2.3-style retry on nodes, halt-graph failure policy,
 * and load-time validation (undeclared cycles, quorum bounds, predicates).
 */

import { describe, it, expect } from 'vitest';
import {
  runGraph,
  validateGraph,
  type GraphNode,
  type GraphNodeExecutor,
  type GraphRunReport,
  type NodeOutcome,
  type WorkflowGraph,
} from '../../src/core/workflows/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const node = (id: string, kind: GraphNode['kind'] = 'agent', extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, ...extra });

/** Agent executor dispatching per-node behavior from a map. */
const agentExec =
  (handlers: Record<string, (inputs: unknown[], signal: AbortSignal) => Promise<NodeOutcome> | NodeOutcome>): GraphNodeExecutor =>
  async (n, inputs, signal) => {
    const h = handlers[n.id];
    if (!h) throw new Error(`no handler for node ${n.id}`);
    return h(inputs.map((i) => i.output), signal);
  };

const run = (
  graph: WorkflowGraph,
  handlers: Record<string, (inputs: unknown[], signal: AbortSignal) => Promise<NodeOutcome> | NodeOutcome>,
  maxConcurrency?: number,
): Promise<GraphRunReport> => {
  validateGraph(graph);
  return runGraph(graph, { executors: { agent: agentExec(handlers) }, maxConcurrency });
};

const statusOf = (report: GraphRunReport, id: string): string =>
  [...report.results].reverse().find((r) => r.id === id)!.status;
const outputOf = (report: GraphRunReport, id: string): unknown =>
  [...report.results].reverse().find((r) => r.id === id)!.output;
/** Index of a node's LAST event of a type in the trace — for ordering asserts. */
const traceIdx = (report: GraphRunReport, id: string, event: string): number =>
  report.trace.map((t, i) => (t.nodeId === id && t.event === event ? i : -1)).filter((i) => i >= 0).pop() ?? -1;

// ---------------------------------------------------------------------------
// (a) Diamond
// ---------------------------------------------------------------------------

describe('AL3.4 golden graph (a): diamond', () => {
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

  it('runs branch → 2 parallel arms → barrier merge with exact statuses and merged output', async () => {
    const report = await run(diamond, {
      start: () => ({ success: true, output: 'seed' }),
      left: (inputs) => ({ success: true, output: `L:${inputs[0]}` }),
      right: (inputs) => ({ success: true, output: `R:${inputs[0]}` }),
    });

    expect(report.status).toBe('success');
    for (const id of ['start', 'fork', 'left', 'right', 'join']) {
      expect(statusOf(report, id)).toBe('success');
    }
    // Branch is a structural passthrough; barrier merge collects arms in edge order.
    expect(outputOf(report, 'fork')).toBe('seed');
    expect(outputOf(report, 'join')).toEqual(['L:seed', 'R:seed']);
    // Trace ordering: start < fork < both arms < join.
    expect(traceIdx(report, 'start', 'success')).toBeLessThan(traceIdx(report, 'fork', 'success'));
    expect(traceIdx(report, 'fork', 'success')).toBeLessThan(traceIdx(report, 'left', 'start'));
    expect(traceIdx(report, 'fork', 'success')).toBeLessThan(traceIdx(report, 'right', 'start'));
    expect(traceIdx(report, 'left', 'success')).toBeLessThan(traceIdx(report, 'join', 'success'));
    expect(traceIdx(report, 'right', 'success')).toBeLessThan(traceIdx(report, 'join', 'success'));
    expect(report.failedNodes).toEqual([]);
    expect(report.skippedNodes).toEqual([]);
  });

  it('routes ONE arm on edge predicates; the other arm is skipped and the barrier degrades to the active subset', async () => {
    const routed: WorkflowGraph = {
      ...diamond,
      name: 'diamond-routed',
      edges: [
        { from: 'start', to: 'fork' },
        { from: 'fork', to: 'left', condition: { '===': [{ var: 'start.output' }, 'go-left'] } },
        { from: 'fork', to: 'right', condition: { '===': [{ var: 'start.output' }, 'go-right'] } },
        { from: 'left', to: 'join' },
        { from: 'right', to: 'join' },
      ],
    };
    const report = await run(routed, {
      start: () => ({ success: true, output: 'go-left' }),
      left: () => ({ success: true, output: 'L' }),
      right: () => ({ success: true, output: 'R' }),
    });

    expect(report.status).toBe('success');
    expect(statusOf(report, 'left')).toBe('success');
    expect(statusOf(report, 'right')).toBe('skipped');
    expect(outputOf(report, 'join')).toEqual(['L']);
    expect(report.skippedNodes).toEqual(['right']);
  });
});

// ---------------------------------------------------------------------------
// (b) Quorum merge
// ---------------------------------------------------------------------------

describe('AL3.4 golden graph (b): quorum merge', () => {
  it('first-2 of 3 finders win; the slowest is cancelled via its AbortSignal', async () => {
    const graph: WorkflowGraph = {
      name: 'quorum',
      nodes: [
        node('seed'),
        node('f1'),
        node('f2'),
        node('f3'),
        node('pick', 'merge', { config: { merge: { mode: 'quorum', count: 2 } } }),
      ],
      edges: [
        { from: 'seed', to: 'f1' },
        { from: 'seed', to: 'f2' },
        { from: 'seed', to: 'f3' },
        { from: 'f1', to: 'pick' },
        { from: 'f2', to: 'pick' },
        { from: 'f3', to: 'pick' },
      ],
    };

    let f3Aborted = false;
    const report = await run(graph, {
      seed: () => ({ success: true, output: 'q' }),
      f1: () => ({ success: true, output: 'hit-1' }),
      f2: () => ({ success: true, output: 'hit-2' }),
      // Never settles on its own — only observes cancellation.
      f3: (_inputs, signal) =>
        new Promise<NodeOutcome>((resolve) => {
          signal.addEventListener('abort', () => {
            f3Aborted = true;
            resolve({ success: false, error: 'aborted' });
          });
        }),
    });

    expect(report.status).toBe('success');
    expect(statusOf(report, 'pick')).toBe('success');
    // Winners in settle order; the discarded loser's outcome never surfaces.
    expect(outputOf(report, 'pick')).toEqual(['hit-1', 'hit-2']);
    expect(statusOf(report, 'f3')).toBe('cancelled');
    expect(f3Aborted).toBe(true);
    expect(report.cancelledNodes).toEqual(['f3']);
    expect(report.failedNodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) Declared loop
// ---------------------------------------------------------------------------

describe('AL3.4 golden graph (c): declared loop', () => {
  const loopGraph = (maxIterations: number): WorkflowGraph => ({
    name: 'refine-until-pass',
    nodes: [node('gen'), node('check')],
    edges: [
      { from: 'gen', to: 'check' },
      {
        from: 'check',
        to: 'gen',
        condition: { '!==': [{ var: 'check.output' }, 'pass'] },
        loop: { maxIterations },
      },
    ],
  });

  it('re-executes the loop body until the exit condition holds', async () => {
    let genRuns = 0;
    const checkOutputs = ['fail', 'pass'];
    let checkRuns = 0;
    const report = await run(loopGraph(3), {
      gen: () => ({ success: true, output: `draft-${++genRuns}` }),
      check: () => ({ success: true, output: checkOutputs[checkRuns++] }),
    });

    expect(report.status).toBe('success');
    expect(genRuns).toBe(2);
    expect(checkRuns).toBe(2);
    expect(report.loopIterations['check->gen']).toBe(1);
    expect(outputOf(report, 'check')).toBe('pass');
    // Trace shows the reset firing between the two body executions.
    expect(traceIdx(report, 'gen', 'loop-reset')).toBeGreaterThan(-1);
    // Iterations recorded on results: gen's final execution is its 2nd.
    const genResults = report.results.filter((r) => r.id === 'gen');
    expect(genResults.map((r) => r.iteration)).toEqual([1, 2]);
  });

  it('honors maxIterations when the exit condition never holds', async () => {
    let genRuns = 0;
    let checkRuns = 0;
    const report = await run(loopGraph(3), {
      gen: () => ({ success: true, output: `draft-${++genRuns}` }),
      check: () => ({ success: true, output: (checkRuns++, 'fail') }),
    });

    expect(report.status).toBe('success');
    // Initial pass + 3 loop firings = 4 executions of each body node, then stop.
    expect(report.loopIterations['check->gen']).toBe(3);
    expect(genRuns).toBe(4);
    expect(checkRuns).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// DONE MEANS: concurrency cap
// ---------------------------------------------------------------------------

describe('AL3 DONE-MEANS: bounded concurrency', () => {
  it('4 parallel nodes with cap 2 run in 2 waves (high-water mark exactly 2)', async () => {
    const graph: WorkflowGraph = {
      name: 'fan',
      nodes: [node('a'), node('b'), node('c'), node('d')],
      edges: [],
    };
    let active = 0;
    let highWater = 0;
    const worker = async (): Promise<NodeOutcome> => {
      active++;
      highWater = Math.max(highWater, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { success: true, output: 'ok' };
    };
    const report = await run(
      graph,
      { a: worker, b: worker, c: worker, d: worker },
      2,
    );

    expect(report.status).toBe('success');
    expect(report.results.filter((r) => r.status === 'success')).toHaveLength(4);
    expect(highWater).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Failure semantics (AL3.3 default policy + retry)
// ---------------------------------------------------------------------------

describe('AL3.3 failure semantics', () => {
  it('halt-graph (default): downstream never dispatches, report names failed + skipped nodes', async () => {
    const graph: WorkflowGraph = {
      name: 'linear-fail',
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    let cRan = false;
    const report = await run(graph, {
      a: () => ({ success: true, output: 1 }),
      b: () => ({ success: false, error: 'boom' }),
      c: () => ((cRan = true), { success: true }),
    });

    expect(report.status).toBe('halted');
    expect(cRan).toBe(false);
    expect(report.failedNodes).toEqual(['b']);
    expect(report.skippedNodes).toEqual(['c']);
    expect([...report.results].find((r) => r.id === 'b')!.error).toBe('boom');
  });

  it('per-node retry re-runs a failing node with AL2.3 semantics (final attempt recorded)', async () => {
    const graph: WorkflowGraph = {
      name: 'retry',
      nodes: [node('flaky', 'agent', { retry: { max_attempts: 3 } })],
      edges: [],
    };
    let attempts = 0;
    const report = await run(graph, {
      flaky: () => {
        attempts++;
        return attempts < 3 ? { success: false, error: 'transient' } : { success: true, output: 'ok' };
      },
    });

    expect(attempts).toBe(3);
    expect(report.status).toBe('success');
    expect(statusOf(report, 'flaky')).toBe('success');
  });

  it('a node kind with no injected executor fails honestly and halts the graph', async () => {
    const graph: WorkflowGraph = {
      name: 'no-exec',
      nodes: [{ id: 'lone', kind: 'tool' }],
      edges: [],
    };
    validateGraph(graph);
    const report = await runGraph(graph, { executors: {} });
    expect(report.status).toBe('halted');
    expect(report.failedNodes).toEqual(['lone']);
    expect(report.results[0]!.error).toContain('no executor');
  });
});

// ---------------------------------------------------------------------------
// AL3.1 validation — cycles, quorum bounds, predicates, shape rules
// ---------------------------------------------------------------------------

describe('AL3.1 graph validation', () => {
  const twoNodes = [node('a'), node('b')];

  it('rejects an undeclared cycle', () => {
    expect(() =>
      validateGraph({
        name: 'cycle',
        nodes: twoNodes,
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }),
    ).toThrow(/cycle detected.*loop/i);
  });

  it('accepts the same cycle when the back-edge declares loop.maxIterations', () => {
    expect(() =>
      validateGraph({
        name: 'declared',
        nodes: twoNodes,
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a', loop: { maxIterations: 5 } },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a loop edge that is not a back-edge', () => {
    expect(() =>
      validateGraph({
        name: 'fake-loop',
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
          { from: 'b', to: 'c', loop: { maxIterations: 2 } },
        ],
      }),
    ).toThrow(/not a back-edge/);
  });

  it('rejects fan-in on a non-merge node', () => {
    expect(() =>
      validateGraph({
        name: 'fanin',
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          { from: 'a', to: 'c' },
          { from: 'b', to: 'c' },
        ],
      }),
    ).toThrow(/only merge nodes may fan-in/);
  });

  it('rejects quorum count above the inbound edge count', () => {
    expect(() =>
      validateGraph({
        name: 'bad-quorum',
        nodes: [node('a'), node('b'), node('m', 'merge', { config: { merge: { mode: 'quorum', count: 3 } } })],
        edges: [
          { from: 'a', to: 'm' },
          { from: 'b', to: 'm' },
        ],
      }),
    ).toThrow(/merge\.count/);
  });

  it('rejects malformed predicates at load time (fail-loud)', () => {
    expect(() =>
      validateGraph({
        name: 'bad-pred',
        nodes: twoNodes,
        edges: [{ from: 'a', to: 'b', condition: { '===': [{ var: 'ghost.output' }, 1] } }],
      }),
    ).toThrow(/unknown node "ghost"/);
    expect(() =>
      validateGraph({
        name: 'bad-op',
        nodes: twoNodes,
        edges: [{ from: 'a', to: 'b', condition: { nope: [1, 2] } as never }],
      }),
    ).toThrow(/unknown predicate operator/);
  });

  it('rejects a branch node with fewer than 2 outbound edges', () => {
    expect(() =>
      validateGraph({
        name: 'thin-branch',
        nodes: [node('br', 'branch'), node('x')],
        edges: [{ from: 'br', to: 'x' }],
      }),
    ).toThrow(/at least 2 outbound/);
  });

  it('rejects retry on structural nodes and out-of-bounds attempts', () => {
    expect(() =>
      validateGraph({
        name: 'retry-merge',
        nodes: [node('a'), node('b'), node('m', 'merge', { retry: { max_attempts: 2 } })],
        edges: [
          { from: 'a', to: 'm' },
          { from: 'b', to: 'm' },
        ],
      }),
    ).toThrow(/retry is only valid/);
    expect(() =>
      validateGraph({
        name: 'retry-bounds',
        nodes: [node('a', 'agent', { retry: { max_attempts: 99 } })],
        edges: [],
      }),
    ).toThrow(/max_attempts/);
  });
});
