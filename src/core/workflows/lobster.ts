/**
 * @file workflows/lobster.ts
 * @description Lobster-style deterministic workflow engine for SUDO-AI.
 *
 * Pipelines are defined in YAML files (.lobster.yaml). Steps run sequentially;
 * stdout is threaded between steps via `stdin: '{{prev}}'`; approval gates
 * can pause execution and return a resumeToken for out-of-band continuation.
 *
 * Re-exports all public types from ./types.ts so consumers only need to import
 * from this single entry point.
 */

import { readFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'node:path';
import { parseYaml } from './yaml-parser.js';
import { validateWorkflow, evaluateCondition, execShell } from './executor.js';
import type { AccessorMap } from './executor.js';
import { createLogger } from '../shared/logger.js';
import { WORKSPACE_DIR } from '../shared/paths.js';

const log = createLogger('workflows');

// ---------------------------------------------------------------------------
// Path confinement — workflows must live under WORKFLOWS_BASE
// ---------------------------------------------------------------------------

const WORKFLOWS_BASE = path.join(WORKSPACE_DIR, 'workflows');

/**
 * Resolve a step's stdin, expanding the `{{prev}}` placeholder to the previous
 * completed step's stdout. Shared by shell and tool step execution.
 */
function resolveStdin(step: WorkflowStep, completedSteps: StepResult[]): string | undefined {
  if (step.stdin === '{{prev}}') {
    const prev = completedSteps[completedSteps.length - 1];
    return prev?.stdout ?? '';
  }
  return step.stdin;
}

// ---------------------------------------------------------------------------
// Re-export all public types so downstream consumers only import from here
// ---------------------------------------------------------------------------

export type {
  WorkflowStep,
  Workflow,
  StepResult,
  WorkflowRunState,
  RunOptions,
  ToolStepResult,
  ToolStepExecutor,
} from './types.js';

import type {
  WorkflowStep,
  Workflow,
  StepResult,
  WorkflowRunState,
  RunOptions,
  ToolStepResult,
} from './types.js';

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

/**
 * Load and parse a workflow YAML file.
 *
 * @param filePath - Path to the .lobster.yaml file.
 * @param options  - Optional overrides. `basePath` is ONLY for tests.
 * @returns Parsed and validated Workflow object.
 * @throws On file read errors, YAML parse failures, or validation violations.
 */
export async function loadWorkflow(
  filePath: string,
  options?: { basePath?: string },
): Promise<Workflow> {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('loadWorkflow: filePath must be a non-empty string');
  }

  // Enforce path confinement — resolved path must be inside the base directory
  const base = options?.basePath !== undefined
    ? path.resolve(options.basePath)
    : WORKFLOWS_BASE;
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(
      `loadWorkflow: path "${filePath}" is outside the allowed base directory`,
    );
  }

  if (!resolved.endsWith('.yaml')) {
    throw new Error(
      `loadWorkflow: file "${filePath}" must have a .yaml or .lobster.yaml extension`,
    );
  }

  log.info({ filePath }, 'Loading workflow');

  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`loadWorkflow: cannot read file "${filePath}": ${String(err)}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new Error(`loadWorkflow: YAML parse error in "${filePath}": ${String(err)}`);
  }

  const workflow: Workflow = {
    name: String(raw['name'] ?? ''),
    description: raw['description'] !== undefined ? String(raw['description']) : undefined,
    steps: [],
  };

  const rawSteps = raw['steps'];
  if (Array.isArray(rawSteps)) {
    for (const s of rawSteps) {
      const rs = s as Record<string, unknown>;
      const step: WorkflowStep = {
        id: String(rs['id'] ?? ''),
        command: String(rs['command'] ?? ''),
        type: (rs['type'] as 'shell' | 'tool' | undefined) ?? 'shell',
        stdin: rs['stdin'] !== undefined ? String(rs['stdin']) : undefined,
        approval: rs['approval'] === true || rs['approval'] === 'true',
        condition: rs['condition'] !== undefined ? String(rs['condition']) : undefined,
        timeout: rs['timeout'] !== undefined ? Number(rs['timeout']) : undefined,
      };
      workflow.steps.push(step);
    }
  }

  validateWorkflow(workflow);

  log.info({ workflowName: workflow.name, stepCount: workflow.steps.length }, 'Workflow loaded');
  return workflow;
}

// ---------------------------------------------------------------------------
// runWorkflow
// ---------------------------------------------------------------------------

/**
 * Execute a workflow sequentially, optionally resuming from a saved state.
 *
 * Steps are executed in order. On a failing step (non-zero exit code) the
 * engine halts and returns the current state. On an approval gate the engine
 * either invokes `approvalCallback` or pauses immediately, returning a state
 * with `resumeToken` and `pendingStepIndex` set.
 *
 * @param workflow - Parsed Workflow object.
 * @param options  - Optional resume state and approval callback.
 * @returns Final WorkflowRunState capturing all step results.
 */
export async function runWorkflow(
  workflow: Workflow,
  options: RunOptions = {},
): Promise<WorkflowRunState> {
  const { resumeState, approvalCallback, toolExecutor } = options;

  const runState: WorkflowRunState = resumeState
    ? {
        ...resumeState,
        // Drop the awaiting_approval placeholder recorded at pause time so the
        // resumed step re-executes cleanly: {{prev}} then resolves to the last
        // genuinely-completed step (not the stdout-less approval entry) and no
        // duplicate StepResult is appended for the resumed step.
        completedSteps: resumeState.completedSteps.filter((s) => s.status !== 'awaiting_approval'),
        pendingStepIndex: undefined,
        pendingStepId: undefined,
        resumeToken: undefined,
      }
    : {
        workflowName: workflow.name,
        startedAt: new Date().toISOString(),
        completedSteps: [],
      };

  const startIndex = resumeState?.pendingStepIndex ?? 0;

  /** Build the accessor map used by the condition evaluator. */
  function buildStepsMap(): AccessorMap {
    const inner: Record<string, StepResult> = {};
    for (const r of runState.completedSteps) {
      inner[r.id] = r;
    }
    return { steps: inner };
  }

  log.info(
    { workflowName: workflow.name, startIndex, stepCount: workflow.steps.length },
    'Running workflow',
  );

  for (let i = startIndex; i < workflow.steps.length; i++) {
    const step = workflow.steps[i] as WorkflowStep;

    // ------------------------------------------------------------------
    // Condition gate — skip step if expression is false
    // ------------------------------------------------------------------
    if (step.condition) {
      const pass = evaluateCondition(step.condition, buildStepsMap());
      if (!pass) {
        log.info({ stepId: step.id, condition: step.condition }, 'Step skipped (condition false)');
        runState.completedSteps.push({ id: step.id, status: 'skipped', durationMs: 0 });
        continue;
      }
    }

    // ------------------------------------------------------------------
    // Approval gate
    // ------------------------------------------------------------------
    if (step.approval) {
      log.info({ stepId: step.id }, 'Step requires approval');

      let approved = false;
      if (approvalCallback) {
        approved = await approvalCallback(step, runState);
      }

      if (!approved) {
        const token = randomUUID();
        runState.pendingStepIndex = i;
        runState.pendingStepId = step.id;
        runState.resumeToken = token;
        runState.completedSteps.push({ id: step.id, status: 'awaiting_approval', durationMs: 0 });
        log.info({ stepId: step.id, resumeToken: token }, 'Workflow paused — awaiting approval');
        return runState;
      }

      log.info({ stepId: step.id }, 'Approval granted — continuing');
    }

    // ------------------------------------------------------------------
    // Execute step
    // ------------------------------------------------------------------
    const t0 = Date.now();

    if (step.type === 'tool') {
      // Tool steps dispatch through the host registry via the injected
      // toolExecutor. Without one the step fails HONESTLY — never a silent
      // fake success (the engine has no tool access on its own).
      if (!toolExecutor) {
        runState.completedSteps.push({
          id: step.id,
          status: 'failure',
          stdout: '',
          stderr: 'tool-type step requires a tool executor; run this workflow via meta.run-workflow',
          exitCode: 1,
          durationMs: Date.now() - t0,
        });
        log.warn({ stepId: step.id }, 'Tool step with no executor — failing honestly');
        break;
      }

      const toolStdin = resolveStdin(step, runState.completedSteps);
      let outcome: ToolStepResult;
      try {
        outcome = await toolExecutor(step, toolStdin);
      } catch (err) {
        outcome = { success: false, stderr: err instanceof Error ? err.message : String(err) };
      }

      const toolResult: StepResult = {
        id: step.id,
        status: outcome.success ? 'success' : 'failure',
        stdout: outcome.stdout ?? '',
        stderr: outcome.stderr ?? '',
        exitCode: outcome.success ? 0 : 1,
        durationMs: Date.now() - t0,
      };
      log.info({ stepId: step.id, status: toolResult.status }, 'Tool step completed');
      runState.completedSteps.push(toolResult);

      if (toolResult.status === 'failure') {
        log.warn({ stepId: step.id }, 'Tool step failed — halting workflow');
        break;
      }
      continue;
    }

    // Resolve stdin piping
    const stdinData = resolveStdin(step, runState.completedSteps);

    log.info({ stepId: step.id, command: step.command }, 'Executing step');

    const { stdout, stderr, exitCode } = await execShell(step.command, stdinData, step.timeout);
    const durationMs = Date.now() - t0;

    const result: StepResult = {
      id: step.id,
      status: exitCode === 0 ? 'success' : 'failure',
      stdout,
      stderr,
      exitCode,
      durationMs,
    };

    log.info({ stepId: step.id, status: result.status, exitCode, durationMs }, 'Step completed');
    runState.completedSteps.push(result);

    if (result.status === 'failure') {
      log.warn({ stepId: step.id, exitCode }, 'Step failed — halting workflow');
      break;
    }
  }

  return runState;
}
