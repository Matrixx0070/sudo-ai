/**
 * @file workflows/index.ts
 * @description Public surface of the Lobster workflow engine.
 *
 * Re-exports all types and functions needed by callers that integrate
 * the workflow engine into SUDO-AI's CLI or agent loop.
 */

export type {
  WorkflowStep,
  Workflow,
  StepResult,
  WorkflowRunState,
  RunOptions,
  ToolStepResult,
  ToolStepExecutor,
} from './lobster.js';

export { loadWorkflow, runWorkflow } from './lobster.js';

// AL3 graph engine (graph-types + graph-executor)
export type {
  GraphNode,
  GraphEdge,
  WorkflowGraph,
  GraphNodeKind,
  MergeConfig,
} from './graph-types.js';
export { validateGraph, MAX_LOOP_ITERATIONS } from './graph-types.js';
export type { GraphPredicate, PredicateContext } from './graph-predicates.js';
export { evaluatePredicate, evaluatePredicateBool, validatePredicate } from './graph-predicates.js';
export type {
  GraphNodeExecutor,
  GraphNodeResult,
  GraphPersistEvent,
  GraphResumeState,
  GraphRunOptions,
  GraphRunReport,
  GraphTraceEntry,
  NodeInput,
  NodeOutcome,
} from './graph-run-types.js';
export { runGraph } from './graph-executor.js';
export { compileWorkflowToGraph, createStepNodeExecutors } from './graph-compile.js';
export type { StepNodeExecutorOptions } from './graph-compile.js';
