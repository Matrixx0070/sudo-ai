/**
 * @file lobster-pause-notify.test.ts
 * @description AL4.4 (lobster half): an approval gate that pauses the run
 * fires onApprovalPause AFTER the state is persisted — a parked run that
 * notifies nobody is a silent stall. The sink is fail-open: a throwing sink
 * never breaks the pause.
 */

import { describe, it, expect } from 'vitest';
import { runWorkflow } from '../../src/core/workflows/lobster.js';
import type { Workflow } from '../../src/core/workflows/types.js';

const GATED: Workflow = {
  name: 'gated-flow',
  steps: [
    { id: 'prep', type: 'tool', tool: 'noop', args: {} },
    { id: 'ship', type: 'tool', tool: 'noop', args: {}, approval: true },
  ],
} as unknown as Workflow;

const okExecutor = async () => ({ success: true, stdout: 'done' });

describe('lobster onApprovalPause', () => {
  it('PAUSE-1: pause fires the sink with workflow, step, and resume token', async () => {
    const fired: Array<{ workflowName: string; stepId: string; resumeToken: string }> = [];
    const state = await runWorkflow(GATED, {
      toolExecutor: okExecutor as never,
      onApprovalPause: (info) => { fired.push(info); },
    });

    expect(state.pendingStepId).toBe('ship');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.workflowName).toBe('gated-flow');
    expect(fired[0]!.stepId).toBe('ship');
    expect(fired[0]!.resumeToken).toBe(state.resumeToken);
  });

  it('PAUSE-2: a throwing sink never breaks the pause (state still parked)', async () => {
    const state = await runWorkflow(GATED, {
      toolExecutor: okExecutor as never,
      onApprovalPause: () => { throw new Error('sink down'); },
    });
    expect(state.pendingStepId).toBe('ship');
    expect(state.completedSteps.some((s) => s.status === 'awaiting_approval')).toBe(true);
  });

  it('PAUSE-3: an approved gate does not fire the sink', async () => {
    const fired: unknown[] = [];
    const state = await runWorkflow(GATED, {
      toolExecutor: okExecutor as never,
      approvalCallback: async () => true,
      onApprovalPause: (info) => { fired.push(info); },
    });
    expect(state.pendingStepId).toBeUndefined();
    expect(fired).toHaveLength(0);
  });

  it('PAUSE-4: no sink provided — pause behavior byte-identical (back-compat)', async () => {
    const state = await runWorkflow(GATED, { toolExecutor: okExecutor as never });
    expect(state.pendingStepId).toBe('ship');
    expect(state.resumeToken).toBeTruthy();
  });
});
