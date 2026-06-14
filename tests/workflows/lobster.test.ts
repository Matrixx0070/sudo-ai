/**
 * Unit tests for the Lobster workflow engine.
 *
 * child_process.spawn is mocked via vi.mock so no real shell commands execute.
 * All I/O is controlled through EventEmitter fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock child_process BEFORE importing the module under test
// ---------------------------------------------------------------------------

/**
 * Factory: builds a fake child_process.spawn return value.
 * `stdout`, `stderr`, and `exitCode` control what the fake process emits.
 */
function makeSpawnMock(stdout = '', stderr = '', exitCode = 0) {

  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinMock = { write: vi.fn(), end: vi.fn() };

  const child = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: typeof stdoutEmitter;
    stderr: typeof stderrEmitter;
    stdin: typeof stdinMock;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  child.stdin = stdinMock;
  child.kill = vi.fn();

  // Emit data + close asynchronously so listeners are attached first
  Promise.resolve().then(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout));
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });

  return child;
}

// We spy on spawn at the module level; each test configures the return value.
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

// Now import the module under test (after mocking)
import { loadWorkflow, runWorkflow } from '../../src/core/workflows/lobster.js';
import type { Workflow, WorkflowRunState, ToolStepExecutor } from '../../src/core/workflows/lobster.js';
import { validateStep, execShell } from '../../src/core/workflows/executor.js';
import { spawn } from 'child_process';

const spawnMock = vi.mocked(spawn);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = os.tmpdir();

/** Write a temp YAML file and return its path. */
function writeTmpYaml(name: string, content: string): string {
  const filePath = path.join(TMP, `lobster-test-${name}.yaml`);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** A minimal 2-step workflow object. */
function make2StepWorkflow(): Workflow {
  return {
    name: 'test-workflow',
    steps: [
      { id: 'step-a', command: 'echo hello' },
      { id: 'step-b', command: 'echo world' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Lobster workflow engine', () => {
  beforeEach(() => {
    // mockReset clears both call history AND queued mockImplementationOnce entries.
    spawnMock.mockReset();
  });

  // -------------------------------------------------------------------------
  // 1. Parse a YAML workflow file
  // -------------------------------------------------------------------------
  describe('loadWorkflow', () => {
    it('parses a valid YAML workflow file', async () => {
      const filePath = writeTmpYaml(
        'parse-test',
        `
name: daily-backup
description: Back up important files
steps:
  - id: check-disk
    command: df -h
  - id: backup
    command: tar czf /tmp/backup.tar.gz /root
    condition: "steps.check-disk.exitCode === 0"
  - id: upload
    command: gsutil cp /tmp/backup.tar.gz gs://bucket
    approval: true
    timeout: 5000
`,
      );

      const workflow = await loadWorkflow(filePath, { basePath: TMP });

      expect(workflow.name).toBe('daily-backup');
      expect(workflow.description).toBe('Back up important files');
      expect(workflow.steps).toHaveLength(3);

      const [step1, step2, step3] = workflow.steps;
      expect(step1?.id).toBe('check-disk');
      expect(step1?.command).toBe('df -h');

      expect(step2?.condition).toBe('steps.check-disk.exitCode === 0');

      expect(step3?.approval).toBe(true);
      expect(step3?.timeout).toBe(5000);
    });

    it('throws when the file does not exist', async () => {
      await expect(
        loadWorkflow(path.join(TMP, 'nonexistent-workflow.yaml'), { basePath: TMP }),
      ).rejects.toThrow('cannot read file');
    });

    it('throws on a step with an invalid id', async () => {
      const filePath = writeTmpYaml(
        'bad-id',
        `
name: bad-id-test
steps:
  - id: BAD ID!
    command: echo hi
`,
      );
      await expect(loadWorkflow(filePath, { basePath: TMP })).rejects.toThrow('Invalid step id');
    });

    it('throws when command contains forbidden chars', async () => {
      const filePath = writeTmpYaml(
        'injection',
        `
name: injection-test
steps:
  - id: evil
    command: echo hello | cat
`,
      );
      await expect(loadWorkflow(filePath, { basePath: TMP })).rejects.toThrow('forbidden characters');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Run a simple 2-step workflow (both succeed)
  // -------------------------------------------------------------------------
  it('runs a 2-step workflow where both steps succeed', async () => {
    spawnMock
      .mockImplementationOnce(() => makeSpawnMock('hello\n', '', 0) as ReturnType<typeof spawn>)
      .mockImplementationOnce(() => makeSpawnMock('world\n', '', 0) as ReturnType<typeof spawn>);

    const workflow = make2StepWorkflow();
    const state = await runWorkflow(workflow);

    expect(state.completedSteps).toHaveLength(2);
    expect(state.completedSteps[0]?.status).toBe('success');
    expect(state.completedSteps[0]?.stdout).toBe('hello\n');
    expect(state.completedSteps[1]?.status).toBe('success');
    expect(state.completedSteps[1]?.stdout).toBe('world\n');
    expect(state.pendingStepIndex).toBeUndefined();
    expect(state.resumeToken).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. stdin piping between steps  ({{prev}})
  // -------------------------------------------------------------------------
  it('pipes previous stdout as stdin when stdin is {{prev}}', async () => {
    spawnMock
      .mockImplementationOnce(
        () => makeSpawnMock('piped-output\n', '', 0) as ReturnType<typeof spawn>,
      )
      .mockImplementationOnce(
        () => makeSpawnMock('received\n', '', 0) as ReturnType<typeof spawn>,
      );

    const workflow: Workflow = {
      name: 'pipe-test',
      steps: [
        { id: 'producer', command: 'echo piped-output' },
        { id: 'consumer', command: 'cat', stdin: '{{prev}}' },
      ],
    };

    const state = await runWorkflow(workflow);

    expect(state.completedSteps).toHaveLength(2);
    expect(state.completedSteps[1]?.status).toBe('success');

    // Verify the second spawn call had stdin.write called with previous stdout
    const secondCall = spawnMock.mock.results[1]?.value as {
      stdin: { write: ReturnType<typeof vi.fn> };
    };
    expect(secondCall.stdin.write).toHaveBeenCalledWith('piped-output\n');
  });

  // -------------------------------------------------------------------------
  // 4. Condition skips a step when expression evaluates false
  // -------------------------------------------------------------------------
  it('skips a step when its condition evaluates to false', async () => {
    // The first step succeeds (exitCode=0).
    // The second step has condition `steps.always-ok.exitCode === 1` → false → skipped.
    spawnMock.mockImplementationOnce(
      () => makeSpawnMock('ok\n', '', 0) as ReturnType<typeof spawn>,
    );

    const workflow: Workflow = {
      name: 'condition-test',
      steps: [
        { id: 'always-ok', command: 'echo ok' },
        {
          id: 'conditional-skip',
          command: 'echo should-not-run',
          condition: 'steps.always-ok.exitCode === 1',
        },
      ],
    };

    const state = await runWorkflow(workflow);

    expect(state.completedSteps).toHaveLength(2);
    expect(state.completedSteps[0]?.status).toBe('success');
    expect(state.completedSteps[1]?.status).toBe('skipped');

    // spawn should only be called once (for always-ok)
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 5. Failing step halts the workflow
  // -------------------------------------------------------------------------
  it('halts the workflow when a step fails', async () => {
    spawnMock
      .mockImplementationOnce(
        () => makeSpawnMock('', 'command not found', 127) as ReturnType<typeof spawn>,
      );

    const workflow: Workflow = {
      name: 'halt-test',
      steps: [
        { id: 'fail-step', command: 'notacommand' },
        { id: 'should-not-run', command: 'echo never' },
      ],
    };

    const state = await runWorkflow(workflow);

    expect(state.completedSteps).toHaveLength(1);
    expect(state.completedSteps[0]?.status).toBe('failure');
    expect(state.completedSteps[0]?.exitCode).toBe(127);

    // Second step was never spawned
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 6. Approval gate pauses and produces a resumeToken; resuming continues
  // -------------------------------------------------------------------------
  describe('approval gate', () => {
    it('pauses with a resumeToken when approvalCallback returns false', async () => {
      spawnMock.mockImplementationOnce(
        () => makeSpawnMock('pre-approval\n', '', 0) as ReturnType<typeof spawn>,
      );

      const workflow: Workflow = {
        name: 'approval-test',
        steps: [
          { id: 'before', command: 'echo before' },
          { id: 'gated', command: 'echo gated', approval: true },
          { id: 'after', command: 'echo after' },
        ],
      };

      const state = await runWorkflow(workflow, {
        approvalCallback: async () => false,
      });

      // Should have completed 'before' and recorded 'gated' as awaiting_approval
      expect(state.completedSteps).toHaveLength(2);
      expect(state.completedSteps[0]?.status).toBe('success');
      expect(state.completedSteps[1]?.status).toBe('awaiting_approval');
      expect(state.resumeToken).toBeDefined();
      expect(typeof state.resumeToken).toBe('string');
      expect(state.pendingStepIndex).toBe(1);
      // pendingStepId is the stable resume anchor (id, not index).
      expect(state.pendingStepId).toBe('gated');

      // spawn was called only for 'before'
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it('resumes from saved state after approval and completes remaining steps', async () => {
      // Simulate a saved state after the approval pause
      const savedState: WorkflowRunState = {
        workflowName: 'approval-test',
        startedAt: new Date().toISOString(),
        completedSteps: [
          { id: 'before', status: 'success', stdout: 'pre-approval\n', exitCode: 0, durationMs: 5 },
          { id: 'gated', status: 'awaiting_approval', durationMs: 0 },
        ],
        pendingStepIndex: 1,
        resumeToken: 'test-resume-token-uuid',
      };

      const workflow: Workflow = {
        name: 'approval-test',
        steps: [
          { id: 'before', command: 'echo before' },
          { id: 'gated', command: 'echo gated', approval: true },
          { id: 'after', command: 'echo after' },
        ],
      };

      // approvalCallback now returns true
      spawnMock
        .mockImplementationOnce(
          () => makeSpawnMock('gated\n', '', 0) as ReturnType<typeof spawn>,
        )
        .mockImplementationOnce(
          () => makeSpawnMock('after\n', '', 0) as ReturnType<typeof spawn>,
        );

      const finalState = await runWorkflow(workflow, {
        resumeState: savedState,
        approvalCallback: async () => true,
      });

      // Should have run 'gated' and 'after' (resumed from index 1). The stale
      // 'awaiting_approval' placeholder for 'gated' is dropped on resume, so the
      // final set is the real results only: before(success) + gated + after,
      // with no duplicate 'gated' entry.
      expect(finalState.completedSteps).toHaveLength(3);
      expect(finalState.completedSteps[0]?.id).toBe('before');
      expect(finalState.completedSteps[1]?.id).toBe('gated');
      expect(finalState.completedSteps[1]?.status).toBe('success');
      expect(finalState.completedSteps[2]?.id).toBe('after');
      expect(finalState.completedSteps[2]?.status).toBe('success');
      expect(finalState.resumeToken).toBeUndefined();
      expect(finalState.pendingStepIndex).toBeUndefined();
    });

    it('pauses immediately (no approvalCallback) when approval is required', async () => {
      spawnMock.mockImplementationOnce(
        () => makeSpawnMock('ok\n', '', 0) as ReturnType<typeof spawn>,
      );

      const workflow: Workflow = {
        name: 'no-callback-test',
        steps: [
          { id: 'first', command: 'echo first' },
          { id: 'needs-approval', command: 'echo upload', approval: true },
        ],
      };

      const state = await runWorkflow(workflow, {}); // no approvalCallback

      expect(state.resumeToken).toBeDefined();
      expect(state.pendingStepIndex).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Security: interpreter commands are rejected
  // -------------------------------------------------------------------------
  describe('security validation', () => {
    it('rejects a step whose command binary is a shell interpreter (bash)', () => {
      expect(() =>
        validateStep({ id: 'evil', command: 'bash -c "rm -rf /"' }),
      ).toThrow('interpreter commands are not allowed');
    });

    it('rejects a step whose command binary is a shell interpreter (python3)', () => {
      expect(() =>
        validateStep({ id: 'evil', command: 'python3 /tmp/exploit.py' }),
      ).toThrow('interpreter commands are not allowed');
    });

    it('rejects stdin containing $( command substitution', () => {
      expect(() =>
        validateStep({ id: 'step', command: 'cat', stdin: '$(whoami)' }),
      ).toThrow('stdin contains forbidden characters');
    });

    it('rejects stdin containing backtick command substitution', () => {
      expect(() =>
        validateStep({ id: 'step', command: 'cat', stdin: '`id`' }),
      ).toThrow('stdin contains forbidden characters');
    });

    it('allows stdin with the {{prev}} placeholder', () => {
      // Must not throw — {{prev}} is the only special placeholder
      expect(() =>
        validateStep({ id: 'step', command: 'cat', stdin: '{{prev}}' }),
      ).not.toThrow();
    });

    // -----------------------------------------------------------------------
    // stdout truncation (simulated with small cap via custom mock)
    // -----------------------------------------------------------------------
    it('truncates output and kills the child when stdout exceeds MAX_OUTPUT', async () => {
      // Build a mock that emits a 10MB + 1 byte buffer so the cap triggers
      const OVER_CAP = 10 * 1024 * 1024 + 1;
      const hugeBuf = Buffer.alloc(OVER_CAP, 'x');

      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn() };

      const child = new EventEmitter() as NodeJS.EventEmitter & {
        stdout: typeof stdoutEmitter;
        stderr: typeof stderrEmitter;
        stdin: typeof stdinMock;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = stdoutEmitter;
      child.stderr = stderrEmitter;
      child.stdin = stdinMock;
      // kill() is a no-op mock — we must manually emit 'close' after kill is called
      child.kill = vi.fn().mockImplementation(() => {
        // Simulate the OS sending SIGTERM and the process exiting
        setImmediate(() => child.emit('close', 0));
      });

      spawnMock.mockImplementationOnce(() => child as ReturnType<typeof spawn>);

      // Schedule data emission after execShell attaches listeners
      setImmediate(() => {
        stdoutEmitter.emit('data', hugeBuf);
      });

      const result = await execShell('echo x');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result.stderr).toContain('[stream truncated at 10MB]');
      expect(result.exitCode).toBe(124);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Tool-type steps (gap #24 — dispatched via an injected toolExecutor)
  // -------------------------------------------------------------------------
  describe('tool steps', () => {
    it('runs a tool step via the injected toolExecutor and records the real outcome', async () => {
      const toolExecutor: ToolStepExecutor = vi.fn(async () => ({ success: true, stdout: 'TOOL_OUT' }));

      const workflow: Workflow = {
        name: 'tool-wf',
        steps: [{ id: 'call', command: 'coder.read-file', type: 'tool', stdin: '{"path":"/x"}' }],
      };

      const state = await runWorkflow(workflow, { toolExecutor });

      expect(toolExecutor).toHaveBeenCalledTimes(1);
      expect(state.completedSteps).toHaveLength(1);
      expect(state.completedSteps[0]?.status).toBe('success');
      expect(state.completedSteps[0]?.stdout).toBe('TOOL_OUT');
      expect(state.completedSteps[0]?.exitCode).toBe(0);
      // A tool step must never touch the shell.
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('fails HONESTLY when a tool step has no toolExecutor (no fake success)', async () => {
      // Regression: the pre-wiring engine returned status:'success' with empty
      // output for tool steps. It must now fail honestly and halt.
      const workflow: Workflow = {
        name: 'tool-nowire',
        steps: [
          { id: 'call', command: 'coder.read-file', type: 'tool' },
          { id: 'after', command: 'echo never' },
        ],
      };

      const state = await runWorkflow(workflow); // no toolExecutor

      expect(state.completedSteps).toHaveLength(1);
      expect(state.completedSteps[0]?.status).toBe('failure');
      expect(state.completedSteps[0]?.exitCode).toBe(1);
      expect(state.completedSteps[0]?.stderr).toContain('tool executor');
      // The honest failure halts the workflow — 'after' never runs.
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('halts the workflow when a tool step reports failure', async () => {
      const toolExecutor: ToolStepExecutor = vi.fn(async () => ({ success: false, stderr: 'boom' }));

      const workflow: Workflow = {
        name: 'tool-fail',
        steps: [
          { id: 'call', command: 'coder.write-file', type: 'tool' },
          { id: 'after', command: 'echo never', type: 'tool' },
        ],
      };

      const state = await runWorkflow(workflow, { toolExecutor });

      expect(state.completedSteps).toHaveLength(1);
      expect(state.completedSteps[0]?.status).toBe('failure');
      expect(state.completedSteps[0]?.stderr).toBe('boom');
      expect(toolExecutor).toHaveBeenCalledTimes(1); // 'after' never dispatched
    });

    it('pipes {{prev}} stdout into a tool step as resolvedStdin', async () => {
      const seen: Array<string | undefined> = [];
      const toolExecutor: ToolStepExecutor = vi.fn(async (_step, resolvedStdin) => {
        seen.push(resolvedStdin);
        return { success: true, stdout: 'producer-out' };
      });

      const workflow: Workflow = {
        name: 'tool-pipe',
        steps: [
          { id: 'producer', command: 'data.make', type: 'tool' },
          { id: 'consumer', command: 'data.take', type: 'tool', stdin: '{{prev}}' },
        ],
      };

      await runWorkflow(workflow, { toolExecutor });

      expect(seen[0]).toBeUndefined();      // producer had no stdin
      expect(seen[1]).toBe('producer-out'); // consumer received the previous stdout
    });

    it('records a failure when the toolExecutor throws', async () => {
      const toolExecutor: ToolStepExecutor = vi.fn(async () => {
        throw new Error('kaboom');
      });

      const workflow: Workflow = {
        name: 'tool-throw',
        steps: [{ id: 'call', command: 'x.y', type: 'tool' }],
      };

      const state = await runWorkflow(workflow, { toolExecutor });

      expect(state.completedSteps[0]?.status).toBe('failure');
      expect(state.completedSteps[0]?.stderr).toContain('kaboom');
    });

    it('validateStep exempts tool-step stdin from the shell-metachar guard but not shell steps', () => {
      // Tool stdin is JSON args handed to a host tool — it never reaches a shell.
      expect(() =>
        validateStep({
          id: 'tool',
          command: 'coder.write-file',
          type: 'tool',
          stdin: '{"content":"a > b & c"}',
        }),
      ).not.toThrow();
      // The same stdin on a shell step is still rejected.
      expect(() =>
        validateStep({ id: 'sh', command: 'cat', stdin: '{"content":"a > b & c"}' }),
      ).toThrow('stdin contains forbidden characters');
    });
  });
});
