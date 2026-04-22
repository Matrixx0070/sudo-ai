/**
 * Plan Mode — structured pre-execution planning for the agent.
 *
 * When plan mode is active the agent drafts a numbered step list before taking
 * any action. The plan must be approved (or auto-approved) before execution
 * can begin. This prevents impulsive irreversible actions on complex tasks.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:plan-mode');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a single plan step. */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/** A single actionable step within a Plan. */
export interface PlanStep {
  /** 1-based sequential step number. */
  id: number;
  /** Human-readable description of what this step does. */
  description: string;
  /** Optional list of file paths this step will touch. */
  files?: string[];
  /** Current lifecycle status of this step. */
  status: PlanStepStatus;
}

/** Overall lifecycle status of a Plan. */
export type PlanStatus = 'draft' | 'approved' | 'executing' | 'completed';

/** A structured multi-step plan created in plan mode. */
export interface Plan {
  /** Unique plan identifier in the form "plan-<timestamp>". */
  id: string;
  /** Short human-readable plan title. */
  title: string;
  /** Ordered list of planned steps. */
  steps: PlanStep[];
  /** Current lifecycle status. */
  status: PlanStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let activePlan: Plan | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enter plan mode with a new draft plan.
 * Any previously active plan is discarded.
 *
 * @param title - Short descriptive title for the plan.
 * @returns The newly created draft Plan.
 */
export function enterPlanMode(title: string): Plan {
  if (!title || typeof title !== 'string') {
    log.warn({ title }, 'enterPlanMode: invalid title — using fallback');
  }

  activePlan = {
    id: `plan-${Date.now()}`,
    title: title?.trim() || 'Untitled Plan',
    steps: [],
    status: 'draft',
    createdAt: new Date().toISOString(),
  };

  log.info({ id: activePlan.id, title: activePlan.title }, 'Plan mode entered');
  return activePlan;
}

/**
 * Add a step to the active draft plan.
 * No-ops silently when no plan is active.
 *
 * @param description - What this step does.
 * @param files       - Optional file paths that will be touched.
 */
export function addStep(description: string, files?: string[]): void {
  if (!activePlan) {
    log.warn('addStep: no active plan — step discarded');
    return;
  }
  if (!description || typeof description !== 'string') {
    log.warn('addStep: invalid description — step skipped');
    return;
  }

  const step: PlanStep = {
    id: activePlan.steps.length + 1,
    description: description.trim(),
    files,
    status: 'pending',
  };

  activePlan.steps.push(step);
  log.debug({ stepId: step.id, description: step.description }, 'Step added to plan');
}

/**
 * Approve the active plan, advancing its status from 'draft' to 'approved'.
 * Returns null when no plan is active.
 */
export function approvePlan(): Plan | null {
  if (!activePlan) {
    log.warn('approvePlan: no active plan');
    return null;
  }
  activePlan.status = 'approved';
  log.info({ id: activePlan.id, stepCount: activePlan.steps.length }, 'Plan approved');
  return activePlan;
}

/**
 * Exit plan mode and return the completed plan record.
 * Clears the active plan so a fresh one can be created later.
 *
 * @returns The plan that was active, or null if no plan was active.
 */
export function exitPlanMode(): Plan | null {
  const plan = activePlan;
  activePlan = null;

  if (plan) {
    log.info({ id: plan.id }, 'Plan mode exited');
  } else {
    log.debug('exitPlanMode: no active plan to exit');
  }

  return plan;
}

/**
 * Return the currently active plan, or null when plan mode is inactive.
 */
export function getActivePlan(): Plan | null {
  return activePlan;
}

/**
 * Return true when a plan is active and still in draft status
 * (i.e. awaiting approval before execution).
 */
export function isInPlanMode(): boolean {
  return activePlan !== null && activePlan.status === 'draft';
}

log.debug('plan-mode module loaded');
