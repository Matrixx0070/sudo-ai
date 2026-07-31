/**
 * A2b — governed graph lane through the prod composition (governed-run.ts).
 *
 * Proves the previously caller-less AL4 stack end-to-end via the module
 * meta.run-workflow actually invokes: compile → step executors → GraphRunStore
 * → runGovernedGraph. GOV-1..5.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflowGoverned, readGraphDailyUsd } from '../../src/core/workflows/governed-run.js';
import type { Workflow } from '../../src/core/workflows/types.js';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'govrun-')), 'graph.db');
}

function echoWorkflow(name = 'gov-echo'): Workflow {
  return {
    name,
    steps: [
      { id: 'step-a', command: 'echo alpha' },
      { id: 'step-b', command: 'echo beta' },
    ],
  } as Workflow;
}

describe('runWorkflowGoverned (A2b prod lane)', () => {
  it('GOV-1: linear echo workflow succeeds with per-step results in settle order', async () => {
    const { report, completedSteps } = await runWorkflowGoverned(echoWorkflow(), {
      runId: 'gov-1',
      dbPath: tmpDb(),
      env: {},
    });
    expect(report.status).toBe('success');
    expect(completedSteps.map((s) => s.id)).toEqual(['step-a', 'step-b']);
    expect(completedSteps.every((s) => s.status === 'success')).toBe(true);
    expect(completedSteps[0]!.stdout).toContain('alpha');
  });

  it('GOV-2: daily USD ceiling already exhausted → run pauses and alert fires', async () => {
    const alerts: string[] = [];
    const { report } = await runWorkflowGoverned(echoWorkflow('gov-budget'), {
      runId: 'gov-2',
      dbPath: tmpDb(),
      env: { SUDO_WORKFLOWS_GRAPH_DAILY_USD: '5' },
      dailyUsdSpent: () => 9.99,
      alert: ({ reason }) => void alerts.push(reason),
    });
    expect(report.status).toBe('paused');
    expect(report.pauseReason).toMatch(/daily USD budget exhausted/);
    expect(alerts).toHaveLength(1);
  });

  it('GOV-3: ceiling declared but no billing reader → fails closed (pauses, never runs unmetered)', async () => {
    const { report, completedSteps } = await runWorkflowGoverned(echoWorkflow('gov-noreader'), {
      runId: 'gov-3',
      dbPath: tmpDb(),
      env: { SUDO_WORKFLOWS_GRAPH_DAILY_USD: '5' },
      // no dailyUsdSpent on purpose
    });
    expect(report.status).toBe('paused');
    expect(report.pauseReason).toMatch(/no billing reader/);
    expect(completedSteps.filter((s) => s.status === 'success')).toHaveLength(0);
  });

  it('GOV-4: resume with same runId seeds settled nodes — steps do not re-execute', async () => {
    const db = tmpDb();
    let executions = 0;
    const wf: Workflow = {
      name: 'gov-resume',
      steps: [
        { id: 'count', type: 'tool', tool: 'noop', args: {} },
        { id: 'after', command: 'echo done' },
      ],
    } as unknown as Workflow;
    const toolExecutor = async () => {
      executions++;
      return { success: true, stdout: `run-${executions}` };
    };
    const first = await runWorkflowGoverned(wf, { runId: 'gov-4', dbPath: db, env: {}, toolExecutor });
    expect(first.report.status).toBe('success');
    expect(executions).toBe(1);
    const second = await runWorkflowGoverned(wf, { runId: 'gov-4', dbPath: db, env: {}, toolExecutor });
    expect(second.report.status).toBe('success');
    // Settled node seeded from the store: the tool side-effect ran exactly once.
    expect(executions).toBe(1);
  });

  it('GOV-5: readGraphDailyUsd parses only positive finite values', () => {
    expect(readGraphDailyUsd({})).toBeUndefined();
    expect(readGraphDailyUsd({ SUDO_WORKFLOWS_GRAPH_DAILY_USD: '0' })).toBeUndefined();
    expect(readGraphDailyUsd({ SUDO_WORKFLOWS_GRAPH_DAILY_USD: 'nope' })).toBeUndefined();
    expect(readGraphDailyUsd({ SUDO_WORKFLOWS_GRAPH_DAILY_USD: '2.5' })).toBe(2.5);
  });
});
