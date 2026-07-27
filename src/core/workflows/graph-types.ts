/**
 * @file workflows/graph-types.ts
 * @description AL3.1 graph schema — directed workflow graphs with branching,
 * merging, parallel execution, and explicitly-declared loops.
 *
 * The schema is PURE DATA: JSON-serializable, no functions. Execution seams
 * (how an `agent` / `tool` / `gate` node actually runs) are injected into the
 * executor by the caller, exactly like ToolStepExecutor in the linear engine.
 *
 * Cycle policy: the graph restricted to non-loop edges must be a DAG. A cycle
 * is only legal through an edge explicitly marked `loop: { maxIterations }`,
 * and such an edge must be a true back-edge (its target must be an ancestor
 * of its source), so iteration is always bounded by construction.
 */

import { MAX_RETRY_ATTEMPTS } from './validate.js';
import { validatePredicate, type GraphPredicate } from './graph-predicates.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Node kinds:
 *   agent  — a model-driven step (AL1 loop step executor; injected seam)
 *   tool   — a deterministic tool step (AL2 step contract; injected seam)
 *   gate   — human-approval step (AL4.4 wires the approval matrix; injected seam)
 *   merge  — structural fan-in: barrier (`all`) or first-N (`quorum`)
 *   branch — structural fan-out: routes via declared edge conditions
 */
export type GraphNodeKind = 'agent' | 'tool' | 'gate' | 'merge' | 'branch';

/** Merge fan-in policy — `all` is a barrier; `quorum` proceeds on the first `count`. */
export interface MergeConfig {
  mode: 'all' | 'quorum';
  /** Required when mode is 'quorum': 1..(inbound edge count). */
  count?: number;
}

export interface GraphNode {
  /** Unique id, /^[a-z0-9_-]+$/ — same charset as linear step ids. */
  id: string;
  kind: GraphNodeKind;
  /**
   * Kind-specific configuration, JSON-serializable. For `merge` nodes the
   * `merge` key holds a {@link MergeConfig}. For agent/tool/gate nodes the
   * config is passed verbatim to the injected executor.
   */
  config?: Record<string, unknown>;
  /**
   * Declarative resource bound. Schema-only at AL3 — enforcement is the AL4.5
   * resource governor's job; validated here so authored graphs are honest.
   */
  budget?: { maxTokens?: number; maxMs?: number };
  /** Per-node retry policy — AL2.3 semantics (bounded attempts, linear backoff). */
  retry?: { max_attempts: number; backoff_ms?: number };
}

export interface GraphEdge {
  from: string;
  to: string;
  /**
   * Declared data predicate — the edge is taken only when it evaluates truthy
   * against settled node results. Predicates are data (JSONLogic-style),
   * never eval'd model text.
   */
  condition?: GraphPredicate;
  /**
   * Marks a declared loop back-edge. When the source settles successfully and
   * `condition` (if any) holds, the target node and its downstream subgraph
   * re-execute — at most `maxIterations` times, bounded by construction.
   */
  loop?: { maxIterations: number };
}

export interface WorkflowGraph {
  name: string;
  description?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NODE_ID_RE = /^[a-z0-9_-]+$/;
const NODE_KINDS: ReadonlySet<string> = new Set(['agent', 'tool', 'gate', 'merge', 'branch']);
/** Upper bound on declared loop iterations — bounded by construction, like retries. */
export const MAX_LOOP_ITERATIONS = 100;

/** Structural node checks — id, kind, retry policy, budget shape. */
function validateNode(node: GraphNode): void {
  if (!node.id || !NODE_ID_RE.test(node.id)) {
    throw new Error(`Invalid node id "${node.id}": must match /^[a-z0-9_-]+$/`);
  }
  if (!NODE_KINDS.has(node.kind)) {
    throw new Error(`Node "${node.id}": unknown kind "${node.kind}"`);
  }
  if (node.retry !== undefined) {
    const { max_attempts, backoff_ms } = node.retry;
    if (!Number.isInteger(max_attempts) || max_attempts < 1 || max_attempts > MAX_RETRY_ATTEMPTS) {
      throw new Error(
        `Node "${node.id}": retry.max_attempts must be an integer 1..${MAX_RETRY_ATTEMPTS} (got ${max_attempts})`,
      );
    }
    if (backoff_ms !== undefined && (typeof backoff_ms !== 'number' || !Number.isFinite(backoff_ms) || backoff_ms < 0)) {
      throw new Error(`Node "${node.id}": retry.backoff_ms must be a non-negative number`);
    }
    if (node.kind === 'gate' || node.kind === 'merge' || node.kind === 'branch') {
      throw new Error(`Node "${node.id}": retry is only valid on agent/tool nodes (got kind "${node.kind}")`);
    }
  }
  if (node.budget !== undefined) {
    for (const key of ['maxTokens', 'maxMs'] as const) {
      const v = node.budget[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
        throw new Error(`Node "${node.id}": budget.${key} must be a positive number`);
      }
    }
  }
}

/** Parse + validate a merge node's MergeConfig against its inbound edge count. */
export function mergeConfigOf(node: GraphNode, inboundCount: number): MergeConfig {
  const raw = node.config?.['merge'];
  const cfg: MergeConfig =
    raw !== undefined && typeof raw === 'object' && raw !== null
      ? (raw as MergeConfig)
      : { mode: 'all' };
  if (cfg.mode !== 'all' && cfg.mode !== 'quorum') {
    throw new Error(`Merge node "${node.id}": merge.mode must be "all" or "quorum"`);
  }
  if (cfg.mode === 'quorum') {
    if (!Number.isInteger(cfg.count) || (cfg.count as number) < 1 || (cfg.count as number) > inboundCount) {
      throw new Error(
        `Merge node "${node.id}": merge.count must be an integer 1..${inboundCount} (got ${cfg.count})`,
      );
    }
  }
  return cfg;
}

/** True when `target` is reachable from `start` following non-loop edges. */
function reaches(start: string, target: string, adjacency: Map<string, string[]>): boolean {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Validate a WorkflowGraph. Throws with a descriptive message on the first
 * violation. Checks: node/edge structure, single-inbound rule for non-merge
 * nodes, branch/merge shape, predicate well-formedness, acyclicity of the
 * non-loop subgraph, and loop edges being true bounded back-edges.
 */
export function validateGraph(graph: WorkflowGraph): void {
  if (!graph.name || typeof graph.name !== 'string') {
    throw new Error('Graph must have a non-empty string "name"');
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error(`Graph "${graph.name}": must have at least one node`);
  }
  if (!Array.isArray(graph.edges)) {
    throw new Error(`Graph "${graph.name}": edges must be an array`);
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    validateNode(node);
    if (nodeIds.has(node.id)) {
      throw new Error(`Graph "${graph.name}": duplicate node id "${node.id}"`);
    }
    nodeIds.add(node.id);
  }

  const inbound = new Map<string, GraphEdge[]>();
  const outbound = new Map<string, GraphEdge[]>();
  const seenPairs = new Set<string>();
  const dagAdjacency = new Map<string, string[]>(); // non-loop edges only
  for (const edge of graph.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!nodeIds.has(end)) {
        throw new Error(`Graph "${graph.name}": edge ${edge.from}->${edge.to} references unknown node "${end}"`);
      }
    }
    const pairKey = `${edge.from}->${edge.to}`;
    if (seenPairs.has(pairKey)) {
      throw new Error(`Graph "${graph.name}": duplicate edge ${pairKey}`);
    }
    seenPairs.add(pairKey);
    if (edge.condition !== undefined) {
      try {
        validatePredicate(edge.condition, nodeIds);
      } catch (err) {
        throw new Error(
          `Graph "${graph.name}", edge ${pairKey}: invalid condition — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (edge.loop !== undefined) {
      const { maxIterations } = edge.loop;
      if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_LOOP_ITERATIONS) {
        throw new Error(
          `Graph "${graph.name}", edge ${pairKey}: loop.maxIterations must be an integer 1..${MAX_LOOP_ITERATIONS}`,
        );
      }
    } else {
      if (edge.from === edge.to) {
        throw new Error(`Graph "${graph.name}": self-edge on "${edge.from}" requires a loop declaration`);
      }
      dagAdjacency.set(edge.from, [...(dagAdjacency.get(edge.from) ?? []), edge.to]);
    }
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge]);
    outbound.set(edge.from, [...(outbound.get(edge.from) ?? []), edge]);
  }

  // Per-kind shape rules. Only merge nodes may fan-in: a multi-inbound plain
  // node has no declared join semantics, so it must be an explicit merge.
  for (const node of graph.nodes) {
    const nonLoopInbound = (inbound.get(node.id) ?? []).filter((e) => e.loop === undefined);
    const out = outbound.get(node.id) ?? [];
    if (node.kind === 'merge') {
      if (nonLoopInbound.length < 2) {
        throw new Error(`Merge node "${node.id}": needs at least 2 inbound edges (got ${nonLoopInbound.length})`);
      }
      mergeConfigOf(node, nonLoopInbound.length); // throws on bad config
    } else if (nonLoopInbound.length > 1) {
      throw new Error(
        `Node "${node.id}": ${nonLoopInbound.length} inbound edges — only merge nodes may fan-in`,
      );
    }
    if (node.kind === 'branch' && out.filter((e) => e.loop === undefined).length < 2) {
      throw new Error(`Branch node "${node.id}": needs at least 2 outbound edges`);
    }
  }

  // Acyclicity of the non-loop subgraph (Kahn's algorithm).
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const targets of dagAdjacency.values()) {
    for (const t of targets) inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
  }
  const queue = [...nodeIds].filter((id) => inDegree.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const t of dagAdjacency.get(id) ?? []) {
      const d = (inDegree.get(t) ?? 0) - 1;
      inDegree.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  if (visited !== nodeIds.size) {
    const cyclic = [...nodeIds].filter((id) => (inDegree.get(id) ?? 0) > 0).sort();
    throw new Error(
      `Graph "${graph.name}": cycle detected among [${cyclic.join(', ')}] — ` +
        'cycles must be declared via loop: { maxIterations } on the back-edge',
    );
  }

  // Loop edges must be true back-edges: the target must reach the source
  // through non-loop edges, so the loop body is a well-defined subgraph.
  for (const edge of graph.edges) {
    if (edge.loop === undefined) continue;
    if (edge.from !== edge.to && !reaches(edge.to, edge.from, dagAdjacency)) {
      throw new Error(
        `Graph "${graph.name}": loop edge ${edge.from}->${edge.to} is not a back-edge — ` +
          'its target must be an ancestor of its source',
      );
    }
  }
}
