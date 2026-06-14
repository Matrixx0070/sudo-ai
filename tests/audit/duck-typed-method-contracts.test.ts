/**
 * Audit pass — regression guard for the verifier BLOCKER class.
 *
 * Several hot-path sites use `obj.method?.()` / `obj?.method?.()` to
 * call a method expected to exist on a known concrete class. When the
 * method is silently absent, the `?.()` short-circuits to `undefined`
 * and the calling code "succeeds" while never doing the work — gap #20
 * caught this with `ToolRegistry.requiresConfirmation` (was MISSING;
 * 7+ destructive tools ran without the approval gate). This test pins
 * the contracts I audited so the same class of bug can't recur
 * silently.
 *
 * Each assertion: "the canonical implementation of this type exposes
 * this method". If a future refactor renames or removes the method,
 * this test fails loud — pointing the maintainer at the call site
 * that will silently break.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { GoalEngineV2 } from '../../src/core/autonomy/goal-engine-v2.js';
import { OutcomesLedger } from '../../src/core/autonomy/outcomes.js';
import { PlanModeStateMachine } from '../../src/core/agent/plan-mode-v2.js';

describe('ToolRegistry duck-typed methods called via ?.()', () => {
  const reg = new ToolRegistry();

  it('listEnabled exists — called at loop.ts:979', () => {
    expect(typeof reg.listEnabled).toBe('function');
  });

  it('get exists — called at loop-helpers.ts:410', () => {
    expect(typeof reg.get).toBe('function');
  });

  it('skillIdForTool exists — called at loop.ts:1122', () => {
    expect(typeof reg.skillIdForTool).toBe('function');
  });

  it('getSchemaForLLM exists — called at loop.ts:2753', () => {
    expect(typeof reg.getSchemaForLLM).toBe('function');
  });

  it('requiresConfirmation exists — called at loop-helpers.ts:675 (gap #20 BLOCKER regression)', () => {
    expect(typeof reg.requiresConfirmation).toBe('function');
    // Behavioural pin too — the gap #20 fix needs this to actually
    // reflect the tool definition's flag, not just exist.
    reg.register({
      name: 'audit.tool',
      description: 'audit fixture',
      category: 'meta' as const,
      requiresConfirmation: true,
      timeout: 1_000,
      parameters: {},
      async execute() { return { success: true, output: '', data: {} }; },
    });
    expect(reg.requiresConfirmation('audit.tool')).toBe(true);
  });
});

describe('PlanModeStateMachine surface — legacy plan_mode.* tools properly wired', () => {
  it('enterPlanMode + exitPlanMode + getState exist on the instance', () => {
    const sm = new PlanModeStateMachine('/tmp');
    expect(typeof sm.enterPlanMode).toBe('function');
    expect(typeof sm.exitPlanMode).toBe('function');
    expect(typeof sm.getState).toBe('function');
  });

  it('getEnterPlanModeTool / getExitPlanModeTool are INSTANCE methods returning executable ToolDefinition', () => {
    // Per the autonomy mandate "prefer wiring over deleting", the
    // previous audit deletion of the legacy registration path was
    // reverted and the static schema-only stubs were converted to
    // instance methods returning real executable ToolDefinitions.
    // loop.ts then registers them at boot.
    const sm = new PlanModeStateMachine('/tmp');
    expect(typeof sm.getEnterPlanModeTool).toBe('function');
    expect(typeof sm.getExitPlanModeTool).toBe('function');
    const enter = sm.getEnterPlanModeTool();
    const exit = sm.getExitPlanModeTool();
    expect(enter.name).toBe('plan_mode.enter');
    expect(exit.name).toBe('plan_mode.exit');
    expect(typeof enter.execute).toBe('function');
    expect(typeof exit.execute).toBe('function');
  });

  it('legacy plan_mode.enter executor delegates to the SM (enter → plan_mode state)', async () => {
    const sm = new PlanModeStateMachine('/tmp');
    const enter = sm.getEnterPlanModeTool();
    const r = await enter.execute(
      { title: 'Audit-driven wire' },
      { sessionId: 'test', workingDir: '/tmp', config: {}, logger: {} },
    );
    expect(r.success).toBe(true);
    expect(sm.getState()).toBe('plan_mode');
    // Cleanup so this test doesn't bleed state into the next.
    sm.exitPlanMode();
  });

  it('legacy plan_mode.exit (approved:true) walks plan_mode → executing', async () => {
    const sm = new PlanModeStateMachine('/tmp');
    sm.enterPlanMode('e2e');
    const exit = sm.getExitPlanModeTool();
    const r = await exit.execute(
      { approved: true },
      { sessionId: 'test', workingDir: '/tmp', config: {}, logger: {} },
    );
    expect(r.success).toBe(true);
    expect(sm.getState()).toBe('executing');
    sm.exitPlanMode();
  });
});

describe('autonomy stores expose close() — registerShutdown handlers at cli.ts:2613-2614', () => {
  it('GoalEngineV2.close exists on prototype', () => {
    expect(typeof GoalEngineV2.prototype.close).toBe('function');
  });

  it('OutcomesLedger.close exists on prototype', () => {
    expect(typeof OutcomesLedger.prototype.close).toBe('function');
  });
});

describe('Brain method names called from slash-commands (mood/persona/model)', () => {
  it('Brain.prototype.getModel exists — model.ts:32', async () => {
    const { Brain } = await import('../../src/core/brain/brain.js');
    expect(typeof Brain.prototype.getModel).toBe('function');
  });

  it('Brain has NO getMood / getPersona — mood.ts and persona.ts rely on the private-field fallback (cosmetic, not broken)', async () => {
    const { Brain } = await import('../../src/core/brain/brain.js');
    // These were absent at audit time; the commands fall back to
    // `brain.currentMood` / `brain.currentPersona` private fields.
    // Pin the gap so a future addition either implements them
    // properly OR removes the dead `?.()` call.
    expect((Brain.prototype as unknown as Record<string, unknown>).getMood).toBeUndefined();
    expect((Brain.prototype as unknown as Record<string, unknown>).getPersona).toBeUndefined();
  });
});
