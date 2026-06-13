/**
 * @file plan-mode-tools.ts
 * @description Executable plan-mode tools (gap #18) —
 * `meta.enter-plan-mode` and `meta.exit-plan-mode`. The agent calls
 * these to drive `PlanModeStateMachine` while
 * `ToolRegistry._planModeGate` enforces the "writes blocked until
 * approval" invariant on every other dispatched tool.
 *
 * Delegation: the executors do NOT instantiate a state machine — they
 * delegate to the singleton injected via `setPlanModeStateMachine()`
 * from cli.ts at boot, the same pattern other meta tools follow with
 * `injectMetaToolDeps`.
 *
 * Both tools are in `ALWAYS_ALLOWED` (plan-mode-gate.ts), so they
 * remain callable even when the gate is otherwise blocking
 * destructive tools — without that, the agent could enter plan mode
 * but never present its plan or exit.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.plan-mode');

// ---------------------------------------------------------------------------
// Duck-typed singleton
// ---------------------------------------------------------------------------

/**
 * Minimal slice of PlanModeStateMachine this module touches. Kept as a
 * structural interface so tests don't have to instantiate the real
 * state machine (with its DATA_DIR persistence side-effect).
 */
export interface PlanModeStateMachineLike {
  enterPlanMode(title?: string): { id: string; title: string };
  submitForApproval(): { id: string; status: string } | null;
  approvePlan(): { id: string; status: string } | null;
  exitPlanMode(): { id: string } | null;
  getState(): string;
  isActive(): boolean;
}

let _stateMachine: PlanModeStateMachineLike | null = null;

/** Inject the state machine. Pass null to detach. */
export function setPlanModeStateMachine(sm: PlanModeStateMachineLike | null): void {
  _stateMachine = sm;
}

/** Test seam: retrieve the currently-injected SM. */
export function getInjectedStateMachine(): PlanModeStateMachineLike | null {
  return _stateMachine;
}

// ---------------------------------------------------------------------------
// meta.enter-plan-mode
// ---------------------------------------------------------------------------

export const enterPlanModeTool: ToolDefinition = {
  name: 'meta.enter-plan-mode',
  description:
    'Enter plan mode. The agent drafts a structured plan; all destructive tools ' +
    '(file writes, shell execution, network mutations) are blocked until the plan is approved. ' +
    'Use when the task is complex or irreversible. Call meta.exit-plan-mode to present the plan.',
  category: 'meta' as const,
  safety: 'readonly',
  requiresConfirmation: false,
  timeout: 5_000,
  parameters: {
    title: {
      type: 'string',
      description: 'Short title for the plan (e.g. "Refactor authentication module").',
    },
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const sm = _stateMachine;
    if (!sm) {
      return {
        success: false,
        output:
          'meta.enter-plan-mode: PlanModeStateMachine has not been injected. ' +
          'Set SUDO_PLAN_MODE=1 in the environment to enable plan mode wiring.',
      };
    }
    if (sm.isActive()) {
      return {
        success: false,
        output: `meta.enter-plan-mode: already in plan mode (state=${sm.getState()}). Use meta.exit-plan-mode first.`,
      };
    }
    const title = typeof params['title'] === 'string' ? (params['title'] as string) : 'Untitled Plan';
    try {
      const plan = sm.enterPlanMode(title);
      logger.info({ planId: plan.id }, 'plan mode entered via meta.enter-plan-mode');
      return {
        success: true,
        output:
          `Plan mode entered. Plan id: ${plan.id} ("${plan.title}").\n\n` +
          'While plan mode is active, ONLY read-only tools (search, read-file, list, web.search, etc.) will run; ' +
          'destructive tools return plan_mode_blocked. ' +
          'Investigate first, draft the plan, then call meta.exit-plan-mode to present it for approval.',
        data: { planId: plan.id, title: plan.title, state: sm.getState() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'meta.enter-plan-mode failed');
      return { success: false, output: `meta.enter-plan-mode: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// meta.exit-plan-mode
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// meta.plan-mode-status
// ---------------------------------------------------------------------------

export const planModeStatusTool: ToolDefinition = {
  name: 'meta.plan-mode-status',
  description:
    'Report the current plan-mode state. Always callable (in ALWAYS_ALLOWED), so the agent can ' +
    'check whether destructive tools will run before attempting one.',
  category: 'meta' as const,
  safety: 'readonly',
  requiresConfirmation: false,
  timeout: 1_000,
  parameters: {},

  async execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const sm = _stateMachine;
    if (!sm) {
      return {
        success: true,
        output: 'Plan mode: disabled (no state machine injected; SUDO_PLAN_MODE not set).',
        data: { state: 'disabled', active: false, gateInstalled: false },
      };
    }
    const state = sm.getState();
    const active = sm.isActive();
    return {
      success: true,
      output:
        `Plan mode state: ${state} (active=${active}). ` +
        (active ? 'Destructive tools are blocked until the plan is approved.' : 'Destructive tools run normally.'),
      data: { state, active, gateInstalled: true },
    };
  },
};

export const exitPlanModeTool: ToolDefinition = {
  name: 'meta.exit-plan-mode',
  description:
    'Exit plan mode. Pass `approved: true` to submit for approval and immediately approve ' +
    '(unblocks destructive tools so the agent can execute the plan). Pass `approved: false` ' +
    '(or omit) to cancel plan mode and return to normal state. Always include `plan` text — ' +
    'a markdown description of what will happen — so the operator can review the change.',
  category: 'meta' as const,
  safety: 'readonly',
  requiresConfirmation: false,
  timeout: 5_000,
  parameters: {
    plan: {
      type: 'string',
      required: true,
      description: 'Markdown description of the plan that will be executed (shown to the operator).',
    },
    approved: {
      type: 'boolean',
      description: 'True to approve immediately and unblock writes; false to cancel back to normal state.',
      default: false,
    },
  },

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const sm = _stateMachine;
    if (!sm) {
      return {
        success: false,
        output: 'meta.exit-plan-mode: PlanModeStateMachine has not been injected.',
      };
    }
    const planText = typeof params['plan'] === 'string' ? (params['plan'] as string).trim() : '';
    if (!planText) {
      return { success: false, output: 'meta.exit-plan-mode: `plan` is required (markdown).' };
    }
    const approved = params['approved'] === true;
    const initialState = sm.getState();
    try {
      if (approved) {
        // Drafting → approval → approved → executing (writes unblocked).
        // Track each transition and FAIL LOUD if any step refuses, so the
        // executor cannot report "unblocked" when the gate is still active
        // (verifier HIGH #2 — silent null-return would have left state at
        // plan_mode while telling the caller writes were unblocked).
        if (initialState === 'plan_mode') {
          const sub = sm.submitForApproval();
          if (sub === null || sm.getState() !== 'plan_approval') {
            return {
              success: false,
              output: `meta.exit-plan-mode: submitForApproval refused — state stuck at ${sm.getState()}`,
              data: { state: sm.getState(), approved: false },
            };
          }
        }
        if (sm.getState() === 'plan_approval') {
          const app = sm.approvePlan();
          if (app === null || sm.getState() !== 'executing') {
            return {
              success: false,
              output: `meta.exit-plan-mode: approvePlan refused — state stuck at ${sm.getState()}`,
              data: { state: sm.getState(), approved: false },
            };
          }
        }
        const finalState = sm.getState();
        if (finalState !== 'executing') {
          return {
            success: false,
            output: `meta.exit-plan-mode: expected final state 'executing', got '${finalState}'`,
            data: { state: finalState, approved: false },
          };
        }
        logger.info({ initialState, finalState }, 'plan approved via meta.exit-plan-mode');
        return {
          success: true,
          output:
            `Plan approved (state ${initialState} → ${finalState}). Destructive tools are now unblocked.\n\n` +
            `--- Plan ---\n${planText}`,
          data: { state: finalState, approved: true },
        };
      }
      // Not approved: exit straight back to normal, dropping the plan.
      const closed = sm.exitPlanMode();
      logger.info({ initialState, finalState: sm.getState(), closedPlanId: closed?.id }, 'plan cancelled via meta.exit-plan-mode');
      return {
        success: true,
        output:
          `Plan mode exited (state ${initialState} → ${sm.getState()}). The plan was NOT approved.\n\n` +
          `--- Draft plan (not executed) ---\n${planText}`,
        data: { state: sm.getState(), approved: false },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'meta.exit-plan-mode failed');
      return { success: false, output: `meta.exit-plan-mode: ${msg}` };
    }
  },
};
