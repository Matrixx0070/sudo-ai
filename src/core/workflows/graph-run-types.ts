/**
 * @file workflows/graph-run-types.ts
 * @description Public execution types for the AL3.2 graph executor — node
 * status/outcome/result shapes, the injected executor seam, trace entries, and
 * the run report. Split from graph-executor.ts under the max-lines ratchet;
 * graph-executor re-exports everything here, so consumers may import from
 * either module.
 */

import type { GraphNode } from './graph-types.js';

export type GraphNodeStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'cancelled'
  | 'pruned';

/** Outcome an injected executor returns for one node execution. */
export interface NodeOutcome {
  success: boolean;
  /** JSON-ish value downstream predicates and inputs see. */
  output?: unknown;
  error?: string;
}

/** One upstream value delivered to a node — active inbound edges, in edge order. */
export interface NodeInput {
  fromNodeId: string;
  output: unknown;
}

/**
 * Injected execution seam for agent / tool / gate nodes. The signal fires when
 * the scheduler cancels the node (quorum loser); executors should abandon work
 * cooperatively — the scheduler discards the outcome either way.
 */
export type GraphNodeExecutor = (
  node: GraphNode,
  inputs: NodeInput[],
  signal: AbortSignal,
) => Promise<NodeOutcome>;

export interface GraphTraceEntry {
  nodeId: string;
  event: 'start' | 'success' | 'failure' | 'skipped' | 'cancelled' | 'pruned' | 'loop-reset';
  /** Execution count for this node at the time of the event (0 = never ran). */
  iteration: number;
}

export interface GraphNodeResult {
  id: string;
  status: Exclude<GraphNodeStatus, 'pending' | 'running'>;
  output?: unknown;
  error?: string;
  durationMs: number;
  iteration: number;
}

export interface GraphRunReport {
  graphName: string;
  startedAt: string;
  /**
   * 'halted' — a node failed under the default halt-graph policy;
   * 'partial' — failures occurred but every one was prune-branch, so the
   * surviving branches completed; 'success' — no failures.
   */
  status: 'success' | 'partial' | 'halted';
  /** Terminal results in settle order — one entry per node execution/skip/cancel/prune. */
  results: GraphNodeResult[];
  trace: GraphTraceEntry[];
  failedNodes: string[];
  cancelledNodes: string[];
  skippedNodes: string[];
  /** Downstream victims of prune-branch failures (AL3.3) — named, never silent. */
  prunedNodes: string[];
  /** Times each declared loop edge fired, keyed "from->to". */
  loopIterations: Record<string, number>;
}

export interface GraphRunOptions {
  /** Execution seams by node kind. A missing seam fails that node honestly. */
  executors: Partial<Record<'agent' | 'tool' | 'gate', GraphNodeExecutor>>;
  /** Max concurrent agent/tool/gate executions. Default env SUDO_AL_GRAPH_CONCURRENCY or 4. */
  maxConcurrency?: number;
}
