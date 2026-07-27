/**
 * @file workflows/graph-predicates.ts
 * @description JSONLogic-style predicate language for the AL3 graph engine.
 *
 * Predicates are PURE DATA — JSON-serializable expressions evaluated by a
 * recursive walk. There is no eval, no Function constructor, and model text is
 * never interpreted as a predicate: authors declare predicates in the graph
 * definition; node outputs are only ever the *operands* looked up via `var`.
 *
 * Supported forms:
 *   literals            — string | number | boolean | null
 *   { var: "id.path" }  — value lookup into prior node results:
 *                         "check.status" → node check's status,
 *                         "check.output" → node check's output,
 *                         "check.output.score" → dot-path into the output value
 *   { "===": [a, b] }   — strict equality
 *   { "!==": [a, b] }   — strict inequality
 *   { ">":  [a, b] }    — numeric greater-than (false unless both numbers)
 *   { "<":  [a, b] }    — numeric less-than (false unless both numbers)
 *   { and: [p, ...] }   — logical AND over boolean results
 *   { or:  [p, ...] }   — logical OR over boolean results
 *   { "!": p }          — logical NOT
 */

/** Recursive predicate expression — see file doc for the supported forms. */
export type GraphPredicate =
  | string
  | number
  | boolean
  | null
  | { var: string }
  | { '===': [GraphPredicate, GraphPredicate] }
  | { '!==': [GraphPredicate, GraphPredicate] }
  | { '>': [GraphPredicate, GraphPredicate] }
  | { '<': [GraphPredicate, GraphPredicate] }
  | { and: GraphPredicate[] }
  | { or: GraphPredicate[] }
  | { '!': GraphPredicate };

/**
 * Evaluation context: settled node results keyed by node id. `output` is the
 * raw (JSON-ish) value the node's executor returned; `status` is the node's
 * terminal status string.
 */
export type PredicateContext = Record<string, { status: string; output?: unknown }>;

/** Nesting bound — malformed deeply-recursive predicates fail loudly. */
const MAX_PREDICATE_DEPTH = 32;

/** `var` paths: dot-separated segments of [a-zA-Z0-9_-]. First segment = node id. */
const VAR_PATH_RE = /^[a-z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/;

const BINARY_OPS = new Set(['===', '!==', '>', '<']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Extract the single operator key of a predicate object, or throw. */
function operatorOf(pred: Record<string, unknown>): string {
  const keys = Object.keys(pred);
  if (keys.length !== 1) {
    throw new Error(`predicate object must have exactly one operator key (got ${JSON.stringify(keys)})`);
  }
  return keys[0]!;
}

/** Resolve a `var` path against the context. Unknown segments resolve to undefined. */
function resolveVar(varPath: string, ctx: PredicateContext): unknown {
  const [nodeId, field, ...rest] = varPath.split('.') as [string, string, ...string[]];
  const entry = ctx[nodeId];
  if (!entry) return undefined;
  let value: unknown;
  if (field === 'status') value = entry.status;
  else if (field === 'output') value = entry.output;
  else return undefined; // only status/output are addressable — enforced at validation too
  for (const seg of rest) {
    if (!isPlainObject(value)) return undefined;
    value = value[seg];
  }
  return value;
}

/**
 * Evaluate a predicate to its raw value. Structural errors (unknown operator,
 * bad arity) throw — but graphs validated via {@link validatePredicate} at
 * load time never reach those throws at runtime.
 */
export function evaluatePredicate(
  pred: GraphPredicate,
  ctx: PredicateContext,
  depth = 0,
): unknown {
  if (depth > MAX_PREDICATE_DEPTH) {
    throw new Error(`predicate exceeds max nesting depth ${MAX_PREDICATE_DEPTH}`);
  }
  if (pred === null || typeof pred !== 'object') return pred; // literal
  if (Array.isArray(pred)) {
    throw new Error('bare arrays are not valid predicates');
  }
  const obj = pred as Record<string, unknown>;
  const op = operatorOf(obj);

  if (op === 'var') {
    return resolveVar(String(obj['var']), ctx);
  }
  if (BINARY_OPS.has(op)) {
    const [a, b] = obj[op] as [GraphPredicate, GraphPredicate];
    const lhs = evaluatePredicate(a, ctx, depth + 1);
    const rhs = evaluatePredicate(b, ctx, depth + 1);
    if (op === '===') return lhs === rhs;
    if (op === '!==') return lhs !== rhs;
    if (typeof lhs !== 'number' || typeof rhs !== 'number') return false;
    return op === '>' ? lhs > rhs : lhs < rhs;
  }
  if (op === 'and' || op === 'or') {
    const operands = obj[op] as GraphPredicate[];
    if (op === 'and') return operands.every((p) => truthy(evaluatePredicate(p, ctx, depth + 1)));
    return operands.some((p) => truthy(evaluatePredicate(p, ctx, depth + 1)));
  }
  if (op === '!') {
    return !truthy(evaluatePredicate(obj['!'] as GraphPredicate, ctx, depth + 1));
  }
  throw new Error(`unknown predicate operator "${op}"`);
}

/** JS truthiness, centralized so edge-condition semantics stay in one place. */
function truthy(v: unknown): boolean {
  return Boolean(v);
}

/** Evaluate a predicate as an edge condition — coerced to boolean. */
export function evaluatePredicateBool(pred: GraphPredicate, ctx: PredicateContext): boolean {
  return truthy(evaluatePredicate(pred, ctx));
}

/**
 * Statically validate a predicate at graph load time (AL2.3 fail-loud rule:
 * a typo'd predicate throws when the graph is validated, never silently
 * mis-routes at runtime). `var` first segments must name a known node id and
 * the second segment must be `status` or `output`.
 */
export function validatePredicate(
  pred: GraphPredicate,
  knownNodeIds: ReadonlySet<string>,
  depth = 0,
): void {
  if (depth > MAX_PREDICATE_DEPTH) {
    throw new Error(`predicate exceeds max nesting depth ${MAX_PREDICATE_DEPTH}`);
  }
  if (pred === null) return;
  const t = typeof pred;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (!isPlainObject(pred)) {
    throw new Error('predicate must be a literal or a single-operator object');
  }
  const obj = pred as Record<string, unknown>;
  const op = operatorOf(obj);

  if (op === 'var') {
    const varPath = obj['var'];
    if (typeof varPath !== 'string' || !VAR_PATH_RE.test(varPath)) {
      throw new Error(
        `var path ${JSON.stringify(varPath)} is malformed (expected "<node-id>.<status|output>[.field...]")`,
      );
    }
    const [nodeId, field] = varPath.split('.') as [string, string];
    if (!knownNodeIds.has(nodeId)) {
      throw new Error(`var "${varPath}" references unknown node "${nodeId}"`);
    }
    if (field !== 'status' && field !== 'output') {
      throw new Error(`var "${varPath}" must address .status or .output (got ".${field}")`);
    }
    return;
  }
  if (BINARY_OPS.has(op)) {
    const operands = obj[op];
    if (!Array.isArray(operands) || operands.length !== 2) {
      throw new Error(`operator "${op}" requires exactly two operands`);
    }
    for (const o of operands) validatePredicate(o as GraphPredicate, knownNodeIds, depth + 1);
    return;
  }
  if (op === 'and' || op === 'or') {
    const operands = obj[op];
    if (!Array.isArray(operands) || operands.length === 0) {
      throw new Error(`operator "${op}" requires a non-empty operand array`);
    }
    for (const o of operands) validatePredicate(o as GraphPredicate, knownNodeIds, depth + 1);
    return;
  }
  if (op === '!') {
    validatePredicate(obj['!'] as GraphPredicate, knownNodeIds, depth + 1);
    return;
  }
  throw new Error(`unknown predicate operator "${op}"`);
}
