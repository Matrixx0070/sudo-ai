/**
 * @file al44-park-notify.test.ts
 * @description AL4.4 — a parked run must reach an approver, and a headless
 * approval must hold. Two halves:
 *  1. runGovernedGraph fires the alert seam when a gate parks the run
 *     (previously: parked runs notified NOBODY; the artifact sat in the store
 *     waiting for someone to poll it).
 *  2. ApprovalManager DENIES when no sender is registered (previously:
 *     headless auto-APPROVE — "no channel wired" silently equalled "yes").
 *     SUDO_APPROVAL_HEADLESS_ALLOW=1 restores the old dev convenience.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  validateGraph,
  type GraphNode,
  type GraphNodeExecutor,
  type WorkflowGraph,
} from '../../src/core/workflows/index.js';
import { GraphRunStore, runGovernedGraph, type BudgetAlert } from '../../src/core/orchestration/index.js';
import { ApprovalManager } from '../../src/core/agent/approval.js';
import { useGatedAuthority } from '../helpers/gated-authority.js';

// This suite exercises the human-in-the-loop machinery, which is live only
// under gated authority (default is autonomous — docs/EXECUTION_AUTHORITY.md).
useGatedAuthority();

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'al44-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('AL4.4 — gate park fires the alert seam', () => {
  const gateGraph: WorkflowGraph = {
    name: 'park-notify',
    nodes: [
      { id: 'work', kind: 'agent' },
      { id: 'ship', kind: 'gate' } as GraphNode,
    ],
    edges: [{ from: 'work', to: 'ship' }],
  };
  validateGraph(gateGraph);

  it('PARK-1: awaiting_approval run alerts with the parked node named', async () => {
    const store = new GraphRunStore(path.join(scratch, 'runs1.db'));
    const alerts: BudgetAlert[] = [];
    const agentExec: GraphNodeExecutor = async () => ({ success: true, output: 'done', spend: 1 });
    const gateExec: GraphNodeExecutor = async () => ({ success: false, park: true, error: 'awaiting decision' });

    const report = await runGovernedGraph({
      store,
      runId: 'run-park-1',
      graph: gateGraph,
      executors: { agent: agentExec, gate: gateExec },
      alert: (info) => { alerts.push(info); },
    });

    expect(report.status).toBe('awaiting_approval');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toContain('approval gate parked');
    expect(alerts[0]!.reason).toContain('"ship"');
    expect(alerts[0]!.runId).toBe('run-park-1');
  });

  it('PARK-2: a throwing alert sink never strands the run (state persisted first)', async () => {
    const store = new GraphRunStore(path.join(scratch, 'runs2.db'));
    const agentExec: GraphNodeExecutor = async () => ({ success: true, output: 'done' });
    const gateExec: GraphNodeExecutor = async () => ({ success: false, park: true, error: 'awaiting decision' });

    const report = await runGovernedGraph({
      store,
      runId: 'run-park-2',
      graph: gateGraph,
      executors: { agent: agentExec, gate: gateExec },
      alert: () => { throw new Error('sink down'); },
    });

    expect(report.status).toBe('awaiting_approval');
    expect(store.getRun('run-park-2')!.status).toBe('awaiting_approval');
  });

  it('PARK-3: successful runs do not alert', async () => {
    const store = new GraphRunStore(path.join(scratch, 'runs3.db'));
    const alerts: BudgetAlert[] = [];
    const okExec: GraphNodeExecutor = async () => ({ success: true, output: 'ok' });

    const report = await runGovernedGraph({
      store,
      runId: 'run-ok',
      graph: gateGraph,
      executors: { agent: okExec, gate: okExec },
      alert: (info) => { alerts.push(info); },
    });

    expect(report.status).toBe('success');
    expect(alerts).toHaveLength(0);
  });
});

describe('AL4.4 — headless approval fails closed', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved['SUDO_APPROVAL_HEADLESS_ALLOW'] = process.env['SUDO_APPROVAL_HEADLESS_ALLOW'];
    delete process.env['SUDO_APPROVAL_HEADLESS_ALLOW'];
  });
  afterEach(() => {
    if (saved['SUDO_APPROVAL_HEADLESS_ALLOW'] === undefined) delete process.env['SUDO_APPROVAL_HEADLESS_ALLOW'];
    else process.env['SUDO_APPROVAL_HEADLESS_ALLOW'] = saved['SUDO_APPROVAL_HEADLESS_ALLOW'];
  });

  it('HEADLESS-1: no sender registered → DENIED', async () => {
    const mgr = new ApprovalManager();
    const approved = await mgr.requestApproval('system.exec', { command: 'rm -rf /' }, 'headless', '');
    expect(approved).toBe(false);
  });

  it('HEADLESS-2: SUDO_APPROVAL_HEADLESS_ALLOW=1 restores dev auto-approve', async () => {
    process.env['SUDO_APPROVAL_HEADLESS_ALLOW'] = '1';
    const mgr = new ApprovalManager();
    const approved = await mgr.requestApproval('system.exec', { command: 'ls' }, 'headless', '');
    expect(approved).toBe(true);
  });

  it('HEADLESS-3: a registered sender still gets the prompt (unchanged path)', async () => {
    const mgr = new ApprovalManager();
    const sent: string[] = [];
    mgr.registerSender('telegram', { send: async (_peer: string, text: string) => { sent.push(text); } } as never);
    const pending = mgr.requestApproval('system.exec', { command: 'ls' }, 'telegram', 'owner-1');
    // Give the send microtask a beat, then approve via the public API.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    const idMatch = /approval-id: ([A-Za-z0-9_-]+)/.exec(sent[0]!);
    expect(idMatch).not.toBeNull();
    mgr.handleResponse(idMatch![1]!, true);
    await expect(pending).resolves.toBe(true);
  });
});
