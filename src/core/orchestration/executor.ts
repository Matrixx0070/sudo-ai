/**
 * TaskExecutor — pulls tasks from the TaskQueue and runs them.
 *
 * Features:
 *   - Handler registry: map task name prefixes or exact names to async functions
 *   - Poll loop: checks for ready tasks every pollIntervalMs
 *   - Per-task AbortController + setTimeout for hard timeout enforcement
 *   - Retries delegated to TaskQueue.fail() (exponential backoff is caller-managed)
 *   - Circuit-breaker: tasks with no registered handler go to failed immediately
 *   - Parallel execution up to queue.maxConcurrent
 *
 * RULES:
 *   - Never mutates the queue directly except via queue.complete() / queue.fail()
 *   - All handlers receive an AbortSignal — must honour it for long-running I/O
 */

import { createLogger } from '../shared/logger.js';
import { TaskQueue, type Task } from './task-queue.js';
import { hasCommittedOutbound } from '../agent/committed-outbound.js';

const logger = createLogger('task-executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskHandler = (task: Task, signal: AbortSignal) => Promise<unknown>;

export interface ExecutorOptions {
  /** How often (ms) to poll the queue for new tasks. Default: 5000 */
  pollIntervalMs?: number;
  /** Called when a task completes — useful for metrics / notification. */
  onComplete?: (task: Task, result: unknown, durationMs: number) => void;
  /** Called when a task fails permanently (retries exhausted). */
  onFail?: (task: Task, error: string) => void;
}

// ---------------------------------------------------------------------------
// TaskExecutor
// ---------------------------------------------------------------------------

export class TaskExecutor {
  private readonly handlers: Map<string, TaskHandler> = new Map();
  private readonly running: Map<string, AbortController> = new Map();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly queue: TaskQueue,
    private readonly options: ExecutorOptions = {},
  ) {}

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------

  /**
   * Register a handler for a task name or name prefix.
   *
   * Resolution order on execution:
   *  1. Exact match on task.name
   *  2. Prefix match: handler key ends with '*' and task.name starts with key.slice(0,-1)
   *
   * @param taskType - Exact name or prefix pattern (e.g. 'pipeline.*')
   * @param handler  - Async function that receives (task, abortSignal)
   */
  registerHandler(taskType: string, handler: TaskHandler): void {
    if (!taskType?.trim()) throw new TypeError('registerHandler: taskType must be non-empty');
    if (typeof handler !== 'function') throw new TypeError('registerHandler: handler must be a function');
    this.handlers.set(taskType, handler);
    logger.info({ taskType }, 'Handler registered');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the poll loop. Idempotent — calling again while running is a no-op.
   */
  start(pollIntervalMs?: number): void {
    if (this.intervalHandle !== null) {
      logger.warn('TaskExecutor.start() called while already running — ignored');
      return;
    }

    this.stopped = false;
    const interval = pollIntervalMs ?? this.options.pollIntervalMs ?? 5_000;

    if (interval < 100) throw new RangeError('pollIntervalMs must be >= 100');

    logger.info({ interval }, 'TaskExecutor started');

    // Run once immediately, then on interval
    this._tick().catch(err => logger.error({ err: String(err) }, 'Executor tick error'));

    this.intervalHandle = setInterval(() => {
      if (this.stopped) return;
      this._tick().catch(err => logger.error({ err: String(err) }, 'Executor tick error'));
    }, interval);
  }

  /**
   * Stop the poll loop. In-flight tasks continue until they settle.
   * Call queue.close() separately when you want to shut down the DB.
   */
  stop(): void {
    this.stopped = true;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    // Abort all running tasks
    for (const [id, controller] of this.running.entries()) {
      logger.info({ id }, 'Aborting running task on executor stop');
      controller.abort();
    }

    logger.info({ aborted: this.running.size }, 'TaskExecutor stopped');
  }

  // ---------------------------------------------------------------------------
  // Poll tick
  // ---------------------------------------------------------------------------

  private async _tick(): Promise<void> {
    // Drain as many tasks as the concurrency window allows
    let next: Task | null;

    while ((next = this.queue.dequeue()) !== null) {
      // Capture per-iteration. The .catch() below runs ASYNChronously — after the
      // loop has advanced and, on exit, reassigned the shared variable to null.
      // Closing over a shared `let task` would make the catch read `null.id` and
      // throw an *unhandled* rejection (the very bug this comment guards). A
      // block-scoped const binds each catch to its own task.
      const task = next;
      // Don't await — run tasks in parallel up to maxConcurrent.
      this._executeTask(task).catch(err =>
        logger.error({ taskId: task.id, err: String(err) }, 'Unexpected executor error'),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Single task execution
  // ---------------------------------------------------------------------------

  private async _executeTask(task: Task): Promise<void> {
    const handler = this._resolveHandler(task.name);

    if (!handler) {
      const msg = `No handler registered for task type "${task.name}"`;
      logger.error({ id: task.id, name: task.name }, msg);
      this.queue.fail(task.id, msg);
      return;
    }

    const controller = new AbortController();
    this.running.set(task.id, controller);

    const startMs = Date.now();

    // Hard timeout: abort + fail if handler does not resolve in time
    const timeoutHandle = setTimeout(() => {
      if (this.running.has(task.id)) {
        controller.abort();
        const msg = `Task timed out after ${task.timeoutMs}ms`;
        logger.warn({ id: task.id, name: task.name, timeoutMs: task.timeoutMs }, msg);
        // A run that sent before timing out must not be auto-requeued.
        if (hasCommittedOutbound(task.id)) this.queue.markCommittedOutbound(task.id);
        this.queue.fail(task.id, msg);
        this.running.delete(task.id);

        // Notify only if retries are exhausted (mirrors catch-block behavior)
        const updated = this.queue.getTask(task.id);
        if (updated?.status === 'failed') {
          this.options.onFail?.(task, msg);
        }
      }
    }, task.timeoutMs);

    try {
      logger.info({ id: task.id, name: task.name, priority: task.priority }, 'Executing task');

      const result = await handler(task, controller.signal);
      clearTimeout(timeoutHandle);

      if (!this.running.has(task.id)) {
        // Timeout fired before handler resolved — do nothing (already failed)
        return;
      }

      const durationMs = Date.now() - startMs;
      // Stamp outbound evidence (from the run result, or the session registry keyed
      // by task.id) so any later manual retry / retryFailed is gated.
      if ((result as { committedOutbound?: boolean } | null)?.committedOutbound || hasCommittedOutbound(task.id)) {
        this.queue.markCommittedOutbound(task.id);
      }
      this.queue.complete(task.id, result);
      this.running.delete(task.id);

      logger.info({ id: task.id, name: task.name, durationMs }, 'Task completed successfully');
      this.options.onComplete?.(task, result, durationMs);

    } catch (err: unknown) {
      clearTimeout(timeoutHandle);

      if (!this.running.has(task.id)) return; // Already handled by timeout

      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startMs;

      // If the run sent/spawned before throwing, mark it FIRST so fail() suppresses
      // the auto-requeue rather than re-firing the side effect on retry.
      if (hasCommittedOutbound(task.id)) this.queue.markCommittedOutbound(task.id);
      logger.error({ id: task.id, name: task.name, durationMs, err: msg }, 'Task execution failed');
      this.queue.fail(task.id, msg);
      this.running.delete(task.id);

      // Notify only if retries will be exhausted on next attempt
      const updated = this.queue.getTask(task.id);
      if (updated?.status === 'failed') {
        this.options.onFail?.(task, msg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Handler resolution
  // ---------------------------------------------------------------------------

  private _resolveHandler(taskName: string): TaskHandler | undefined {
    // 1. Exact match
    const exact = this.handlers.get(taskName);
    if (exact) return exact;

    // 2. Prefix wildcard match: key = "pipeline.*" matches "pipeline.render"
    for (const [key, handler] of this.handlers.entries()) {
      if (key.endsWith('*')) {
        const prefix = key.slice(0, -1);
        if (taskName.startsWith(prefix)) return handler;
      }
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** Returns the IDs of tasks currently being executed. */
  getRunningIds(): string[] {
    return Array.from(this.running.keys());
  }

  /** Whether the executor poll loop is active. */
  get isRunning(): boolean {
    return this.intervalHandle !== null && !this.stopped;
  }
}
