/**
 * @file workflows/types.ts
 * @description Shared type definitions for the Lobster workflow engine.
 */

export interface WorkflowStep {
  id: string;
  /** Shell command or tool name. */
  command: string;
  /** Execution mode — defaults to 'shell'. */
  type?: 'shell' | 'tool';
  /** Static stdin value, or '{{prev}}' to pipe from the previous step's stdout. */
  stdin?: string;
  /** If true, the engine pauses here and emits a resumeToken. */
  approval?: boolean;
  /**
   * Simple guard expression evaluated against completed step results.
   * Supported operators: `===`, `!==`, `&&`, `||`.
   * Supported atoms: `steps.<id>.<field>`, number literals, boolean literals,
   * quoted strings.
   * Example: `"steps.check-disk.exitCode === 0"`
   */
  condition?: string;
  /** Execution timeout in milliseconds — process is killed on expiry. */
  timeout?: number;
}

export interface Workflow {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export interface StepResult {
  id: string;
  status: 'success' | 'failure' | 'skipped' | 'awaiting_approval';
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs: number;
}

export interface WorkflowRunState {
  workflowName: string;
  startedAt: string;
  completedSteps: StepResult[];
  /** Set when the engine pauses on an approval gate. */
  pendingStepIndex?: number;
  /**
   * Step id the engine paused on. Carried alongside pendingStepIndex so a
   * resumer can identify the approved step by id (stable) rather than by
   * index (which shifts if the workflow file is edited between pause and resume).
   */
  pendingStepId?: string;
  /** UUID for resuming a paused workflow. */
  resumeToken?: string;
}

/** Outcome returned by a {@link ToolStepExecutor} for a `type: 'tool'` step. */
export interface ToolStepResult {
  /** Whether the dispatched tool reported success. */
  success: boolean;
  /** Model-facing text output; becomes the step's stdout so `{{prev}}` threading works. */
  stdout?: string;
  /** Error detail on failure; becomes the step's stderr. */
  stderr?: string;
}

/**
 * Executes a `type: 'tool'` step by dispatching `step.command` (a host tool
 * name) to the tool registry. Supplied by the caller (meta.run-workflow) so the
 * engine stays decoupled from the ToolRegistry. When absent, tool steps fail
 * HONESTLY rather than silently succeeding.
 *
 * @param step          - The tool step (`step.command` is the tool name).
 * @param resolvedStdin - The step's stdin after `{{prev}}` resolution, or undefined.
 */
export type ToolStepExecutor = (
  step: WorkflowStep,
  resolvedStdin: string | undefined,
) => Promise<ToolStepResult>;

export interface RunOptions {
  /** Supply to resume execution after an approval gate was unblocked. */
  resumeState?: WorkflowRunState;
  /**
   * Called when a step has `approval: true`.
   * Return `true` to continue immediately; `false` to pause and save state.
   */
  approvalCallback?: (step: WorkflowStep, runState: WorkflowRunState) => Promise<boolean>;
  /**
   * Dispatches `type: 'tool'` steps to the host tool registry. When omitted,
   * tool steps record an honest failure instead of executing.
   */
  toolExecutor?: ToolStepExecutor;
}
