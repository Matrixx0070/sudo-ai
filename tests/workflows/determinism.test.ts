/**
 * @file determinism.test.ts
 * @description AL2.2 — the workflow engine's CONTROL FLOW is deterministic:
 * given identical step outputs, two runs of the same workflow (conditions,
 * skips, fan-out) produce identical traces after stripping wall-clock fields
 * (durationMs, startedAt, runId — inherently volatile, documented as such).
 * Step outputs are keyed by argv, not call order, so fan-out scheduling
 * nondeterminism cannot mask a control-flow divergence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { runWorkflow } from '../../src/core/workflows/lobster.js';
import type { Workflow, WorkflowRunState } from '../../src/core/workflows/lobster.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
import * as childProcess from 'child_process';
const spawnMock = vi.mocked(childProcess.spawn);

function fakeChild(stdout: string, exitCode = 0) {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const child = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  setImmediate(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode);
  });
  return child;
}

/** Deterministic outputs keyed by argv content — call ORDER must not matter. */
const OUTPUTS: Record<string, { stdout: string; exitCode: number }> = {
  check: { stdout: 'ok\n', exitCode: 0 },
  alpha: { stdout: 'A\n', exitCode: 0 },
  beta: { stdout: 'B\n', exitCode: 0 },
  final: { stdout: 'done\n', exitCode: 0 },
};

const WORKFLOW: Workflow = {
  name: 'determinism-test',
  steps: [
    { id: 'check', command: 'echo check' },
    // Runs — condition true against check's exit code.
    { id: 'alpha', command: 'echo alpha', parallel_group: 'fan', condition: 'steps.check.exitCode === 0' },
    { id: 'beta', command: 'echo beta', parallel_group: 'fan' },
    // Skipped — condition false every run.
    { id: 'never', command: 'echo never', condition: 'steps.check.exitCode !== 0' },
    { id: 'final', command: 'echo final' },
  ],
};

/** Strip the documented-volatile fields so the residue must be identical. */
function normalize(state: WorkflowRunState): unknown {
  return {
    workflowName: state.workflowName,
    resumeToken: state.resumeToken ?? null,
    pendingStepIndex: state.pendingStepIndex ?? null,
    steps: state.completedSteps.map((s) => ({
      id: s.id,
      status: s.status,
      stdout: s.stdout ?? null,
      stderr: s.stderr ?? null,
      exitCode: s.exitCode ?? null,
    })),
  };
}

async function runOnce(): Promise<unknown> {
  spawnMock.mockReset();
  spawnMock.mockImplementation(((_cmd: string, args: readonly string[]) => {
    const key = args[args.length - 1] ?? '';
    const spec = OUTPUTS[key];
    if (!spec) throw new Error(`unexpected spawn args: ${JSON.stringify(args)}`);
    return fakeChild(spec.stdout, spec.exitCode) as unknown as ReturnType<typeof spawn>;
  }) as never);
  const state = await runWorkflow(WORKFLOW, { maxParallel: 2 });
  return normalize(state);
}

describe('AL2.2 — control-flow determinism', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('two runs with identical step outputs produce byte-identical normalized traces', async () => {
    const first = await runOnce();
    const second = await runOnce();
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // ordering too
  });

  it('the trace has the expected deterministic shape (conditions + skip + fan-out)', async () => {
    const trace = (await runOnce()) as { steps: Array<{ id: string; status: string }> };
    expect(trace.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      'check:success',
      'alpha:success',
      'beta:success',
      'never:skipped',
      'final:success',
    ]);
  });
});
