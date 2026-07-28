/**
 * @file workflows/graph-executor.ts
 * @description AL3.2 graph executor — topological scheduling over a validated
 * WorkflowGraph. A SCHEDULER, not a runtime: how agent / tool / gate nodes run
 * is injected by the caller (AL1's step executor for agent nodes, AL2's step
 * contract for tool nodes), exactly like ToolStepExecutor in the linear engine.
 *
 * Semantics: ready nodes dispatch in parallel bounded by `maxConcurrency`
 * (env SUDO_AL_GRAPH_CONCURRENCY, default 4); merge nodes barrier (`all`) or
 * take the first-N (`quorum`, cancelling still-running losers via AbortSignal);
 * branch nodes are structural passthroughs routed by declared edge predicates
 * (data — never eval'd model text); declared loop edges re-execute their body
 * at most maxIterations times; on failure the default AL3.3 policy halt-graph
 * stops new dispatches, lets in-flight settle, and the report names every
 * failed / cancelled / skipped node — no silent truncation.
 */

import { createLogger } from '../shared/logger.js';
import {
  downstreamOf,
  mergeConfigOf,
  type GraphEdge,
  type GraphNode,
  type WorkflowGraph,
} from './graph-types.js';
import { evaluatePredicateBool, type PredicateContext } from './graph-predicates.js';

const log = createLogger('workflows:graph');

// Public execution types live in ./graph-run-types.ts (max-lines ratchet
// split); re-exported here so consumers may import from either module.
import type {
  GraphNodeResult,
  GraphNodeStatus,
  GraphRunOptions,
  GraphRunReport,
  GraphTraceEntry,
  NodeInput,
  NodeOutcome,
} from './graph-run-types.js';
export type {
  GraphNodeExecutor,
  GraphNodeResult,
  GraphNodeStatus,
  GraphRunOptions,
  GraphRunReport,
  GraphTraceEntry,
  NodeInput,
  NodeOutcome,
} from './graph-run-types.js';

function defaultConcurrency(): number {
  const raw = Number(process.env['SUDO_AL_GRAPH_CONCURRENCY']);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
}

/**
 * Execute a validated WorkflowGraph. Callers must run validateGraph() first
 * (loaders do); the scheduler assumes structural invariants hold.
 */
export async function runGraph(
  graph: WorkflowGraph,
  options: GraphRunOptions,
): Promise<GraphRunReport> {
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? defaultConcurrency());
  const inboundOf = (id: string): GraphEdge[] =>
    graph.edges.filter((e) => e.to === id && e.loop === undefined);
  const loopEdges = graph.edges.filter((e) => e.loop !== undefined);

  const state = new Map<string, GraphNodeStatus>(graph.nodes.map((n) => [n.id, 'pending']));
  const outputs = new Map<string, unknown>();
  const executionCount = new Map<string, number>();
  const settleSeq = new Map<string, number>(); // success order — quorum winners are first-N
  let seq = 0;
  const controllers = new Map<string, AbortController>();
  const loopFired = new Map<string, number>(loopEdges.map((e) => [`${e.from}->${e.to}`, 0]));
  const pendingLoopFirings: GraphEdge[] = [];

  const trace: GraphTraceEntry[] = [];
  const results: GraphNodeResult[] = [];
  let halted = false;
  let parked = false; // AL4.4: a gate parked the run (awaiting_approval)

  interface Settled { nodeId: string; outcome: NodeOutcome; durationMs: number }
  const inFlight = new Map<string, Promise<Settled>>();

  const iterOf = (id: string): number => executionCount.get(id) ?? 0;

  const TERMINAL: ReadonlySet<GraphNodeStatus> = new Set([
    'success', 'failure', 'skipped', 'cancelled', 'pruned', 'awaiting_approval',
  ]);

  const predicateContext = (): PredicateContext => {
    const ctx: PredicateContext = {};
    for (const [id, s] of state) {
      if (TERMINAL.has(s)) ctx[id] = { status: s, output: outputs.get(id) };
    }
    return ctx;
  };

  const edgeActive = (e: GraphEdge): boolean =>
    state.get(e.from) === 'success' &&
    (e.condition === undefined || evaluatePredicateBool(e.condition, predicateContext()));

  const isResolved = (e: GraphEdge): boolean => TERMINAL.has(state.get(e.from)!);

  /** AL3.3 blame rule: a dead input caused by a failed/pruned source prunes
   * the dependent; condition-routing and skips merely skip it. */
  const blamed = (edges: GraphEdge[]): boolean =>
    edges.some((e) => {
      const s = state.get(e.from);
      return s === 'failure' || s === 'pruned';
    });

  const record = (
    id: string,
    status: GraphNodeResult['status'],
    extra: { output?: unknown; error?: string; durationMs?: number; spend?: number } = {},
  ): void => {
    state.set(id, status);
    if (status === 'success') {
      outputs.set(id, extra.output);
      settleSeq.set(id, seq++);
    }
    trace.push({ nodeId: id, event: status, iteration: iterOf(id) });
    const result: GraphNodeResult = {
      id,
      status,
      output: extra.output,
      error: extra.error,
      durationMs: extra.durationMs ?? 0,
      iteration: iterOf(id),
    };
    results.push(result);
    options.onEvent?.({ type: 'node', result, spend: extra.spend });
  };

  /** Downstream subgraph of `start` via non-loop edges, inclusive — the loop body. */
  const resetSetOf = (start: string): Set<string> => downstreamOf(graph, start);

  /** Fire eligible loop back-edges whose reset subgraph has fully settled. */
  const tryFireLoops = (): boolean => {
    let fired = false;
    for (const e of [...pendingLoopFirings]) {
      const body = resetSetOf(e.to);
      if ([...body].some((id) => state.get(id) === 'running')) continue; // wait for stragglers
      pendingLoopFirings.splice(pendingLoopFirings.indexOf(e), 1);
      const key = `${e.from}->${e.to}`;
      loopFired.set(key, (loopFired.get(key) ?? 0) + 1);
      for (const id of body) {
        state.set(id, 'pending');
        outputs.delete(id);
      }
      trace.push({ nodeId: e.to, event: 'loop-reset', iteration: loopFired.get(key)! });
      options.onEvent?.({ type: 'loop', edge: key, iteration: loopFired.get(key)! });
      log.info({ graph: graph.name, edge: key, iteration: loopFired.get(key) }, 'Loop edge fired');
      fired = true;
    }
    return fired;
  };

  /** After a node succeeds, queue loop firings for its eligible back-edges. */
  const queueLoopFirings = (nodeId: string): void => {
    for (const e of loopEdges) {
      if (e.from !== nodeId) continue;
      const key = `${e.from}->${e.to}`;
      if ((loopFired.get(key) ?? 0) >= (e.loop?.maxIterations ?? 0)) continue;
      if (e.condition !== undefined && !evaluatePredicateBool(e.condition, predicateContext())) continue;
      pendingLoopFirings.push(e);
    }
  };

  /** Cancel a quorum loser: abort if running, record terminal 'cancelled'. */
  const cancelNode = (id: string): void => {
    const s = state.get(id);
    if (s !== 'running' && s !== 'pending') return;
    controllers.get(id)?.abort();
    inFlight.delete(id); // outcome discarded — node is terminally cancelled
    record(id, 'cancelled');
    log.info({ graph: graph.name, nodeId: id }, 'Node cancelled (quorum met)');
  };

  const dispatch = (node: GraphNode, inputs: NodeInput[]): void => {
    const executor = options.executors[node.kind as 'agent' | 'tool' | 'gate'];
    executionCount.set(node.id, iterOf(node.id) + 1);
    state.set(node.id, 'running');
    trace.push({ nodeId: node.id, event: 'start', iteration: iterOf(node.id) });
    const controller = new AbortController();
    controllers.set(node.id, controller);
    const t0 = Date.now();

    const attempt = async (): Promise<NodeOutcome> => {
      if (!executor) {
        return { success: false, error: `no executor injected for kind "${node.kind}"` };
      }
      try {
        return await executor(node, inputs, controller.signal);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    // AL2.3 retry semantics: bounded attempts, linear backoff, only the final
    // attempt's outcome is recorded. Cancelled nodes never retry.
    const run = async (): Promise<Settled> => {
      const maxAttempts = node.retry?.max_attempts ?? 1;
      const backoffMs = node.retry?.backoff_ms ?? 0;
      let outcome = await attempt();
      for (let n = 2; n <= maxAttempts && !outcome.success && !controller.signal.aborted; n++) {
        if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs * (n - 1)));
        log.warn({ graph: graph.name, nodeId: node.id, attempt: n, maxAttempts }, 'Node failed — retrying');
        outcome = await attempt();
      }
      return { nodeId: node.id, outcome, durationMs: Date.now() - t0 };
    };
    inFlight.set(node.id, run());
  };

  /** One scheduling pass: fire loops, skip dead nodes, resolve structural nodes, dispatch ready work. */
  const schedule = (): void => {
    let progress = true;
    while (progress) {
      progress = false;
      progress = tryFireLoops() || progress;
      for (const node of graph.nodes) {
        if (state.get(node.id) !== 'pending') continue;
        const inbound = inboundOf(node.id);
        const resolved = inbound.filter(isResolved);
        const active = resolved.filter(edgeActive);

        if (node.kind === 'merge') {
          const cfg = mergeConfigOf(node, inbound.length);
          const needed = cfg.mode === 'quorum' ? (cfg.count as number) : inbound.length;
          if (cfg.mode === 'quorum' && active.length >= needed) {
            // First-N in success order are the winners; still-unsettled losers cancel.
            const winners = [...active]
              .sort((a, b) => (settleSeq.get(a.from) ?? 0) - (settleSeq.get(b.from) ?? 0))
              .slice(0, needed);
            for (const e of inbound) {
              if (!winners.includes(e)) cancelNode(e.from);
            }
            record(node.id, 'success', {
              output: winners.map((e) => outputs.get(e.from)),
            });
            queueLoopFirings(node.id);
            progress = true;
            continue;
          }
          if (resolved.length === inbound.length) {
            // Barrier ('all'): every inbound settled; succeed on the active
            // subset when arms were merely condition-routed away, but a
            // failed/pruned arm breaks the barrier → the merge prunes (AL3.3;
            // quorum is the declared way to tolerate arm loss). A quorum
            // reaching here is impossible to meet → pruned/skipped by blame.
            if (cfg.mode === 'all' && active.length >= 1 && !blamed(inbound)) {
              record(node.id, 'success', { output: active.map((e) => outputs.get(e.from)) });
              queueLoopFirings(node.id);
            } else {
              record(node.id, blamed(inbound) ? 'pruned' : 'skipped');
            }
            progress = true;
          }
          continue;
        }

        // Non-merge: at most one inbound edge (validated). Sources are ready immediately.
        if (inbound.length > 0 && resolved.length < inbound.length) continue;
        if (inbound.length > 0 && active.length === 0) {
          // Dead inputs: pruned when a failed/pruned upstream caused it,
          // skipped when a condition routed away or upstream was skipped.
          record(node.id, blamed(inbound) ? 'pruned' : 'skipped');
          progress = true;
          continue;
        }
        const inputs: NodeInput[] = active.map((e) => ({ fromNodeId: e.from, output: outputs.get(e.from) }));

        if (node.kind === 'branch') {
          // Structural passthrough — routing happens on this node's outbound edge conditions.
          executionCount.set(node.id, iterOf(node.id) + 1);
          record(node.id, 'success', { output: inputs[0]?.output });
          queueLoopFirings(node.id);
          progress = true;
          continue;
        }

        if (inFlight.size >= maxConcurrency) continue; // cap reached — wait for a settle
        dispatch(node, inputs);
        progress = true;
      }
    }
  };

  // AL4.2 resume: seed successful nodes as settled (outputs feed downstream
  // without re-execution); every other recorded status re-runs. Seeded nodes
  // are NOT re-emitted into results/trace/onEvent — the report of a resumed
  // run covers only this run's work; the store holds the merged history.
  if (options.resume) {
    for (const [key, count] of Object.entries(options.resume.loopIterations)) {
      if (loopFired.has(key)) loopFired.set(key, count);
    }
    for (const n of options.resume.nodes) {
      if (!state.has(n.id)) continue; // hash check upstream makes this unreachable
      executionCount.set(n.id, n.iteration);
      if (n.status === 'success') {
        state.set(n.id, 'success');
        outputs.set(n.id, n.output);
        settleSeq.set(n.id, seq++);
      }
    }
    // Re-evaluate loop edges off seeded successes so a crash between a loop
    // source settling and its firing still converges (counters are restored,
    // so already-recorded firings never double-fire past maxIterations).
    for (const n of options.resume.nodes) {
      if (n.status === 'success' && state.get(n.id) === 'success') queueLoopFirings(n.id);
    }
  }

  log.info(
    { graph: graph.name, nodes: graph.nodes.length, edges: graph.edges.length, maxConcurrency },
    'Running graph',
  );
  const startedAt = new Date().toISOString();

  while (true) {
    if (!halted) schedule();
    if (inFlight.size === 0) break;
    const settled = await Promise.race(inFlight.values());
    // A cancelled node's promise may settle late — its terminal state already
    // stands and the outcome is discarded.
    if (!inFlight.has(settled.nodeId) || state.get(settled.nodeId) !== 'running') {
      inFlight.delete(settled.nodeId);
      continue;
    }
    inFlight.delete(settled.nodeId);
    controllers.delete(settled.nodeId);
    if (settled.outcome.success) {
      record(settled.nodeId, 'success', {
        output: settled.outcome.output,
        durationMs: settled.durationMs,
        spend: settled.outcome.spend,
      });
      queueLoopFirings(settled.nodeId);
    } else if (settled.outcome.park) {
      // AL4.4 gate park: run stops dispatching (like halt) but the node and
      // run record awaiting_approval — resumable once the artifact is decided.
      record(settled.nodeId, 'awaiting_approval', {
        error: settled.outcome.error,
        durationMs: settled.durationMs,
        spend: settled.outcome.spend,
      });
      halted = true;
      parked = true;
      log.info({ graph: graph.name, nodeId: settled.nodeId }, 'Gate parked — awaiting approval');
    } else {
      record(settled.nodeId, 'failure', {
        error: settled.outcome.error ?? 'node failed',
        durationMs: settled.durationMs,
        spend: settled.outcome.spend,
      });
      const policy =
        graph.nodes.find((n) => n.id === settled.nodeId)?.onFailure ?? 'halt-graph';
      if (policy === 'prune-branch') {
        // AL3.3: dependents prune via the blame rule on the next schedule pass;
        // sibling branches keep running.
        log.warn({ graph: graph.name, nodeId: settled.nodeId }, 'Node failed — pruning its branch');
      } else {
        halted = true; // AL3.3 default policy: halt-graph
        log.warn({ graph: graph.name, nodeId: settled.nodeId }, 'Node failed — halting graph');
      }
    }
  }

  // Anything still pending was unreachable (halt, or an impossible quorum):
  // name it honestly rather than dropping it from the report.
  for (const [id, s] of state) {
    if (s === 'pending') record(id, 'skipped');
  }

  const byStatus = (want: GraphNodeResult['status']): string[] =>
    [...new Set(results.filter((r) => r.status === want).map((r) => r.id))];
  const failedNodes = byStatus('failure');
  return {
    graphName: graph.name,
    startedAt,
    status: parked ? 'awaiting_approval'
      : halted ? 'halted'
      : failedNodes.length > 0 ? 'partial' : 'success',
    results,
    trace,
    failedNodes,
    cancelledNodes: byStatus('cancelled'),
    skippedNodes: byStatus('skipped'),
    prunedNodes: byStatus('pruned'),
    loopIterations: Object.fromEntries(loopFired),
  };
}
