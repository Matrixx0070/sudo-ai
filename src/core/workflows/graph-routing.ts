/**
 * @file workflows/graph-routing.ts
 * @description AL4.3 route-per-node — agent nodes declare a ROUTE HINT in
 * their config; concrete models are resolved exclusively through the existing
 * src/llm/ layer (aliases + runWithPolicy). A hardcoded `provider/model`
 * string in a graph config is a load-time error: swapping the fleet stays
 * config, not graph edits, and the failover chain stays exactly as
 * prod-configured.
 *
 * Vocabulary (node.config.route):
 *   'reasoning'   → sudo/mid
 *   'cheap'       → sudo/cheap
 *   any sudo/*    → itself (explicit route id, e.g. 'sudo/frontier')
 *   absent        → sudo/cheap — cheap by default; reasoning is requested
 *                   explicitly (classify/extract-style nodes ride the cheap
 *                   router without authors thinking about it)
 *
 * Policy composition: every routed call runs inside runWithPolicy (per-route
 * breaker, priority lanes, daily budgets) with caller
 * `workflow:<graph>:<node>` and maxAttempts=1 — the graph engine owns retry
 * (node.retry, AL2.3), and the AL4.1 audit's "three unaware retry layers
 * would stack" finding is exactly what this prevents.
 */

import { isSudoAlias, resolveAlias, type SudoAlias } from '../../llm/aliases.js';
import { runWithPolicy } from '../../llm/policy.js';
import type { GraphNode, WorkflowGraph } from './graph-types.js';
import type { GraphNodeExecutor, NodeInput, NodeOutcome } from './graph-run-types.js';

/** Semantic hints — the only non-alias route values graphs may use. */
const ROUTE_HINTS: Record<string, SudoAlias> = {
  reasoning: 'sudo/mid',
  cheap: 'sudo/cheap',
};

const DEFAULT_ALIAS: SudoAlias = 'sudo/cheap';

export interface ResolvedNodeRoute {
  /** The sudo/* alias the node resolved to — also the policy route key. */
  alias: SudoAlias;
  /** Concrete provider/model, resolved via resolveAlias at call time. */
  model: string;
}

/**
 * Resolve an agent node's route hint. Throws (fail-loud, AL2.3 rule) on any
 * value outside the hint vocabulary or the sudo/* alias set — in particular
 * on raw provider/model strings.
 */
export function resolveNodeRoute(node: GraphNode): ResolvedNodeRoute {
  const raw = node.config?.['route'];
  if (raw === undefined) {
    return { alias: DEFAULT_ALIAS, model: resolveAlias(DEFAULT_ALIAS) };
  }
  if (typeof raw !== 'string') {
    throw new Error(`Node "${node.id}": route must be a string (got ${typeof raw})`);
  }
  const alias = ROUTE_HINTS[raw] ?? raw;
  if (!isSudoAlias(alias)) {
    throw new Error(
      `Node "${node.id}": route "${raw}" is not a hint (${Object.keys(ROUTE_HINTS).join('|')}) ` +
        'or a sudo/* alias — concrete model strings are forbidden in graph configs',
    );
  }
  return { alias, model: resolveAlias(alias) };
}

/** Load-time check: every agent node's route resolves. Call beside validateGraph. */
export function validateGraphRoutes(graph: WorkflowGraph): void {
  for (const node of graph.nodes) {
    if (node.kind === 'agent') resolveNodeRoute(node);
  }
}

/** What a routed agent call receives — the resolved route plus the node context. */
export interface RoutedCallContext {
  node: GraphNode;
  inputs: NodeInput[];
  signal: AbortSignal;
  route: ResolvedNodeRoute;
}

export interface RoutedAgentExecutorOptions {
  graphName: string;
  /**
   * Policy lane. Default 'background' — graph runs are unattended work, so
   * budget exhaustion fails closed rather than silently degrading.
   */
  priority?: 'user' | 'background';
  /** Optional pre-flight cost estimate per node, counted against budgets. */
  estimateCostUsd?: (node: GraphNode) => number | undefined;
  /** The actual model call (brain/transport seam — wired at AL5). */
  call: (ctx: RoutedCallContext) => Promise<NodeOutcome>;
}

/**
 * Wrap a model-call seam as the graph's `agent` executor: resolve the node's
 * route, then run the call inside runWithPolicy under caller
 * `workflow:<graph>:<node>`. Policy refusals (open breaker, budget exhausted
 * on the background lane) surface as honest node failures — the graph's own
 * failure policy (halt/prune/retry) decides what happens next.
 */
export function createRoutedAgentExecutor(options: RoutedAgentExecutorOptions): GraphNodeExecutor {
  return async (node, inputs, signal) => {
    let route: ResolvedNodeRoute;
    try {
      route = resolveNodeRoute(node);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const outcome = await runWithPolicy<NodeOutcome>({
        route: route.alias,
        caller: `workflow:${options.graphName}:${node.id}`,
        priority: options.priority ?? 'background',
        estimateCostUsd: options.estimateCostUsd?.(node),
        attempt: () => options.call({ node, inputs, signal, route }),
        maxAttempts: 1, // graph engine owns retry (node.retry) — never stack layers
      });
      return outcome.value;
    } catch (err) {
      return {
        success: false,
        error: `policy refused route ${route.alias}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
