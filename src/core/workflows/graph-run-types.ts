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
  | 'pruned'
  | 'awaiting_approval';

/** Outcome an injected executor returns for one node execution. */
export interface NodeOutcome {
  success: boolean;
  /** JSON-ish value downstream predicates and inputs see. */
  output?: unknown;
  error?: string;
  /** Tokens spent by this execution — accumulated onto the run's budget_spent (AL4.2; limits enforced by the AL4.5 governor). */
  spend?: number;
  /**
   * AL4.4 gate parking: success=false + park=true parks the RUN — the node
   * records `awaiting_approval`, no new work dispatches, in-flight settles,
   * and the report status is 'awaiting_approval' (resumable once the durable
   * approval artifact is decided). Only gate executors should set this.
   */
  park?: boolean;
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
  event: Exclude<GraphNodeStatus, 'pending' | 'running'> | 'start' | 'loop-reset';
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
   * surviving branches completed; 'awaiting_approval' — a gate parked the
   * run (resume after the durable approval artifact is decided);
   * 'success' — no failures.
   */
  status: 'success' | 'partial' | 'halted' | 'awaiting_approval';
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

/**
 * Persistence event stream (AL4.2). Emitted synchronously by the executor
 * after every terminal node record and every loop-edge firing, so a durable
 * store loses at most the in-flight nodes on a crash.
 */
export type GraphPersistEvent =
  | { type: 'node'; result: GraphNodeResult; spend?: number }
  | { type: 'loop'; edge: string; iteration: number };

/**
 * Resume seed (AL4.2): the latest per-node terminal state of a prior run.
 * Successful nodes seed as settled (their outputs feed downstream without
 * re-execution); every other status re-runs — a recorded failure is a fact
 * about that attempt, not the world (AL2.4 semantics).
 */
export interface GraphResumeState {
  nodes: Array<{
    id: string;
    status: Exclude<GraphNodeStatus, 'pending' | 'running'>;
    output?: unknown;
    iteration: number;
  }>;
  loopIterations: Record<string, number>;
}

export interface GraphRunOptions {
  /** Execution seams by node kind. A missing seam fails that node honestly. */
  executors: Partial<Record<'agent' | 'tool' | 'gate', GraphNodeExecutor>>;
  /** Max concurrent agent/tool/gate executions. Default env SUDO_AL_GRAPH_CONCURRENCY or 4. */
  maxConcurrency?: number;
  /** Durable-store seam: called synchronously per terminal record / loop firing. */
  onEvent?: (event: GraphPersistEvent) => void;
  /** Seed settled state from a prior run (validate hash before building this — see GraphRunStore.loadResumeState). */
  resume?: GraphResumeState;
}
