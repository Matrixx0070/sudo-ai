/**
 * @file plan-mode-gate.ts
 * @description Plan-mode write-tool gate (gap #18) — Claude Code's
 * investigate-before-act invariant.
 *
 * The latent `PlanModeStateMachine` (plan-mode-v2.ts) already tracks
 * Normal → PlanMode → PlanApproval → Executing state with persistence
 * and ACP methods, and `loop.ts` instantiates it. What was missing was
 * the GATE — nothing actually blocks `coder.write-file` /
 * `system.exec` etc. while a plan is being drafted or awaiting
 * approval. This module supplies the read/destructive classifier and a
 * small `PlanModeGate` indirection that `ToolRegistry.execute()` calls
 * before dispatching.
 *
 * Classification order (`isReadOnlyTool`):
 *
 *   1. `ALWAYS_ALLOWED` — the plan-mode enter / exit primitives are
 *      always callable; otherwise the agent could enter plan mode but
 *      never present its plan.
 *   2. `definition.safety === 'readonly'` — the author's explicit
 *      declaration wins.
 *   3. `READONLY_NAME_PATTERNS` — a curated list of read-tool name
 *      prefixes that catches well-known read tools whose authors
 *      omitted the safety field.
 *   4. Anything else is treated as DESTRUCTIVE while plan mode is
 *      active. The conservative default is intentional: a v1 plan
 *      mode that let an undeclared `coder.write-file` through would
 *      defeat the gate.
 */

import type { ToolDefinition } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Tool names that are ALWAYS allowed in plan mode regardless of safety
 * field or name pattern. The plan-mode enter / exit / status primitives
 * MUST be here; otherwise the agent has no way to surface the plan it
 * just built.
 */
export const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  'meta.enter-plan-mode',
  'meta.exit-plan-mode',
  'meta.plan-mode-status',
  // Legacy schemas that PlanModeStateMachine registers.
  'plan_mode.enter',
  'plan_mode.exit',
]);

/**
 * Tool-name prefixes that are read-only by convention even when the
 * author omitted the explicit `safety` field. Each entry matches as a
 * literal prefix on the dot-namespaced tool name. Add with care: any
 * entry here is unblocked inside plan mode for every session.
 */
export const READONLY_NAME_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'coder.read-',
  'coder.list-',
  'coder.search-',
  'coder.find-',
  'coder.grep',
  'fs.read',
  'fs.list',
  'fs.stat',
  'system.exec-readonly',
  'web.search',
  'web.fetch',
  'memory.search',
  'memory.query',
  'memory.retrieve',
  'meta.search',
  'meta.memory-search',
  'meta.memory-query',
  'meta.health-check',
  'meta.cost-tracker',
  'meta.self-test',
] as const);

/**
 * Return true when the given tool can safely run inside plan mode.
 * Order: ALWAYS_ALLOWED → explicit `safety: 'readonly'` → name
 * allow-list. Everything else is treated as destructive (the
 * conservative default).
 */
export function isReadOnlyTool(name: string, definition?: ToolDefinition): boolean {
  if (ALWAYS_ALLOWED.has(name)) return true;
  if (definition?.safety === 'readonly') return true;
  for (const prefix of READONLY_NAME_PATTERNS) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PlanModeGate — the registry-side hook
// ---------------------------------------------------------------------------

/**
 * Minimal contract the registry needs to consult to enforce plan mode.
 * Both `isActive()` and `getStateLabel()` are duck-typed so the gate
 * can be tested without instantiating PlanModeStateMachine.
 */
export interface PlanModeGate {
  /**
   * Return true when the current plan-mode state should BLOCK
   * destructive tool calls. The state machine has four states; by
   * default plan_mode and plan_approval block writes (the drafting +
   * pending-approval phases), while normal and executing allow them
   * (executing means the user has approved the plan and the agent is
   * now carrying it out).
   */
  isActive(): boolean;
  /** Human-readable state label for the rejection message. */
  getStateLabel(): string;
}

/**
 * Convenience adapter wrapping a `PlanModeStateMachine`-shaped object
 * (only its `getState()` method is duck-typed) into a `PlanModeGate`.
 * Returns a gate whose `isActive()` flags only the drafting and
 * approval phases, not the `executing` phase (which IS plan mode but
 * the writes are now intended).
 */
export function gateFromStateMachine(sm: {
  getState(): 'normal' | 'plan_mode' | 'plan_approval' | 'executing';
}): PlanModeGate {
  return {
    isActive(): boolean {
      const s = sm.getState();
      return s === 'plan_mode' || s === 'plan_approval';
    },
    getStateLabel(): string {
      return sm.getState();
    },
  };
}
