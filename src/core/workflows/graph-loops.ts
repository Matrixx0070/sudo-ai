/**
 * @file workflows/graph-loops.ts
 * @description Declared-loop machinery for the AL3.2 graph executor — split
 * from graph-executor.ts under the max-lines ratchet. A loop back-edge fires
 * when its source succeeds, its condition holds, and its firing count is
 * below maxIterations; firing resets the target's downstream subgraph (the
 * loop body) to pending once no body member is still running.
 */

import { createLogger } from '../shared/logger.js';
import { downstreamOf, type GraphEdge, type WorkflowGraph } from './graph-types.js';
import { evaluatePredicateBool, type PredicateContext } from './graph-predicates.js';
import type { GraphNodeStatus, GraphPersistEvent, GraphTraceEntry } from './graph-run-types.js';

const log = createLogger('workflows:graph');

export interface LoopMachineryDeps {
  graph: WorkflowGraph;
  /** Executor-owned mutable state — the machinery resets body nodes in place. */
  state: Map<string, GraphNodeStatus>;
  outputs: Map<string, unknown>;
  /** Firing counters keyed "from->to" — also the executor's report/resume surface. */
  loopFired: Map<string, number>;
  trace: GraphTraceEntry[];
  predicateContext: () => PredicateContext;
  onEvent?: (event: GraphPersistEvent) => void;
}

export interface LoopMachinery {
  /** Fire eligible queued back-edges whose body has fully settled. True when any fired. */
  tryFireLoops: () => boolean;
  /** After a node succeeds, queue firings for its eligible back-edges. */
  queueLoopFirings: (nodeId: string) => void;
}

export function createLoopMachinery(deps: LoopMachineryDeps): LoopMachinery {
  const { graph, state, outputs, loopFired, trace, predicateContext, onEvent } = deps;
  const loopEdges = graph.edges.filter((e) => e.loop !== undefined);
  const pending: GraphEdge[] = [];

  const tryFireLoops = (): boolean => {
    let fired = false;
    for (const e of [...pending]) {
      const body = downstreamOf(graph, e.to);
      if ([...body].some((id) => state.get(id) === 'running')) continue; // wait for stragglers
      pending.splice(pending.indexOf(e), 1);
      const key = `${e.from}->${e.to}`;
      loopFired.set(key, (loopFired.get(key) ?? 0) + 1);
      for (const id of body) {
        state.set(id, 'pending');
        outputs.delete(id);
      }
      trace.push({ nodeId: e.to, event: 'loop-reset', iteration: loopFired.get(key)! });
      onEvent?.({ type: 'loop', edge: key, iteration: loopFired.get(key)! });
      log.info({ graph: graph.name, edge: key, iteration: loopFired.get(key) }, 'Loop edge fired');
      fired = true;
    }
    return fired;
  };

  const queueLoopFirings = (nodeId: string): void => {
    for (const e of loopEdges) {
      if (e.from !== nodeId) continue;
      const key = `${e.from}->${e.to}`;
      if ((loopFired.get(key) ?? 0) >= (e.loop?.maxIterations ?? 0)) continue;
      if (e.condition !== undefined && !evaluatePredicateBool(e.condition, predicateContext())) continue;
      pending.push(e);
    }
  };

  return { tryFireLoops, queueLoopFirings };
}
