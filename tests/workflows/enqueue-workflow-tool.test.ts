/**
 * Tests for meta.enqueue-workflow (gap #24 slice 4).
 *
 * Uses the same workflow scaffolding as queue.test.ts — real SQLite + real
 * TaskQueue + real workflow YAML in a per-test tmp WORKSPACE_DIR. The tool
 * exercises the param parsing + validation layer plus the request → enqueue
 * round-trip; the deeper execution semantics are covered in queue.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ToolContext, ToolResult } from '../../src/core/tools/types.js';
import type { ToolRegistry } from '../../src/core/tools/registry.js';

let tmpHome: string;
let workflowsBase: string;
let enqueueWorkflowTool: import('../../src/core/tools/types.js').ToolDefinition;
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
  sessionId: 'enqueue-test',
  workingDir: '/tmp',
  config: {},
  logger: console,
};

function writeWorkflow(name: string, body: string): string {
  writeFileSync(path.join(workflowsBase, name), body, 'utf8');
  return name;
}

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'wf-enqueue-'));
  process.env['SUDO_AI_HOME'] = tmpHome;
  vi.resetModules();

  const paths = await import('../../src/core/shared/paths.js');
  workflowsBase = path.join(paths.WORKSPACE_DIR, 'workflows');
  MIND_DB = paths.MIND_DB;
  mkdirSync(workflowsBase, { recursive: true });

  const queueMod = await import('../../src/core/workflows/queue.js');
  initWorkflowQueue = queueMod.initWorkflowQueue;
  _resetWorkflowQueueForTests = queueMod._resetWorkflowQueueForTests;

  const toolMod = await import('../../src/core/tools/builtin/meta/enqueue-workflow.js');
  enqueueWorkflowTool = toolMod.enqueueWorkflowTool;
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

describe('meta.enqueue-workflow', () => {
  it('has the expected trust posture (destructive + requiresConfirmation)', () => {
    expect(enqueueWorkflowTool.name).toBe('meta.enqueue-workflow');
    expect(enqueueWorkflowTool.safety).toBe('destructive');
    expect(enqueueWorkflowTool.requiresConfirmation).toBe(true);
  });

  it('returns an honest error when the WorkflowQueue is not initialized', async () => {
    // Don't call initWorkflowQueue — singleton stays null.
    const res = await enqueueWorkflowTool.execute({ file: 'whatever.yaml' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('not initialized');
  });

  it('enqueues a workflow and returns task_id + run_id', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    const file = writeWorkflow(
      'enq-basic.yaml',
      'name: enq-basic\nsteps:\n  - id: a\n    type: tool\n    command: stub.x\n',
    );

    const res = await enqueueWorkflowTool.execute({ file }, ctx);

    expect(res.success).toBe(true);
    expect(res.output).toContain('enqueued');
    expect(res.data?.['taskId']).toMatch(/^[0-9a-f-]+$/);
    expect(res.data?.['runId']).toMatch(/^[0-9a-f-]+$/);
    expect(res.data?.['workflowName']).toBe('enq-basic');
    expect(res.data?.['status']).toBe('queued');
  });

  it('rejects a missing/empty file param', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });
    const res = await enqueueWorkflowTool.execute({ file: '   ' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('"file" must be a non-empty string');
  });

  it('rejects an invalid priority', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });
    const file = writeWorkflow(
      'enq-bad-prio.yaml',
      'name: enq-bad-prio\nsteps:\n  - id: a\n    type: tool\n    command: stub.x\n',
    );
    const res = await enqueueWorkflowTool.execute({ file, priority: 'urgent' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('priority must be one of');
  });

  it('rejects a malformed run_id', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });
    const file = writeWorkflow(
      'enq-bad-runid.yaml',
      'name: enq-bad-runid\nsteps:\n  - id: a\n    type: tool\n    command: stub.x\n',
    );
    const res = await enqueueWorkflowTool.execute({ file, run_id: '../escape' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('run_id is malformed');
  });

  it('refuses to enqueue a workflow with approval gates without auto_approve', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    const file = writeWorkflow(
      'enq-gated.yaml',
      `name: enq-gated
steps:
  - id: g
    type: tool
    command: stub.gated
    approval: true
`,
    );

    const res = await enqueueWorkflowTool.execute({ file }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('approval: true');
  });

  it('accepts auto_approve:true for a workflow with approval gates', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    const file = writeWorkflow(
      'enq-gated-ok.yaml',
      `name: enq-gated-ok
steps:
  - id: g
    type: tool
    command: stub.gated
    approval: true
`,
    );

    const res = await enqueueWorkflowTool.execute({ file, auto_approve: true }, ctx);
    expect(res.success).toBe(true);
    expect(res.data?.['taskId']).toMatch(/^[0-9a-f-]+$/);
  });

  it('forwards priority + depends_on to the TaskQueue', async () => {
    const { registry } = stubRegistry(async () => ({ success: true, output: 'ok' }));
    const wq = initWorkflowQueue({
      registry,
      ctx,
      dbPath: MIND_DB,
      maxConcurrent: 1,
      pollIntervalMs: 100,
    });

    const file = writeWorkflow(
      'enq-prio.yaml',
      'name: enq-prio\nsteps:\n  - id: a\n    type: tool\n    command: stub.x\n',
    );

    const fakeDep = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const res = await enqueueWorkflowTool.execute(
      { file, priority: 'high', depends_on: [fakeDep] },
      ctx,
    );

    expect(res.success).toBe(true);
    expect(res.data?.['status']).toBe('blocked');
    expect(res.data?.['priority']).toBe('high');

    const task = wq.taskQueue.getTask(res.data!['taskId'] as string);
    expect(task?.priority).toBe('high');
    expect(task?.dependsOn).toEqual([fakeDep]);
    expect(task?.status).toBe('blocked');
  });
});
