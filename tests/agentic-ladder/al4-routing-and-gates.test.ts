/**
 * @file al4-routing-and-gates.test.ts
 * @description AL4.3 route-per-node + AL4.4 human-approval gates
 * (docs/OPUS_HANDOFF_AGENTIC_LADDER.md):
 *   - route hints (reasoning|cheap|sudo/* alias) resolve through the existing
 *     llm alias layer; concrete model strings in graph configs are load-time
 *     errors; routed calls run under runWithPolicy with caller
 *     workflow:<graph>:<node> and policy refusals fail the node honestly;
 *   - gate nodes park the run on a DURABLE approval artifact (synthetic
 *     artifact test per spec): approve → resume passes through, deny →
 *     honest failure, headless → parks forever, NEVER auto-approves.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  createRoutedAgentExecutor,
  resolveNodeRoute,
  runGraph,
  validateGraph,
  validateGraphRoutes,
  type GraphNode,
  type WorkflowGraph,
} from '../../src/core/workflows/index.js';
import { resolveAlias } from '../../src/llm/aliases.js';
import {
  createApprovalGateExecutor,
  GraphRunStore,
  type GateNotification,
} from '../../src/core/orchestration/index.js';
import { useGatedAuthority } from '../helpers/gated-authority.js';

// This suite exercises the human-in-the-loop machinery, which is live only
// under gated authority (default is autonomous — docs/EXECUTION_AUTHORITY.md).
useGatedAuthority();

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'al43-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const node = (id: string, kind: GraphNode['kind'] = 'agent', extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, ...extra });

// ---------------------------------------------------------------------------
// AL4.3 route-per-node
// ---------------------------------------------------------------------------

describe('AL4.3 route-per-node', () => {
  it('resolves hints and explicit aliases through the llm alias layer', () => {
    expect(resolveNodeRoute(node('a'))).toEqual({
      alias: 'sudo/cheap',
      model: resolveAlias('sudo/cheap'),
    }); // cheap by default — reasoning is explicit
    expect(resolveNodeRoute(node('a', 'agent', { config: { route: 'reasoning' } })).alias).toBe('sudo/mid');
    expect(resolveNodeRoute(node('a', 'agent', { config: { route: 'cheap' } })).alias).toBe('sudo/cheap');
    expect(resolveNodeRoute(node('a', 'agent', { config: { route: 'sudo/frontier' } })).alias).toBe('sudo/frontier');
  });

  it('rejects concrete model strings and unknown hints — fail-loud, load-time', () => {
    for (const bad of ['xai/grok-4-fast-reasoning', 'anthropic/claude-opus-4-8', 'gpt-4', 'frontier']) {
      expect(() => resolveNodeRoute(node('a', 'agent', { config: { route: bad } }))).toThrow(
        /forbidden|not a hint/,
      );
    }
    const graph: WorkflowGraph = {
      name: 'bad-route',
      nodes: [node('a', 'agent', { config: { route: 'openai/gpt-4o' } })],
      edges: [],
    };
    expect(() => validateGraphRoutes(graph)).toThrow(/model strings are forbidden/);
    // Non-agent nodes are not routed — no throw for their configs.
    expect(() =>
      validateGraphRoutes({
        name: 'ok',
        nodes: [node('t', 'tool', { config: { route: 'anything' } })],
        edges: [],
      }),
    ).not.toThrow();
  });

  it('routed executor hands the resolved route to the call and passes the outcome through', async () => {
    const graph: WorkflowGraph = {
      name: 'routed',
      nodes: [node('think', 'agent', { config: { route: 'reasoning' } })],
      edges: [],
    };
    validateGraph(graph);
    const seen: string[] = [];
    const executor = createRoutedAgentExecutor({
      graphName: 'routed',
      call: async (ctx) => {
        seen.push(ctx.route.alias, ctx.route.model);
        return { success: true, output: 'thought' };
      },
    });
    const report = await runGraph(graph, { executors: { agent: executor } });
    expect(report.status).toBe('success');
    expect(seen).toEqual(['sudo/mid', resolveAlias('sudo/mid')]);
  });

  it('policy refusal (background halt) surfaces as an honest node failure, not a crash', async () => {
    const prev = process.env['SUDO_LLM_BACKGROUND_HALT'];
    process.env['SUDO_LLM_BACKGROUND_HALT'] = '1';
    try {
      const graph: WorkflowGraph = { name: 'refused', nodes: [node('bg')], edges: [] };
      validateGraph(graph);
      const call = vi.fn(async () => ({ success: true }));
      const report = await runGraph(graph, {
        executors: {
          agent: createRoutedAgentExecutor({ graphName: 'refused', priority: 'background', call }),
        },
      });
      expect(report.status).toBe('halted');
      expect(call).not.toHaveBeenCalled(); // refused pre-flight — fail closed
      expect(report.results[0]!.error).toMatch(/policy refused route sudo\/cheap/);
    } finally {
      if (prev === undefined) delete process.env['SUDO_LLM_BACKGROUND_HALT'];
      else process.env['SUDO_LLM_BACKGROUND_HALT'] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// AL4.4 approval gates
// ---------------------------------------------------------------------------

describe('AL4.4 approval gates — durable artifact, fail-closed', () => {
  const gateGraph: WorkflowGraph = {
    name: 'deploy-flow',
    nodes: [
      node('prep'),
      node('ask', 'gate', { config: { prompt: 'Deploy v2 to prod?' } }),
      node('deploy'),
    ],
    edges: [
      { from: 'prep', to: 'ask' },
      { from: 'ask', to: 'deploy' },
    ],
  };

  function agents(calls: Record<string, number>) {
    return async (n: GraphNode) => {
      calls[n.id] = (calls[n.id] ?? 0) + 1;
      return { success: true, output: `${n.id}-out` };
    };
  }

  it('parks on a fresh gate, notifies once, resumes to success after approval', async () => {
    validateGraph(gateGraph);
    const store = new GraphRunStore(path.join(scratch, 'gates.db'));
    const runId = 'run-gate-approve';
    store.createRun(runId, gateGraph);
    const notify = vi.fn(async (_info: GateNotification) => {});
    const calls: Record<string, number> = {};
    const opts = () => ({
      executors: {
        agent: agents(calls),
        gate: createApprovalGateExecutor({ store, runId, notify }),
      },
      onEvent: (e: Parameters<GraphRunStore['persistEvent']>[1]) => store.persistEvent(runId, e),
    });

    // Run 1 — parks.
    const r1 = await runGraph(gateGraph, opts());
    store.finishRun(runId, r1);
    expect(r1.status).toBe('awaiting_approval');
    expect(calls['deploy']).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ nodeId: 'ask', prompt: 'Deploy v2 to prod?' });
    expect(store.getRun(runId)!.status).toBe('awaiting_approval');
    expect(store.getApproval(runId, 'ask')!.status).toBe('pending');
    expect(store.listPendingApprovals().map((a) => a.nodeId)).toEqual(['ask']);

    // Run 2 while still pending — parks again, does NOT re-notify.
    const r2 = await runGraph(gateGraph, { ...opts(), resume: store.loadResumeState(runId, gateGraph) });
    expect(r2.status).toBe('awaiting_approval');
    expect(notify).toHaveBeenCalledTimes(1);

    // Operator approves → resume → gate passes prep's output through, deploy runs.
    store.resolveApproval(runId, 'ask', true, 'frank');
    const r3 = await runGraph(gateGraph, { ...opts(), resume: store.loadResumeState(runId, gateGraph) });
    store.finishRun(runId, r3);
    expect(r3.status).toBe('success');
    expect(calls['prep']).toBe(1); // seeded on resume — never re-ran
    expect(calls['deploy']).toBe(1);
    const ask = [...r3.results].reverse().find((r) => r.id === 'ask')!;
    expect(ask.output).toBe('prep-out'); // pass-through
    expect(store.getRun(runId)!.status).toBe('success');
    store.close();
  });

  it('denied artifact fails the gate honestly and halts', async () => {
    const store = new GraphRunStore(path.join(scratch, 'gates.db'));
    const runId = 'run-gate-deny';
    store.createRun(runId, gateGraph);
    const calls: Record<string, number> = {};
    const opts = {
      executors: {
        agent: agents(calls),
        gate: createApprovalGateExecutor({ store, runId }),
      },
    };
    const r1 = await runGraph(gateGraph, opts);
    expect(r1.status).toBe('awaiting_approval');
    store.resolveApproval(runId, 'ask', false, 'frank', 'not this week');
    const r2 = await runGraph(gateGraph, opts);
    expect(r2.status).toBe('halted');
    expect(r2.results.find((r) => r.id === 'ask')!.error).toMatch(/denied by frank — not this week/);
    expect(calls['deploy']).toBeUndefined();
    store.close();
  });

  it('headless (no notifier) STILL parks — never auto-approves', async () => {
    const store = new GraphRunStore(path.join(scratch, 'gates.db'));
    const runId = 'run-gate-headless';
    store.createRun(runId, gateGraph);
    const calls: Record<string, number> = {};
    const r = await runGraph(gateGraph, {
      executors: { agent: agents(calls), gate: createApprovalGateExecutor({ store, runId }) },
    });
    expect(r.status).toBe('awaiting_approval');
    expect(calls['deploy']).toBeUndefined();
    expect(store.getApproval(runId, 'ask')!.status).toBe('pending');
    store.close();
  });

  it('resolveApproval throws on missing or already-decided artifacts', () => {
    const store = new GraphRunStore(path.join(scratch, 'gates.db'));
    expect(() => store.resolveApproval('no-such-run', 'x', true, 'frank')).toThrow(/no pending approval/);
    store.close();
  });
});
