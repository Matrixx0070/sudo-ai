/**
 * Plan-mode write-gate (gap #18) — read-only classifier, the
 * `PlanModeGate` adapter, the `ToolRegistry` integration that throws
 * `plan_mode_blocked`, and the `meta.enter-plan-mode` /
 * `meta.exit-plan-mode` executors. All tests are hermetic — no disk
 * persistence, no real PlanModeStateMachine instance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isReadOnlyTool,
  ALWAYS_ALLOWED,
  READONLY_NAME_PATTERNS,
  gateFromStateMachine,
  type PlanModeGate,
} from '../../src/core/agent/plan-mode-gate.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { ToolError } from '../../src/core/shared/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../src/core/tools/types.js';
import {
  enterPlanModeTool,
  exitPlanModeTool,
  planModeStatusTool,
  setPlanModeStateMachine,
  type PlanModeStateMachineLike,
} from '../../src/core/tools/builtin/meta/plan-mode-tools.js';

function ctx(): ToolContext {
  return { sessionId: 's-1', workingDir: '/tmp', config: {}, logger: {} };
}

function makeTool(name: string, opts: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: name,
    category: 'meta' as const,
    requiresConfirmation: false,
    timeout: 5_000,
    parameters: {},
    async execute(): Promise<ToolResult> {
      return { success: true, output: `ran ${name}`, data: {} };
    },
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// isReadOnlyTool classifier
// ---------------------------------------------------------------------------

describe('isReadOnlyTool', () => {
  it('always allows the plan-mode primitives', () => {
    expect(isReadOnlyTool('meta.enter-plan-mode')).toBe(true);
    expect(isReadOnlyTool('meta.exit-plan-mode')).toBe(true);
    expect(isReadOnlyTool('meta.plan-mode-status')).toBe(true);
    expect(isReadOnlyTool('plan_mode.enter')).toBe(true);
    expect(isReadOnlyTool('plan_mode.exit')).toBe(true);
  });

  it('honours explicit safety: readonly even when the name pattern is unknown', () => {
    expect(isReadOnlyTool('weirdo.thing', makeTool('weirdo.thing', { safety: 'readonly' }))).toBe(true);
  });

  it('matches the well-known read-tool name prefixes', () => {
    expect(isReadOnlyTool('coder.read-file')).toBe(true);
    expect(isReadOnlyTool('coder.search-codebase')).toBe(true);
    expect(isReadOnlyTool('coder.grep')).toBe(true);
    expect(isReadOnlyTool('fs.read')).toBe(true);
    expect(isReadOnlyTool('web.search')).toBe(true);
    expect(isReadOnlyTool('memory.query')).toBe(true);
    expect(isReadOnlyTool('meta.cost-tracker')).toBe(true);
  });

  it('defaults to destructive when nothing matches (conservative)', () => {
    expect(isReadOnlyTool('coder.write-file')).toBe(false);
    expect(isReadOnlyTool('system.exec')).toBe(false);
    expect(isReadOnlyTool('totally.unknown', makeTool('totally.unknown', { safety: 'destructive' }))).toBe(false);
    expect(isReadOnlyTool('totally.unknown')).toBe(false);
  });

  it('exposes the constant sets so downstream UX can show them', () => {
    expect(ALWAYS_ALLOWED.size).toBeGreaterThanOrEqual(3);
    expect(READONLY_NAME_PATTERNS).toContain('coder.read-');
    expect(Object.isFrozen(READONLY_NAME_PATTERNS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gateFromStateMachine adapter
// ---------------------------------------------------------------------------

describe('gateFromStateMachine', () => {
  it('isActive() flags plan_mode and plan_approval only (not normal or executing)', () => {
    const states = ['normal', 'plan_mode', 'plan_approval', 'executing'] as const;
    const expected = { normal: false, plan_mode: true, plan_approval: true, executing: false };
    for (const s of states) {
      const gate = gateFromStateMachine({ getState: () => s });
      expect(gate.isActive()).toBe(expected[s]);
      expect(gate.getStateLabel()).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry integration
// ---------------------------------------------------------------------------

describe('ToolRegistry plan-mode integration', () => {
  let registry: ToolRegistry;
  let gateState: 'off' | 'plan_mode' | 'executing';

  function makeGate(): PlanModeGate {
    return {
      isActive() { return gateState === 'plan_mode'; },
      getStateLabel() { return gateState; },
    };
  }

  beforeEach(() => {
    registry = new ToolRegistry();
    gateState = 'off';
    registry.register(makeTool('coder.read-file', { safety: 'readonly' }));
    registry.register(makeTool('coder.write-file', { safety: 'destructive' }));
    registry.register(makeTool('system.exec', { safety: 'destructive' }));
    registry.register(makeTool('meta.enter-plan-mode'));
    registry.register(makeTool('meta.exit-plan-mode'));
    registry.setPlanModeGate(makeGate());
  });

  it('passes read-only tools through when the gate is active', async () => {
    gateState = 'plan_mode';
    const r = await registry.execute('coder.read-file', {}, ctx());
    expect(r.success).toBe(true);
  });

  it('rejects destructive tools with plan_mode_blocked when the gate is active', async () => {
    gateState = 'plan_mode';
    await expect(registry.execute('coder.write-file', {}, ctx())).rejects.toMatchObject({
      code: 'tool_plan_mode_blocked',
    });
    await expect(registry.execute('system.exec', { command: 'echo hi' }, ctx())).rejects.toMatchObject({
      code: 'tool_plan_mode_blocked',
    });
  });

  it('always allows the plan-mode enter/exit primitives even when the gate is active', async () => {
    gateState = 'plan_mode';
    await expect(registry.execute('meta.enter-plan-mode', {}, ctx())).resolves.toMatchObject({ success: true });
    await expect(registry.execute('meta.exit-plan-mode', {}, ctx())).resolves.toMatchObject({ success: true });
  });

  it('allows destructive tools when the gate is inactive (off / executing)', async () => {
    gateState = 'off';
    await expect(registry.execute('coder.write-file', {}, ctx())).resolves.toMatchObject({ success: true });
    gateState = 'executing';
    await expect(registry.execute('system.exec', {}, ctx())).resolves.toMatchObject({ success: true });
  });

  it('setPlanModeGate(null) removes the gate', async () => {
    gateState = 'plan_mode';
    await expect(registry.execute('coder.write-file', {}, ctx())).rejects.toBeInstanceOf(ToolError);
    registry.setPlanModeGate(null);
    await expect(registry.execute('coder.write-file', {}, ctx())).resolves.toMatchObject({ success: true });
  });
});

// ---------------------------------------------------------------------------
// meta.enter-plan-mode / meta.exit-plan-mode executors
// ---------------------------------------------------------------------------

describe('meta.enter-plan-mode + meta.exit-plan-mode executors', () => {
  // Minimal in-memory state machine implementing PlanModeStateMachineLike.
  function fakeSM(): PlanModeStateMachineLike & { calls: string[] } {
    let state: string = 'normal';
    let plan: { id: string; title: string; status: string } | null = null;
    const calls: string[] = [];
    return {
      calls,
      enterPlanMode(title?: string) {
        calls.push(`enter:${title ?? ''}`);
        state = 'plan_mode';
        plan = { id: 'p-1', title: title ?? 'Untitled', status: 'draft' };
        return { id: plan.id, title: plan.title };
      },
      submitForApproval() {
        calls.push('submit');
        if (state !== 'plan_mode' || !plan) return null;
        state = 'plan_approval';
        plan.status = 'approved';
        return { id: plan.id, status: plan.status };
      },
      approvePlan() {
        calls.push('approve');
        if (state !== 'plan_approval' || !plan) return null;
        state = 'executing';
        plan.status = 'executing';
        return { id: plan.id, status: plan.status };
      },
      exitPlanMode() {
        calls.push('exit');
        const closed = plan;
        state = 'normal';
        plan = null;
        return closed ? { id: closed.id } : null;
      },
      getState() { return state; },
      isActive() { return state !== 'normal'; },
    };
  }

  afterEach(() => setPlanModeStateMachine(null));

  it('enter refuses when no state machine is injected', async () => {
    setPlanModeStateMachine(null);
    const r = await enterPlanModeTool.execute({ title: 'X' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('not been injected');
  });

  it('enter transitions normal → plan_mode and reports the plan id', async () => {
    const sm = fakeSM();
    setPlanModeStateMachine(sm);
    const r = await enterPlanModeTool.execute({ title: 'Refactor auth' }, ctx());
    expect(r.success).toBe(true);
    expect(sm.getState()).toBe('plan_mode');
    expect(r.output).toContain('Plan mode entered');
    expect((r.data as { planId: string }).planId).toBe('p-1');
    expect(sm.calls).toContain('enter:Refactor auth');
  });

  it('enter refuses re-entry when already in plan mode', async () => {
    const sm = fakeSM();
    setPlanModeStateMachine(sm);
    await enterPlanModeTool.execute({ title: 'X' }, ctx());
    const r2 = await enterPlanModeTool.execute({ title: 'Y' }, ctx());
    expect(r2.success).toBe(false);
    expect(r2.output).toContain('already in plan mode');
  });

  it('exit (approved:true) walks plan_mode → plan_approval → executing', async () => {
    const sm = fakeSM();
    setPlanModeStateMachine(sm);
    await enterPlanModeTool.execute({ title: 'X' }, ctx());
    const r = await exitPlanModeTool.execute({ plan: '1. read\n2. write\n3. test', approved: true }, ctx());
    expect(r.success).toBe(true);
    expect(sm.getState()).toBe('executing');
    expect((r.data as { state: string; approved: boolean })).toMatchObject({ state: 'executing', approved: true });
    expect(r.output).toContain('--- Plan ---');
    expect(r.output).toContain('1. read');
  });

  it('exit (approved:false) cancels back to normal regardless of phase', async () => {
    const sm = fakeSM();
    setPlanModeStateMachine(sm);
    await enterPlanModeTool.execute({ title: 'X' }, ctx());
    const r = await exitPlanModeTool.execute({ plan: 'just thinking out loud', approved: false }, ctx());
    expect(r.success).toBe(true);
    expect(sm.getState()).toBe('normal');
    expect(r.output).toContain('was NOT approved');
  });

  it('exit refuses when the `plan` text is missing', async () => {
    const sm = fakeSM();
    setPlanModeStateMachine(sm);
    await enterPlanModeTool.execute({ title: 'X' }, ctx());
    const r = await exitPlanModeTool.execute({ approved: true }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('`plan` is required');
  });

  it('exit (approved:true) fails LOUD when submitForApproval refuses (verifier HIGH #2)', async () => {
    // SM that accepts enter() but refuses submitForApproval() — must NOT
    // report "unblocked" while the gate is still active.
    const refusing: PlanModeStateMachineLike = {
      enterPlanMode() { return { id: 'p', title: 'x' }; },
      submitForApproval() { return null; },
      approvePlan() { throw new Error('should not reach'); },
      exitPlanMode() { return null; },
      getState() { return 'plan_mode'; },
      isActive() { return true; },
    };
    setPlanModeStateMachine(refusing);
    const r = await exitPlanModeTool.execute({ plan: 'X', approved: true }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('submitForApproval refused');
  });

  it('exit (approved:true) fails LOUD when approvePlan refuses', async () => {
    let s: string = 'plan_approval';
    const refusing: PlanModeStateMachineLike = {
      enterPlanMode() { return { id: 'p', title: 'x' }; },
      submitForApproval() { s = 'plan_approval'; return { id: 'p', status: 'approved' }; },
      approvePlan() { return null; },
      exitPlanMode() { return null; },
      getState() { return s; },
      isActive() { return s !== 'normal'; },
    };
    setPlanModeStateMachine(refusing);
    const r = await exitPlanModeTool.execute({ plan: 'X', approved: true }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toContain('approvePlan refused');
  });

  it('status executor reports disabled when no SM injected', async () => {
    setPlanModeStateMachine(null);
    const r = await planModeStatusTool.execute({}, ctx());
    expect(r.success).toBe(true);
    expect((r.data as { state: string; active: boolean }).state).toBe('disabled');
  });

  it('status executor reports the live state when SM is injected', async () => {
    const sm = fakeSM();
    setPlanModeStateMachine(sm);
    await enterPlanModeTool.execute({ title: 'X' }, ctx());
    const r = await planModeStatusTool.execute({}, ctx());
    expect(r.success).toBe(true);
    expect((r.data as { state: string; active: boolean; gateInstalled: boolean })).toMatchObject({
      state: 'plan_mode',
      active: true,
      gateInstalled: true,
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: registry + gate + executors together
// ---------------------------------------------------------------------------

describe('plan-mode end-to-end', () => {
  // afterEach reset matches the executors block (verifier HIGH #1 — the
  // module-level _stateMachine singleton would otherwise leak across
  // test files when an assertion throws before the inline reset.)
  afterEach(() => setPlanModeStateMachine(null));

  it('block → approve → unblock cycle works through the registry', async () => {
    const registry = new ToolRegistry();
    const sm = (function fakeSM() {
      let state: string = 'normal';
      return {
        enterPlanMode() { state = 'plan_mode'; return { id: 'p-e2e', title: 'E2E' }; },
        submitForApproval() { state = 'plan_approval'; return { id: 'p-e2e', status: 'approved' }; },
        approvePlan() { state = 'executing'; return { id: 'p-e2e', status: 'executing' }; },
        exitPlanMode() { state = 'normal'; return { id: 'p-e2e' }; },
        getState() { return state; },
        isActive() { return state !== 'normal'; },
      };
    })();

    setPlanModeStateMachine(sm);
    registry.register(enterPlanModeTool);
    registry.register(exitPlanModeTool);
    registry.register(makeTool('coder.write-file', { safety: 'destructive' }));
    registry.setPlanModeGate(gateFromStateMachine(sm));

    // 1. Writes are allowed before plan mode.
    await expect(registry.execute('coder.write-file', {}, ctx())).resolves.toMatchObject({ success: true });

    // 2. Enter plan mode — writes blocked.
    await registry.execute('meta.enter-plan-mode', { title: 'T' }, ctx());
    await expect(registry.execute('coder.write-file', {}, ctx())).rejects.toMatchObject({ code: 'tool_plan_mode_blocked' });

    // 3. Exit (approved) — writes unblocked again (state machine moves to executing).
    await registry.execute('meta.exit-plan-mode', { plan: 'p', approved: true }, ctx());
    expect(sm.getState()).toBe('executing');
    await expect(registry.execute('coder.write-file', {}, ctx())).resolves.toMatchObject({ success: true });

    setPlanModeStateMachine(null);
  });
});
