/**
 * Tests for the cross-workflow scheduler (gap #24 slice 4).
 *
 * Uses a real better-sqlite3 mind.db in a tmp dir, real TaskQueue + TaskExecutor,
 * and real workflow YAML files under a tmp WORKSPACE_DIR. Tool steps go through a
 * stub registry so no actual host tool dispatches happen. Shell steps are exercised
 * separately by the engine tests in lobster.test.ts — here we focus on the queue
 * layer: enqueue, handler dispatch, approval-gate refusal, path confinement, and
 * the lifecycle of a queued run from queued → running → completed/failed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ToolContext, ToolResult } from '../../src/core/tools/types.js';
import type { ToolRegistry } from '../../src/core/tools/registry.js';

// ---------------------------------------------------------------------------
// Per-test module + env isolation (mirrors run-workflow-tool.test.ts).
// SUDO_AI_HOME drives DATA_DIR + WORKSPACE_DIR; modules capture these at load
// time, so we vi.resetModules() before each test and re-import.
// ---------------------------------------------------------------------------

let tmpHome: string;
let workflowsBase: string;
let initWorkflowQueue: typeof import('../../src/core/workflows/queue.js').initWorkflowQueue;
let _resetWorkflowQueueForTests: typeof import('../../src/core/workflows/queue.js')._resetWorkflowQueueForTests;
let MIND_DB: string;

function stubRegistry(
  impl: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
): { registry: ToolRegistry; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(impl);
  return { registry: { execute } as unknown as ToolRegistry, execute };
}

const ctx: ToolContext = {
  sessionId: 'queue-test',
  workingDir: '/tmp',
  config: {},
  logger: console,
};

function writeWorkflow(name: string, body: string): string {
  writeFileSync(path.join(workflowsBase, name), body, 'utf8');
  return name;
}

/** Poll until predicate is true or timeoutMs elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4_000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor: predicate never satisfied within ${timeoutMs}ms`);
}

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'wf-queue-'));
  process.env['SUDO_AI_HOME'] = tmpHome;
  vi.resetModules();

  const paths = await import('../../src/core/shared/paths.js');
  workflowsBase = path.join(paths.WORKSPACE_DIR, 'workflows');
  MIND_DB = paths.MIND_DB;
  mkdirSync(workflowsBase, { recursive: true });

  const queueMod = await import('../../src/core/workflows/queue.js');
  initWorkflowQueue = queueMod.initWorkflowQueue;
  _resetWorkflowQueueForTests = queueMod._resetWorkflowQueueForTests;
});

afterEach(() => {
  try {
    _resetWorkflowQueueForTests();
  } catch {
    // ignore
  }
  delete process.env['SUDO_AI_HOME'];
  rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowQueue (slice 4)', () => {
  it('enqueueWorkflow returns task_id + run_id and runs the workflow end-to-end', async () => {
    const calls: string[] = [];
    const { registry } = stubRegistry(async (name) => {
      calls.push(name);
      return { success: true, output: `out:${name}` };
    });

    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 2,
      pollIntervalMs: 100,
    });

    writeWorkflow(
      'q-basic.yaml',
      `name: q-basic
steps:
  - id: a
    type: tool
    command: stub.alpha
  - id: b
    type: tool
    command: stub.beta
`,
    );

    const res = await wq.enqueueWorkflow({ file: 'q-basic.yaml' });
    expect(res.taskId).toMatch(/^[0-9a-f-]+$/);
    expect(res.runId).toMatch(/^[0-9a-f-]+$/);
    expect(res.workflowName).toBe('q-basic');
    expect(res.status).toBe('queued');

    // Wait for the executor to pick it up and complete it.
    await waitFor(() => wq.taskQueue.getTask(res.taskId)?.status === 'completed');

    const task = wq.taskQueue.getTask(res.taskId);
    expect(task?.status).toBe('completed');
    expect(calls).toEqual(['stub.alpha', 'stub.beta']);
  });

  it('refuses to enqueue a workflow with approval gates when autoApprove is not set', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    writeWorkflow(
      'q-needs-approval.yaml',
      `name: q-needs-approval
steps:
  - id: gate
    type: tool
    command: stub.gated
    approval: true
`,
    );

    await expect(wq.enqueueWorkflow({ file: 'q-needs-approval.yaml' })).rejects.toThrow(
      'approval: true',
    );
  });

  it('runs a workflow with approval gates when autoApprove: true is set', async () => {
    const calls: string[] = [];
    const { registry } = stubRegistry(async (name) => {
      calls.push(name);
      return { success: true, output: 'ok' };
    });
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    writeWorkflow(
      'q-approval-auto.yaml',
      `name: q-approval-auto
steps:
  - id: gate
    type: tool
    command: stub.gated
    approval: true
`,
    );

    const res = await wq.enqueueWorkflow({
      file: 'q-approval-auto.yaml',
      autoApprove: true,
    });

    await waitFor(() => wq.taskQueue.getTask(res.taskId)?.status === 'completed');
    expect(calls).toEqual(['stub.gated']);
  });

  it('marks a workflow whose step fails as failed on the TaskQueue', async () => {
    const { registry } = stubRegistry(async () => ({ success: false, output: 'NOPE' }));
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    writeWorkflow(
      'q-fail.yaml',
      `name: q-fail
steps:
  - id: oops
    type: tool
    command: stub.broken
`,
    );

    const res = await wq.enqueueWorkflow({ file: 'q-fail.yaml' });
    await waitFor(() => wq.taskQueue.getTask(res.taskId)?.status === 'failed');

    const task = wq.taskQueue.getTask(res.taskId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('halted on a failing step');
  });

  it('rejects a journal_dir outside DATA_DIR / WORKSPACE_DIR', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    writeWorkflow(
      'q-oob.yaml',
      'name: q-oob\nsteps:\n  - id: a\n    type: tool\n    command: stub.x\n',
    );

    await expect(
      wq.enqueueWorkflow({ file: 'q-oob.yaml', journalDir: '/etc' }),
    ).rejects.toThrow('must be inside DATA_DIR or WORKSPACE_DIR');
  });

  it('honors path confinement (workflow file outside workspace rejected)', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    // Drop a workflow into a totally different tmp dir — outside the workspace.
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'wf-outside-'));
    const outsidePath = path.join(outsideDir, 'evil.yaml');
    writeFileSync(outsidePath, 'name: evil\nsteps:\n  - id: a\n    command: echo hi\n', 'utf8');

    try {
      await expect(wq.enqueueWorkflow({ file: outsidePath })).rejects.toThrow(
        /outside the allowed base directory/,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('runs up to maxConcurrent queued workflows concurrently', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const { registry } = stubRegistry(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 200));
      inFlight--;
      return { success: true, output: 'done' };
    });
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 3,
      pollIntervalMs: 50,
    });

    writeWorkflow(
      'q-conc.yaml',
      `name: q-conc
steps:
  - id: a
    type: tool
    command: stub.a
`,
    );

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await wq.enqueueWorkflow({ file: 'q-conc.yaml' });
      ids.push(r.taskId);
    }

    await waitFor(
      () => ids.every((id) => wq.taskQueue.getTask(id)?.status === 'completed'),
      6_000,
    );

    expect(peakInFlight).toBe(3);
  });

  it('refuses to run when the workflow file SHA-256 changed between enqueue and dispatch (TOCTOU)', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      // 1s poll so we can race a file edit in between enqueue and dispatch.
      // Vitest's default test timeout (5s) is comfortable for this margin.
      maxConcurrent: 1,
      pollIntervalMs: 1_000,
    });

    const file = writeWorkflow(
      'q-toctou.yaml',
      'name: q-toctou\nsteps:\n  - id: a\n    type: tool\n    command: stub.original\n',
    );

    const res = await wq.enqueueWorkflow({ file });

    // Mutate the file BEFORE the executor's first poll picks it up. Even a
    // benign whitespace change flips the SHA. The handler should refuse to
    // run and TaskQueue.fail() should record the mismatch.
    writeFileSync(
      path.join(workflowsBase, file),
      'name: q-toctou\nsteps:\n  - id: a\n    type: tool\n    command: stub.swapped\n',
      'utf8',
    );

    await waitFor(() => wq.taskQueue.getTask(res.taskId)?.status === 'failed', 6_000);

    const task = wq.taskQueue.getTask(res.taskId);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('SHA-256 changed between enqueue and dispatch');
  });

  it('singleton: initWorkflowQueue twice returns the same instance', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    const a = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });
    const b = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });
    expect(a).toBe(b);
  });
});
