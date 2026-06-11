/**
 * @file plan-mode-v2.ts
 * @description Plan Mode v2 — Full state machine with enter/exit tools.
 * Grok Build CLI parity.
 *
 * State machine: Normal → PlanMode → PlanApproval → Execute
 *                or: PlanApproval → Reject → PlanMode (revise)
 *
 * Adds `enter_plan_mode` and `exit_plan_mode` as callable tools.
 * Persists plan.json and plan_mode.json for session recovery.
 * Provides ACP-compatible methods (xai/toggle_plan_mode, xai/exit_plan_mode).
 */

import { createLogger } from '../shared/logger.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('agent:plan-mode-v2');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanModeState = 'normal' | 'plan_mode' | 'plan_approval' | 'executing';
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export type PlanStatus = 'draft' | 'approved' | 'executing' | 'completed' | 'rejected';

export interface PlanStep {
  id: number;
  description: string;
  files?: string[];
  status: PlanStepStatus;
}

export interface PlanV2 {
  id: string;
  title: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: string;
  /** Rejection reason if the plan was rejected (user can request revision). */
  rejectionReason?: string;
}

export interface PlanModeStateDoc {
  /** Current state in the state machine. */
  state: PlanModeState;
  /** ID of the active plan (null when state is 'normal'). */
  activePlanId: string | null;
  /** Timestamp of last state transition. */
  lastTransitionAt: string;
}

// ---------------------------------------------------------------------------
// State transitions (valid edges only)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<PlanModeState, PlanModeState[]> = {
  normal:        ['plan_mode'],
  plan_mode:     ['plan_approval', 'normal'],
  plan_approval: ['executing', 'plan_mode', 'normal'],
  executing:     ['normal', 'plan_approval'], // can re-enter approval if plan needs revision
};

// ---------------------------------------------------------------------------
// PlanModeStateMachine
// ---------------------------------------------------------------------------

/**
 * Full plan mode state machine with persistence.
 *
 * Grok Build CLI implements:
 *   - enter_plan_mode tool
 *   - exit_plan_mode tool
 *   - ACP methods: xai/toggle_plan_mode, xai/exit_plan_mode
 *   - plan.json + plan_mode.json persistence
 *   - Approval workflow with reject → revise cycle
 */
export class PlanModeStateMachine {
  private state: PlanModeState = 'normal';
  private activePlan: PlanV2 | null = null;
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? DATA_DIR;
    mkdirSync(this.dataDir, { recursive: true });

    // Restore from persisted state if available
    this._restore();
    log.info({ state: this.state }, 'PlanModeStateMachine initialised');
  }

  // -------------------------------------------------------------------------
  // State machine transitions
  // -------------------------------------------------------------------------

  /** Enter plan mode — transitions from Normal → PlanMode. */
  enterPlanMode(title?: string): PlanV2 {
    this._transition('plan_mode');

    this.activePlan = {
      id: `plan-${Date.now()}`,
      title: title?.trim() || 'Untitled Plan',
      steps: [],
      status: 'draft',
      createdAt: new Date().toISOString(),
    };

    this._persist();
    log.info({ planId: this.activePlan.id, title: this.activePlan.title }, 'Entered plan mode');
    return this.activePlan;
  }

  /** Add a step to the active plan. */
  addStep(description: string, files?: string[]): PlanStep | null {
    if (!this.activePlan || this.state !== 'plan_mode') {
      log.warn('addStep: not in plan mode — step discarded');
      return null;
    }

    const step: PlanStep = {
      id: this.activePlan.steps.length + 1,
      description: description.trim(),
      files,
      status: 'pending',
    };
    this.activePlan.steps.push(step);
    this._persist();
    return step;
  }

  /** Submit plan for approval — transitions PlanMode → PlanApproval. */
  submitForApproval(): PlanV2 | null {
    if (!this.activePlan || this.state !== 'plan_mode') {
      log.warn('submitForApproval: not in plan mode');
      return null;
    }

    this._transition('plan_approval');
    this.activePlan.status = 'approved'; // pending user approval, status reflects readiness
    this._persist();
    log.info({ planId: this.activePlan.id, steps: this.activePlan.steps.length }, 'Plan submitted for approval');
    return this.activePlan;
  }

  /** Approve the plan — transitions PlanApproval → Executing. */
  approvePlan(): PlanV2 | null {
    if (!this.activePlan || this.state !== 'plan_approval') {
      log.warn('approvePlan: not in plan_approval state');
      return null;
    }

    this._transition('executing');
    this.activePlan.status = 'executing';
    this._persist();
    log.info({ planId: this.activePlan.id }, 'Plan approved — execution starting');
    return this.activePlan;
  }

  /** Reject the plan — transitions PlanApproval → PlanMode (revise). */
  rejectPlan(reason?: string): PlanV2 | null {
    if (!this.activePlan || this.state !== 'plan_approval') {
      log.warn('rejectPlan: not in plan_approval state');
      return null;
    }

    this._transition('plan_mode');
    this.activePlan.status = 'rejected';
    this.activePlan.rejectionReason = reason?.trim() || 'No reason provided';
    this._persist();
    log.info({ planId: this.activePlan.id, reason }, 'Plan rejected — revising');
    return this.activePlan;
  }

  /** Exit plan mode — transitions any state → Normal. */
  exitPlanMode(): PlanV2 | null {
    const plan = this.activePlan;
    this._transition('normal');

    if (plan) {
      if (plan.status === 'executing') {
        plan.status = 'completed';
      }
    }

    this.activePlan = null;
    this._persist();
    log.info('Exited plan mode');
    return plan;
  }

  /** Update a step's status. */
  updateStepStatus(stepId: number, status: PlanStepStatus): void {
    if (!this.activePlan) return;
    const step = this.activePlan.steps.find(s => s.id === stepId);
    if (step) {
      step.status = status;
      this._persist();
      log.debug({ stepId, status }, 'Step status updated');
    }
  }

  // -------------------------------------------------------------------------
  // ACP-compatible methods (Grok parity: xai/toggle_plan_mode, xai/exit_plan_mode)
  // -------------------------------------------------------------------------

  /** Toggle plan mode on/off (ACP: xai/toggle_plan_mode). */
  togglePlanMode(title?: string): { active: boolean; plan: PlanV2 | null } {
    if (this.state === 'normal') {
      const plan = this.enterPlanMode(title);
      return { active: true, plan };
    } else {
      const plan = this.exitPlanMode();
      return { active: false, plan };
    }
  }

  /** Force exit plan mode regardless of state (ACP: xai/exit_plan_mode). */
  forceExitPlanMode(): PlanV2 | null {
    return this.exitPlanMode();
  }

  // -------------------------------------------------------------------------
  // Public getters
  // -------------------------------------------------------------------------

  /** Current state machine state. */
  getState(): PlanModeState {
    return this.state;
  }

  /** Whether plan mode is currently active. */
  isActive(): boolean {
    return this.state !== 'normal';
  }

  /** Whether the plan is awaiting user approval. */
  isAwaitingApproval(): boolean {
    return this.state === 'plan_approval';
  }

  /** Get the active plan (null if no plan). */
  getActivePlan(): PlanV2 | null {
    return this.activePlan;
  }

  /** Get the current state document (for serialization/ACP). */
  getStateDocument(): PlanModeStateDoc {
    return {
      state: this.state,
      activePlanId: this.activePlan?.id ?? null,
      lastTransitionAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Tool definitions (for registration with ToolRegistry)
  // -------------------------------------------------------------------------

  /** Tool definition for `enter_plan_mode`. */
  static getEnterPlanModeTool() {
    return {
      name: 'plan_mode.enter',
      description: 'Enter plan mode to draft a structured plan before taking action. Use for complex or irreversible tasks.',
      parameters: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string' as const,
            description: 'Short title for the plan (e.g., "Refactor authentication system")',
          },
          steps: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                description: { type: 'string' as const, description: 'What this step does' },
                files: { type: 'array' as const, items: { type: 'string' as const }, description: 'Files this step will modify' },
              },
              required: ['description'] as const,
            },
            description: 'Planned steps for the plan',
          },
        },
        required: ['title'] as const,
      },
    };
  }

  /** Tool definition for `exit_plan_mode`. */
  static getExitPlanModeTool() {
    return {
      name: 'plan_mode.exit',
      description: 'Exit plan mode. If a plan was being drafted, it is finalized. If awaiting approval, the plan is cancelled.',
      parameters: {
        type: 'object' as const,
        properties: {
          approved: {
            type: 'boolean' as const,
            description: 'Whether to approve the plan (if in approval state). Default: false (cancel).',
          },
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _transition(newState: PlanModeState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(newState)) {
      throw new Error(
        `PlanModeStateMachine: invalid transition ${this.state} → ${newState}. Allowed: ${allowed.join(', ')}`,
      );
    }
    const oldState = this.state;
    this.state = newState;
    log.info({ from: oldState, to: newState }, 'State transition');
  }

  private _persist(): void {
    try {
      // Persist plan_mode.json
      const stateDoc = this.getStateDocument();
      const statePath = path.join(this.dataDir, 'plan_mode.json');
      writeFileSync(statePath, JSON.stringify(stateDoc, null, 2), 'utf-8');

      // Persist plan.json (or remove it when there is no active plan, so a
      // stale plan.json cannot be re-loaded after exiting to 'normal').
      const planPath = path.join(this.dataDir, 'plan.json');
      if (this.activePlan) {
        writeFileSync(planPath, JSON.stringify(this.activePlan, null, 2), 'utf-8');
      } else if (existsSync(planPath)) {
        rmSync(planPath);
      }
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to persist plan mode state');
    }
  }

  private _restore(): void {
    try {
      const statePath = path.join(this.dataDir, 'plan_mode.json');
      if (existsSync(statePath)) {
        const raw = readFileSync(statePath, 'utf-8');
        const doc = JSON.parse(raw) as PlanModeStateDoc;
        this.state = doc.state;
        log.info({ restoredState: doc.state }, 'Restored plan mode state from disk');
      }

      const planPath = path.join(this.dataDir, 'plan.json');
      if (existsSync(planPath)) {
        const raw = readFileSync(planPath, 'utf-8');
        this.activePlan = JSON.parse(raw) as PlanV2;
        log.info({ planId: this.activePlan?.id }, 'Restored active plan from disk');
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to restore plan mode state — starting fresh');
      this.state = 'normal';
      this.activePlan = null;
    }
  }
}