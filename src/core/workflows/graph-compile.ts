/**
 * @file workflows/graph-compile.ts
 * @description AL3.5 — compile linear .lobster.yaml workflows into trivial
 * graphs so ONE engine (the AL3.2 graph executor) serves both authoring
 * surfaces. Old YAML files keep working unchanged: loadWorkflow/runWorkflow
 * are untouched; this module maps an already-validated linear Workflow onto
 * the graph schema plus a step-node executor adapter that reuses the linear
 * engine's own primitives (renderTemplate, evaluateCondition, execShell,
 * ToolStepExecutor).
 *
 * Semantics preserved exactly:
 *   - `condition:` strings are evaluated by the ADAPTER against StepResults
 *     (same evaluateCondition as the linear engine); a false condition skips
 *     the step and the chain continues — unlike a graph edge predicate, which
 *     would deactivate everything downstream. The compiled node "succeeds"
 *     with a skipped StepResult as its output.
 *   - `{{prev}}` / `{{steps.<id>.<field>}}` render against StepResults; after
 *     a fan-out block, `{{prev}}` is the block's last member in source order
 *     (the synthetic join's output array preserves edge = source order).
 *   - `retry:` lifts onto the graph node, so the AL2.3 retry semantics run in
 *     the graph engine — the adapter never double-retries.
 *   - `parallel_group:` / `phase:` blocks become fan-out arms joined by a
 *     synthetic barrier merge node (`join-<label>`).
 *   - `approval: true` becomes a `gate` node. Graph runs cannot pause until
 *     AL4.2 durable state lands, so a gate without an approving callback
 *     fails honestly instead of silently proceeding.
 */

import type {
  StepResult,
  ToolStepExecutor,
  ToolStepResult,
  Workflow,
  WorkflowStep,
} from './types.js';
import type { WorkflowGraph, GraphNode, GraphEdge } from './graph-types.js';
import type { GraphNodeExecutor, GraphRunOptions, NodeInput } from './graph-run-types.js';
import {
  assertRenderedCommandSafe,
  evaluateCondition,
  execShell,
  renderTemplate,
} from './executor.js';

// ---------------------------------------------------------------------------
// Compilation — linear Workflow → WorkflowGraph
// ---------------------------------------------------------------------------

/** Sanitize a fan-out label into the node-id charset. */
function sanitizeLabel(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'block';
}

/**
 * Compile a validated linear Workflow into a WorkflowGraph: solo steps chain
 * sequentially; consecutive same-label parallel_group/phase members fan out
 * from the previous anchor and re-join at a synthetic barrier merge.
 */
export function compileWorkflowToGraph(workflow: Workflow): WorkflowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const usedIds = new Set(workflow.steps.map((s) => s.id));

  const uniqueJoinId = (label: string): string => {
    const base = `join-${sanitizeLabel(label)}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };

  const stepNode = (step: WorkflowStep): GraphNode => ({
    id: step.id,
    kind: step.approval ? 'gate' : 'tool',
    config: { step },
    ...(step.retry !== undefined ? { retry: step.retry } : {}),
  });

  let anchor: string | null = null;
  let i = 0;
  while (i < workflow.steps.length) {
    const first = workflow.steps[i]!;
    const blockLabel = first.phase ?? first.parallel_group;

    if (blockLabel !== undefined) {
      const key: 'phase' | 'parallel_group' = first.phase !== undefined ? 'phase' : 'parallel_group';
      const members: WorkflowStep[] = [];
      let j = i;
      while (j < workflow.steps.length && workflow.steps[j]![key] === blockLabel) {
        members.push(workflow.steps[j]!);
        j++;
      }
      for (const m of members) {
        nodes.push(stepNode(m));
        if (anchor !== null) edges.push({ from: anchor, to: m.id });
      }
      const joinId = uniqueJoinId(blockLabel);
      nodes.push({ id: joinId, kind: 'merge' });
      for (const m of members) edges.push({ from: m.id, to: joinId });
      anchor = joinId;
      i = j;
      continue;
    }

    nodes.push(stepNode(first));
    if (anchor !== null) edges.push({ from: anchor, to: first.id });
    anchor = first.id;
    i++;
  }

  return { name: workflow.name, description: workflow.description, nodes, edges };
}

// ---------------------------------------------------------------------------
// Step-node executor adapter
// ---------------------------------------------------------------------------

export interface StepNodeExecutorOptions {
  /** Dispatches `type: 'tool'` steps — same seam as the linear engine. */
  toolExecutor?: ToolStepExecutor;
  /** Approval decision for compiled gate nodes. Absent/false = honest failure (no pause pre-AL4.2). */
  approvalCallback?: (step: WorkflowStep) => Promise<boolean>;
}

/**
 * Build the graph-executor seams for a compiled workflow. The returned
 * `completedSteps` map fills in settle order and is shared by templates and
 * conditions — read it after the run for per-step results.
 */
export function createStepNodeExecutors(options: StepNodeExecutorOptions = {}): {
  executors: GraphRunOptions['executors'];
  completedSteps: Map<string, StepResult>;
} {
  const byId = new Map<string, StepResult>();

  /** Template context: all recorded StepResults with the derived prev LAST. */
  const renderContext = (prev: StepResult | undefined): StepResult[] => {
    const arr = [...byId.values()].filter((r) => r !== prev);
    if (prev) arr.push(prev);
    return arr;
  };

  /** Derive linear-{{prev}} from graph inputs: a join delivers members in source order. */
  const prevOf = (inputs: NodeInput[]): StepResult | undefined => {
    const raw = inputs[0]?.output;
    if (Array.isArray(raw)) return raw[raw.length - 1] as StepResult | undefined;
    return raw as StepResult | undefined;
  };

  const executeStep = async (step: WorkflowStep, prev: StepResult | undefined): Promise<StepResult> => {
    const t0 = Date.now();
    const steps = renderContext(prev);

    if (step.type === 'tool') {
      if (!options.toolExecutor) {
        return {
          id: step.id,
          status: 'failure',
          stdout: '',
          stderr: 'tool-type step requires a tool executor; run this workflow via meta.run-workflow',
          exitCode: 1,
          durationMs: Date.now() - t0,
        };
      }
      const stdin = step.stdin !== undefined ? renderTemplate(step.stdin, steps).rendered : undefined;
      let outcome: ToolStepResult;
      try {
        outcome = await options.toolExecutor(step, stdin);
      } catch (err) {
        outcome = { success: false, stderr: err instanceof Error ? err.message : String(err) };
      }
      return {
        id: step.id,
        status: outcome.success ? 'success' : 'failure',
        stdout: outcome.stdout ?? '',
        stderr: outcome.stderr ?? '',
        exitCode: outcome.success ? 0 : 1,
        durationMs: Date.now() - t0,
      };
    }

    let renderedCommand = step.command;
    try {
      const cmdRender = renderTemplate(step.command, steps);
      renderedCommand = cmdRender.rendered;
      if (cmdRender.expanded) assertRenderedCommandSafe(step.id, renderedCommand);
    } catch (err) {
      return {
        id: step.id,
        status: 'failure',
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: Date.now() - t0,
      };
    }
    const stdin = step.stdin !== undefined ? renderTemplate(step.stdin, steps).rendered : undefined;
    const { stdout, stderr, exitCode } = await execShell(renderedCommand, stdin, step.timeout);
    return {
      id: step.id,
      status: exitCode === 0 ? 'success' : 'failure',
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - t0,
    };
  };

  const stepExecutor: GraphNodeExecutor = async (node, inputs) => {
    const step = node.config?.['step'] as WorkflowStep | undefined;
    if (!step) {
      return { success: false, error: `node "${node.id}" has no compiled step in config` };
    }
    const prev = prevOf(inputs);

    // Linear condition semantics: false → record a skipped StepResult and let
    // the chain continue (node "succeeds" carrying the skip as its output).
    if (step.condition !== undefined) {
      const inner: Record<string, StepResult> = {};
      for (const [id, r] of byId) inner[id] = r;
      if (!evaluateCondition(step.condition, { steps: inner })) {
        const skipped: StepResult = { id: step.id, status: 'skipped', durationMs: 0 };
        byId.set(step.id, skipped);
        return { success: true, output: skipped };
      }
    }

    if (step.approval) {
      const approved = options.approvalCallback ? await options.approvalCallback(step) : false;
      if (!approved) {
        return {
          success: false,
          error:
            `step "${step.id}" requires approval — graph runs cannot pause; ` +
            'supply approvalCallback (durable pause lands with AL4.2)',
        };
      }
    }

    const result = await executeStep(step, prev);
    byId.set(step.id, result);
    return {
      success: result.status === 'success',
      output: result,
      ...(result.status !== 'success' ? { error: result.stderr || `step "${step.id}" failed` } : {}),
    };
  };

  return {
    executors: { tool: stepExecutor, gate: stepExecutor },
    completedSteps: byId,
  };
}
