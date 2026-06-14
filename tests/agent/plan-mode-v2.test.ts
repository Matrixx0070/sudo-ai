/**
 * @file plan-mode-v2.test.ts
 * @description Tests for PlanModeStateMachine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanModeStateMachine, type PlanModeState, type PlanV2 } from '../../src/core/agent/plan-mode-v2.js';

describe('PlanModeStateMachine', () => {
  let machine: PlanModeStateMachine;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-mode-test-'));
    machine = new PlanModeStateMachine(tempDir);
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('should start in normal state', () => {
    expect(machine.getState()).toBe('normal');
    expect(machine.isActive()).toBe(false);
  });

  it('should transition normal → plan_mode on enterPlanMode', () => {
    const plan = machine.enterPlanMode('Test Plan');
    expect(machine.getState()).toBe('plan_mode');
    expect(machine.isActive()).toBe(true);
    expect(plan.title).toBe('Test Plan');
    expect(plan.status).toBe('draft');
  });

  it('should add steps to the active plan', () => {
    machine.enterPlanMode('Test Plan');
    const step1 = machine.addStep('Step 1: Read the code');
    expect(step1).not.toBeNull();
    expect(step1!.id).toBe(1);
    expect(step1!.description).toBe('Step 1: Read the code');

    const step2 = machine.addStep('Step 2: Fix the bug');
    expect(step2!.id).toBe(2);
  });

  it('should not add steps when not in plan mode', () => {
    const result = machine.addStep('Should be discarded');
    expect(result).toBeNull();
  });

  it('should transition plan_mode → plan_approval on submitForApproval', () => {
    machine.enterPlanMode('Test Plan');
    machine.addStep('Step 1');
    const plan = machine.submitForApproval();
    expect(machine.getState()).toBe('plan_approval');
    expect(machine.isAwaitingApproval()).toBe(true);
  });

  it('should transition plan_approval → executing on approvePlan', () => {
    machine.enterPlanMode('Test Plan');
    machine.addStep('Step 1');
    machine.submitForApproval();
    const plan = machine.approvePlan();
    expect(machine.getState()).toBe('executing');
    expect(plan?.status).toBe('executing');
  });

  it('should transition plan_approval → plan_mode on rejectPlan', () => {
    machine.enterPlanMode('Test Plan');
    machine.addStep('Step 1');
    machine.submitForApproval();
    const plan = machine.rejectPlan('Not enough detail');
    expect(machine.getState()).toBe('plan_mode');
    expect(plan?.status).toBe('rejected');
    expect(plan?.rejectionReason).toBe('Not enough detail');
  });

  it('should transition any state → normal on exitPlanMode', () => {
    machine.enterPlanMode('Test Plan');
    const plan = machine.exitPlanMode();
    expect(machine.getState()).toBe('normal');
    expect(machine.isActive()).toBe(false);
  });

  it('should return null for invalid transitions (e.g., approve from normal)', () => {
    // Can't go from normal to plan_approval
    const result = machine.approvePlan();
    expect(result).toBeNull();
  });

  it('should toggle plan mode via togglePlanMode', () => {
    // Enter
    const enterResult = machine.togglePlanMode('My Plan');
    expect(enterResult.active).toBe(true);
    expect(machine.getState()).toBe('plan_mode');

    // Exit
    const exitResult = machine.togglePlanMode();
    expect(exitResult.active).toBe(false);
    expect(machine.getState()).toBe('normal');
  });

  it('should update step status', () => {
    machine.enterPlanMode('Test Plan');
    machine.addStep('Step 1');
    machine.addStep('Step 2');
    machine.updateStepStatus(1, 'in_progress');
    machine.updateStepStatus(2, 'completed');

    const plan = machine.getActivePlan();
    expect(plan?.steps[0].status).toBe('in_progress');
    expect(plan?.steps[1].status).toBe('completed');
  });

  it('should provide executable tool definitions from instance methods', () => {
    // Converted from static schema-only stubs to instance methods that
    // return executable ToolDefinitions delegating to the SM (audit
    // pass — "prefer wiring over deleting").
    const enterTool = machine.getEnterPlanModeTool();
    expect(enterTool.name).toBe('plan_mode.enter');
    expect(typeof enterTool.execute).toBe('function');
    // Flat ToolRegistry parameter shape (not JSON Schema).
    expect((enterTool.parameters as Record<string, { type?: string }>)['title']?.type).toBe('string');

    const exitTool = machine.getExitPlanModeTool();
    expect(exitTool.name).toBe('plan_mode.exit');
    expect(typeof exitTool.execute).toBe('function');
  });

  it('should return state document', () => {
    machine.enterPlanMode('Test');
    const doc = machine.getStateDocument();
    expect(doc.state).toBe('plan_mode');
    expect(doc.activePlanId).toBeTruthy();
  });

  it('should persist and restore state', () => {
    machine.enterPlanMode('Persistent Plan');
    machine.addStep('Step 1: Read code');
    machine.addStep('Step 2: Write fix');
    machine.submitForApproval();

    // Create a new machine instance pointing to the same dir
    const restored = new PlanModeStateMachine(tempDir);
    expect(restored.getState()).toBe('plan_approval');
    expect(restored.getActivePlan()?.title).toBe('Persistent Plan');
    expect(restored.getActivePlan()?.steps.length).toBe(2);
  });
});