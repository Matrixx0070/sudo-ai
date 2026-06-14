/**
 * @file workflows/queue.ts
 * @description Cross-workflow scheduler — slice 4 of gap #24.
 *
 * Wires the orchestration/ TaskQueue + TaskExecutor (slice 4) as a persistent,
 * crash-safe scheduler for workflow runs. While slices 2 + 3 fan out within
 * ONE workflow run, this module lets the brain enqueue MANY workflow runs that
 * execute concurrently in the background — bounded by a per-process
 * `maxConcurrent` cap, persisted to `<DATA_DIR>/mind.db`, and resumable across
 * process restarts via the SHA-256 resume journal slice 2 introduced.
 *
 * Trust posture: queued runs auto-approve internal `approval: true` gates,
 * because there is no operator-present resume path once a run is dispatched
 * asynchronously. The enqueue tool (`meta.enqueue-workflow`) refuses to enqueue
 * a workflow that contains approval gates unless the caller explicitly sets
 * `auto_approve: true` — same trust contract as `meta.run-workflow` plus the
 * extra refusal.
 *
 * TOCTOU integrity: the SHA-256 of the workflow source is computed at enqueue
 * time and stored in the task payload. When the handler dispatches, it
 * re-reads the file, re-computes the SHA, and refuses to run if it has changed
 * since enqueue — closes the file-swap window between enqueue and dispatch.
 *
 * Concurrency model:
 *   - TaskQueue.maxConcurrent caps the number of workflow runs in flight.
 *   - Each workflow run still uses SUDO_WORKFLOWS_MAX_PARALLEL for ITS own
 *     intra-workflow fan-out (parallel_group / phase). The two caps multiply:
 *     up to N workflows × M intra-workflow members concurrent.
 *
 * Cancellation: AbortSignal honored at the next executeStep boundary is a
 * slice-5 concern. Today, when TaskExecutor.timeoutMs fires, the queue slot is
 * reclaimed and onFail is called, but the in-flight runWorkflow keeps running
 * until it naturally settles (best-effort). The executor's TaskQueue.complete
 * is guarded against double-call, so honest state is preserved — but a
 * long-running queued workflow can outlive its task-timeout window.
 *
 * Opt-in: cli.ts initializes the WorkflowQueue only when SUDO_WORKFLOWS_QUEUE=1.
 * When the flag is off, neither the executor nor the enqueue tool exists.
 */

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TaskQueue, type EnqueueInput, type TaskPriority } from '../orchestration/task-queue.js';
import { TaskExecutor, type TaskHandler } from '../orchestration/executor.js';
import { loadWorkflow, runWorkflow } from './lobster.js';
import type { Workflow, WorkflowRunState, WorkflowStep } from './lobster.js';
import { createLogger } from '../shared/logger.js';
import { WORKSPACE_DIR, DATA_DIR } from '../shared/paths.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolStepExecutor, ToolStepResult } from './lobster.js';
import type { ToolContext } from '../tools/types.js';

const log = createLogger('workflow-queue');

const WORKFLOWS_BASE = path.join(WORKSPACE_DIR, 'workflows');
const DEFAULT_JOURNAL_DIR = path.join(DATA_DIR, 'workflow-runs');

/** Name registered with TaskExecutor for the workflow handler. Exact match. */
export const WORKFLOW_TASK_NAME = 'workflow.run';

/** Hex SHA-256 of the workflow source bytes (mirrors meta.run-workflow). */
function sha256(buf: string): string {
  return createHash('sha256').update(buf, 'utf8').digest('hex');
}

/**
 * Shape of a `workflow.run` task's payload. JSON-serializable.
 *
 * `file` is resolved against WORKFLOWS_BASE if relative; loadWorkflow re-checks
 * confinement. `autoApprove` is mandatory in the queued case: the executor
 * has no operator-present approval path. `runId` and `journalDir` mirror the
 * meta.run-workflow params; both are optional. `sourceSha256` is the hash of
 * the workflow source at ENQUEUE time — the handler verifies the file on disk
 * still matches before running, closing the TOCTOU window where a file swap
 * between enqueue + dispatch would otherwise bypass the enqueue-time
 * validation (path confinement, approval-gate refusal, YAML parse).
 */
export interface WorkflowTaskPayload {
  file: string;
  autoApprove: boolean;
  sourceSha256: string;
  runId?: string;
  journalDir?: string;
}

/** Structural guard for a task payload coming back from SQLite. */
function isWorkflowTaskPayload(v: unknown): v is WorkflowTaskPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p['file'] === 'string' &&
    typeof p['autoApprove'] === 'boolean' &&
    typeof p['sourceSha256'] === 'string'
  );
}

/** Options accepted by {@link enqueueWorkflow}. */
export interface EnqueueWorkflowOptions {
  /** Workflow file path (relative resolves under workflows/, absolute must lie inside). */
  file: string;
  /** Auto-approve internal `approval: true` step gates. Required for queued runs. */
  autoApprove?: boolean;
  /** Optional priority forwarded to TaskQueue. Default 'normal'. */
  priority?: TaskPriority;
  /** Optional dependency task ids forwarded to TaskQueue. */
  dependsOn?: string[];
  /** Optional maxRetries forwarded to TaskQueue. Default 0 (workflows are not idempotent). */
  maxRetries?: number;
  /** Per-run timeout in ms forwarded to TaskQueue. Default 30 minutes. */
  timeoutMs?: number;
  /** Optional journal directory override. */
  journalDir?: string;
  /** Optional pre-minted runId (mostly for testing + journal-filename continuity). */
  runId?: string;
  /** Operator-supplied human description, surfaces in `meta.task-manager list`. */
  description?: string;
  /** Free-text createdBy attribution. Default 'system'. */
  createdBy?: string;
}

/** Result of an enqueue call. */
export interface EnqueueWorkflowResult {
  taskId: string;
  runId: string;
  workflowName: string;
  status: 'queued' | 'blocked';
}

/**
 * Build the `ToolStepExecutor` the engine uses for `type: 'tool'` steps inside
 * a queued workflow run. Identical contract to the one in
 * meta.run-workflow.execute(), so workflows behave the same when run sync or
 * queued. Tool steps still go through `registry.execute()` with the same
 * permission/sandbox/plan-mode gates — the queue is NOT a privileged bypass.
 *
 * Self-recursion check matches meta.run-workflow's: both `meta.run-workflow`
 * and bare `run-workflow` (Ollama strips dotted prefixes) are blocked.
 * `meta.enqueue-workflow` and bare `enqueue-workflow` are blocked too so a
 * queued run cannot re-enqueue itself into an infinite loop.
 */
function buildToolExecutor(registry: ToolRegistry, ctx: ToolContext): ToolStepExecutor {
  return async (step: WorkflowStep, resolvedStdin: string | undefined): Promise<ToolStepResult> => {
    const toolName = step.command.trim();
    if (
      toolName === 'meta.run-workflow' ||
      toolName === 'run-workflow' ||
      toolName === 'meta.enqueue-workflow' ||
      toolName === 'enqueue-workflow'
    ) {
      return { success: false, stderr: 'workflow tools cannot invoke themselves inside a queued run' };
    }

    let args: Record<string, unknown> = {};
    if (resolvedStdin !== undefined && resolvedStdin.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(resolvedStdin);
      } catch {
        return {
          success: false,
          stderr: `tool step "${step.id}": stdin must be a JSON object of tool args`,
        };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          success: false,
          stderr: `tool step "${step.id}": stdin JSON must be an object of tool args`,
        };
      }
      args = parsed as Record<string, unknown>;
    }

    try {
      const res = await registry.execute(toolName, args, ctx);
      return { success: res.success, stdout: res.output, stderr: res.success ? '' : res.output };
    } catch (err) {
      return { success: false, stderr: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * Read the SUDO_WORKFLOWS_MAX_PARALLEL env at handler execution time so a
 * queued run picks up env changes between enqueue and dispatch. Mirrors the
 * read pattern in meta/run-workflow.ts.
 */
function readMaxParallel(): number {
  const raw = process.env['SUDO_WORKFLOWS_MAX_PARALLEL'];
  if (!raw) return 4;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 4;
}

/** Resolve, read, and SHA-fingerprint a workflow file. */
async function loadSource(file: string): Promise<{ resolved: string; sourceText: string; sourceHash: string }> {
  const resolved = path.isAbsolute(file) ? file : path.join(WORKFLOWS_BASE, file);
  const sourceText = await readFile(resolved, 'utf8');
  return { resolved, sourceText, sourceHash: sha256(sourceText) };
}

/** Confine an absolute journal_dir to DATA_DIR or WORKSPACE_DIR (mirrors meta.run-workflow). */
function confineJournalDir(dir: string | undefined): string | undefined {
  if (dir === undefined) return DEFAULT_JOURNAL_DIR;
  if (!path.isAbsolute(dir)) {
    throw new Error(`journal_dir must be absolute (got "${dir}")`);
  }
  const normalized = path.resolve(dir);
  const dataRoot = path.resolve(DATA_DIR);
  const workspaceRoot = path.resolve(WORKSPACE_DIR);
  const insideData =
    normalized === dataRoot || normalized.startsWith(dataRoot + path.sep);
  const insideWorkspace =
    normalized === workspaceRoot || normalized.startsWith(workspaceRoot + path.sep);
  if (!insideData && !insideWorkspace) {
    throw new Error(`journal_dir "${dir}" must be inside DATA_DIR or WORKSPACE_DIR`);
  }
  return normalized;
}

/**
 * Build the TaskExecutor handler that runs a queued workflow.
 *
 * Per-handler semantics:
 *   - Reads the file fresh at execution time (workflow may have been moved or
 *     deleted between enqueue and dispatch); fail honestly on read error.
 *   - SHA-fingerprints the source for the resume journal.
 *   - approvalCallback returns true unconditionally — queued runs auto-approve.
 *     The enqueue tool refuses to enqueue workflows that contain approval gates
 *     unless the caller acknowledged auto_approve at enqueue time.
 *   - Honors the AbortSignal cooperatively: signal.aborted halts the run at
 *     the next executeStep boundary (execShell child kill is best-effort; the
 *     engine itself does not yet plumb a cancel signal — slice 5 work).
 */
function buildWorkflowHandler(registry: ToolRegistry, ctx: ToolContext): TaskHandler {
  return async (task, signal) => {
    if (!isWorkflowTaskPayload(task.payload)) {
      throw new Error(`task ${task.id} payload is not a WorkflowTaskPayload`);
    }
    const payload = task.payload;

    const { resolved, sourceHash } = await loadSource(payload.file);

    // TOCTOU close: refuse to run if the workflow file changed since enqueue.
    // The enqueue-time validation (path confinement, YAML parse, approval-gate
    // refusal) is bound to the hash recorded in the payload; a swap would
    // bypass those checks. SHA mismatch is fatal — operator can re-enqueue
    // after they've reviewed the new file via meta.run-workflow.
    if (sourceHash !== payload.sourceSha256) {
      throw new Error(
        `workflow source SHA-256 changed between enqueue and dispatch ` +
          `(payload=${payload.sourceSha256.slice(0, 12)}…, current=${sourceHash.slice(0, 12)}…) — ` +
          're-enqueue after reviewing the modified file',
      );
    }

    const workflow: Workflow = await loadWorkflow(resolved);

    let journalDir: string | undefined;
    try {
      journalDir = confineJournalDir(payload.journalDir);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }

    const runId = payload.runId ?? task.id;
    const journalPath = journalDir ? path.join(journalDir, `${runId}.json`) : undefined;

    log.info(
      {
        taskId: task.id,
        workflow: workflow.name,
        runId,
        file: resolved,
        steps: workflow.steps.length,
      },
      'Dispatching queued workflow',
    );

    if (signal.aborted) {
      throw new Error('workflow aborted before dispatch');
    }

    const toolExecutor = buildToolExecutor(registry, ctx);
    const approvalCallback = async (): Promise<boolean> => true;

    // signal is checked once before dispatch; the engine itself has no
    // cancel hook so a mid-run abort cannot interrupt runWorkflow. See the
    // file header "Cancellation" note — slice-5 concern.

    const finalState: WorkflowRunState = await runWorkflow(workflow, {
      toolExecutor,
      approvalCallback,
      maxParallel: readMaxParallel(),
      runId,
      ...(journalPath ? { journalPath } : {}),
      sourceSha256: sourceHash,
    });

    const paused = finalState.resumeToken !== undefined;
    const failed = finalState.completedSteps.some((s) => s.status === 'failure');

    // A paused queued run is a hard error: queued runs auto-approve, so the
    // only way to reach this state is a bug in approval gating. We surface the
    // run state in the error so the operator can inspect via task-manager.get.
    if (paused) {
      throw new Error(
        `queued workflow paused unexpectedly at step ${finalState.pendingStepId ?? '<unknown>'} ` +
          '(queued runs auto-approve — this indicates a gating bug)',
      );
    }
    if (failed) {
      // TaskQueue.fail() will retry per maxRetries; for workflows the default
      // is 0 (non-idempotent), so a failure is terminal unless the caller
      // explicitly raised maxRetries.
      throw new Error(
        `workflow "${workflow.name}" halted on a failing step (runId ${runId}; ` +
          `see journal at ${journalPath ?? '<disabled>'})`,
      );
    }

    return {
      workflowName: workflow.name,
      runId,
      completedSteps: finalState.completedSteps.length,
      journalPath,
      sourceSha256Prefix: sourceHash.slice(0, 12),
    };
  };
}

// ---------------------------------------------------------------------------
// WorkflowQueue — singleton wrapper around TaskQueue + TaskExecutor
// ---------------------------------------------------------------------------

/** Options accepted by {@link initWorkflowQueue}. */
export interface InitWorkflowQueueOptions {
  /** Path to the SQLite database. Defaults to MIND_DB. */
  dbPath?: string;
  /** Max concurrent workflow runs. Default 2 (workflows are heavyweight). */
  maxConcurrent?: number;
  /** Executor poll interval in ms. Default 5000. Minimum 100 (TaskExecutor caps). */
  pollIntervalMs?: number;
  /** Registry used by `type: 'tool'` steps inside queued workflows. */
  registry: ToolRegistry;
  /** Tool context used for queued tool-step dispatch. */
  ctx: ToolContext;
}

/** Public WorkflowQueue surface — returned by initWorkflowQueue, also used by tools/tests. */
export interface WorkflowQueue {
  /** Underlying TaskQueue (exposed so `meta.task-manager` can still introspect). */
  readonly taskQueue: TaskQueue;
  /** Underlying TaskExecutor (exposed for tests; cli should not poke). */
  readonly executor: TaskExecutor;
  /** Enqueue a workflow. Returns the assigned task id + minted runId. */
  enqueueWorkflow(opts: EnqueueWorkflowOptions): Promise<EnqueueWorkflowResult>;
  /** Stop the executor and close the DB. Idempotent. */
  shutdown(): void;
}

let _singleton: WorkflowQueue | null = null;

/**
 * @internal Test-only: drop the singleton so a fresh init runs cleanly.
 * Importing this from production code is a bug — the singleton is meant to
 * live for the process lifetime once cli.ts initializes it.
 */
export function _resetWorkflowQueueForTests(): void {
  if (_singleton) {
    try {
      _singleton.shutdown();
    } catch {
      // ignore — best effort during teardown
    }
  }
  _singleton = null;
}

/** Returns the live WorkflowQueue if initialized; null otherwise. */
export function getWorkflowQueue(): WorkflowQueue | null {
  return _singleton;
}

/**
 * Initialize the singleton WorkflowQueue. Idempotent — subsequent calls return
 * the existing instance (cli.ts boots this once per process). Call site is
 * responsible for shutdown on process exit; we don't auto-wire SIGTERM so
 * tests can manage lifecycle explicitly.
 */
export function initWorkflowQueue(opts: InitWorkflowQueueOptions): WorkflowQueue {
  if (_singleton) {
    log.warn('initWorkflowQueue called twice — returning existing instance');
    return _singleton;
  }

  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2);
  const pollIntervalMs = Math.max(100, opts.pollIntervalMs ?? 5_000);

  // Note: MIND_DB is a singleton SQLite file shared with meta.task-manager
  // and other writers. better-sqlite3 supports multiple connections to the
  // same WAL database within a process; the schema init is idempotent.
  const dbPath = opts.dbPath ?? path.join(DATA_DIR, 'mind.db');
  const taskQueue = new TaskQueue(dbPath, maxConcurrent);

  const handler = buildWorkflowHandler(opts.registry, opts.ctx);

  const executor = new TaskExecutor(taskQueue, {
    pollIntervalMs,
    onComplete: (task, result, durationMs) => {
      log.info(
        { taskId: task.id, name: task.name, durationMs, result },
        'Queued workflow completed',
      );
    },
    onFail: (task, error) => {
      log.warn({ taskId: task.id, name: task.name, error }, 'Queued workflow failed permanently');
    },
  });
  executor.registerHandler(WORKFLOW_TASK_NAME, handler);
  executor.start();

  log.info(
    { dbPath, maxConcurrent, pollIntervalMs },
    'WorkflowQueue initialized',
  );

  const enqueueWorkflow = async (input: EnqueueWorkflowOptions): Promise<EnqueueWorkflowResult> => {
    if (!input.file?.trim()) {
      throw new Error('enqueueWorkflow: file is required');
    }

    // Load + validate the workflow at enqueue time so callers get an honest
    // error NOW rather than discovering a malformed YAML hours later in a
    // background task failure. The SHA is captured here AND persisted into
    // the payload so the handler can detect a file swap between enqueue and
    // dispatch (TOCTOU close).
    const { resolved, sourceHash } = await loadSource(input.file);
    const workflow = await loadWorkflow(resolved);

    // Refuse to enqueue a workflow with approval gates unless caller opted in.
    // Queued runs have no operator-present resume path. A flat scan suffices:
    // validateStep (executor.ts) rejects `approval: true` inside any fan-out
    // member (parallel_group or phase), so the engine schema guarantees
    // approval steps only live at the top level of `steps[]`.
    const hasApprovalGate = workflow.steps.some((s) => s.approval === true);
    if (hasApprovalGate && input.autoApprove !== true) {
      throw new Error(
        `workflow "${workflow.name}" contains approval: true steps — ` +
          'enqueueWorkflow requires autoApprove: true for such workflows (queued runs cannot pause for operator input)',
      );
    }

    const runId = input.runId ?? randomUUID();
    const journalDirNorm = confineJournalDir(input.journalDir);

    const payload: WorkflowTaskPayload = {
      file: input.file,
      autoApprove: input.autoApprove === true,
      sourceSha256: sourceHash,
      runId,
      ...(journalDirNorm !== undefined ? { journalDir: journalDirNorm } : {}),
    };

    const enqueueInput: EnqueueInput = {
      name: WORKFLOW_TASK_NAME,
      description: input.description ?? `workflow:${workflow.name}`,
      priority: input.priority ?? 'normal',
      dependsOn: input.dependsOn ?? [],
      payload,
      // Default 0 retries: most workflows are NOT idempotent (file writes, tool
      // calls with side effects). Authors who designed for idempotency can opt
      // in to retries explicitly.
      maxRetries: input.maxRetries ?? 0,
      // Default 30 minutes per run — long enough for serious work, short
      // enough to flag a stuck handler. Operator can override.
      timeoutMs: input.timeoutMs ?? 30 * 60 * 1_000,
      createdBy: input.createdBy ?? 'system',
    };

    const taskId = taskQueue.enqueue(enqueueInput);
    const status: 'queued' | 'blocked' =
      (input.dependsOn?.length ?? 0) > 0 ? 'blocked' : 'queued';

    log.info(
      { taskId, runId, workflow: workflow.name, status, priority: enqueueInput.priority },
      'Workflow enqueued',
    );

    return { taskId, runId, workflowName: workflow.name, status };
  };

  const shutdown = (): void => {
    try {
      executor.stop();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'executor.stop threw');
    }
    try {
      taskQueue.close();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'taskQueue.close threw');
    }
  };

  _singleton = { taskQueue, executor, enqueueWorkflow, shutdown };
  return _singleton;
}
