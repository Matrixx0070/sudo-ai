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
} from './lobster.js';

export { loadWorkflow, runWorkflow } from './lobster.js';
