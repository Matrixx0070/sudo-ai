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
  /** UUID for resuming a paused workflow. */
  resumeToken?: string;
}

export interface RunOptions {
  /** Supply to resume execution after an approval gate was unblocked. */
  resumeState?: WorkflowRunState;
  /**
   * Called when a step has `approval: true`.
   * Return `true` to continue immediately; `false` to pause and save state.
   */
  approvalCallback?: (step: WorkflowStep, runState: WorkflowRunState) => Promise<boolean>;
}
