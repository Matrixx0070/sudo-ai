/**
 * TaskQueue — priority-based, dependency-aware task queue backed by better-sqlite3.
 * Priority: critical > high > normal > low > background.
 * Dependencies: blocked tasks unblock automatically when all deps complete.
 * Retries: fail() re-queues until maxRetries is reached, then marks as failed.
 * Schema DDL is in task-queue-schema.ts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  initTaskQueueSchema,
  rowToTask,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskRow,
  type QueueStats,
  type EnqueueInput,
} from './task-queue-schema.js';

export type { Task, TaskPriority, TaskStatus, QueueStats, EnqueueInput };

const logger = createLogger('task-queue');

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

export class TaskQueue {
  private readonly db: Database.Database;
  readonly maxConcurrent: number;

  constructor(dbPath: string, maxConcurrent = 4) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('TaskQueue: dbPath must be a non-empty string');
    }
    if (maxConcurrent < 1 || !Number.isInteger(maxConcurrent)) {
      throw new RangeError('TaskQueue: maxConcurrent must be a positive integer');
    }

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.maxConcurrent = maxConcurrent;

    initTaskQueueSchema(this.db);
    logger.info({ dbPath, maxConcurrent }, 'TaskQueue initialised');
  }

  // ---------------------------------------------------------------------------
  // Core operations
  // ---------------------------------------------------------------------------

  /**
   * Add a task to the queue. Returns the assigned task ID.
   * If the task has dependencies, it is initially stored as 'blocked'.
   */
  enqueue(input: EnqueueInput): string {
    if (!input.name?.trim()) throw new TypeError('enqueue: name is required');

    const id = randomUUID();
    const dependsOn = input.dependsOn ?? [];
    const initialStatus: TaskStatus = dependsOn.length > 0 ? 'blocked' : 'queued';

    this.db.prepare(`
      INSERT INTO task_queue
        (id, name, description, priority, status, depends_on, payload,
         retries, max_retries, timeout_ms, created_by)
      VALUES
        (:id, :name, :description, :priority, :status, :depends_on, :payload,
         0, :max_retries, :timeout_ms, :created_by)
    `).run({
      id,
      name:        input.name.trim(),
      description: input.description ?? '',
      priority:    input.priority ?? 'normal',
      status:      initialStatus,
      depends_on:  JSON.stringify(dependsOn),
      payload:     JSON.stringify(input.payload ?? {}),
      max_retries: input.maxRetries ?? 3,
      timeout_ms:  input.timeoutMs ?? 120_000,
      created_by:  input.createdBy ?? 'system',
    });

    logger.info({ id, name: input.name, priority: input.priority, status: initialStatus }, 'Task enqueued');
    return id;
  }

  /**
   * Dequeue the highest-priority ready task and mark it as 'running'.
   * Returns null if no ready tasks or maxConcurrent is reached.
   */
  dequeue(): Task | null {
    const running = this.getRunning();
    if (running.length >= this.maxConcurrent) {
      logger.debug({ running: running.length, max: this.maxConcurrent }, 'Max concurrent reached');
      return null;
    }

    const row = this.db.prepare<[], TaskRow>(
      "SELECT * FROM task_queue WHERE status='queued' ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 WHEN 'background' THEN 4 ELSE 5 END ASC, created_at ASC LIMIT 1"
    ).get();

    if (!row) return null;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE task_queue SET status = 'running', started_at = :now WHERE id = :id
    `).run({ id: row.id, now });

    logger.info({ id: row.id, name: row.name }, 'Task dequeued and running');
    return rowToTask({ ...row, status: 'running', started_at: now });
  }

  /**
   * Mark a running task as completed and unblock any dependents.
   */
  complete(id: string, result?: unknown): void {
    this._assertId(id);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE task_queue
      SET status = 'completed', result = :result, completed_at = :now
      WHERE id = :id
    `).run({ id, result: result !== undefined ? JSON.stringify(result) : null, now });

    logger.info({ id }, 'Task completed');
    this._unblockDependents(id);
  }

  /**
   * Mark a task as failed. If retries remain, re-queues it; otherwise keeps as failed.
   */
  fail(id: string, error: string): void {
    this._assertId(id);
    const task = this.getTask(id);
    if (!task) { logger.warn({ id }, 'fail: task not found'); return; }

    const nextRetry = task.retries + 1;
    const exhausted = nextRetry >= task.maxRetries;
    const newStatus: TaskStatus = exhausted ? 'failed' : 'queued';

    this.db.prepare(`
      UPDATE task_queue
      SET status = :status, retries = :retries, error = :error,
          completed_at = CASE WHEN :exhausted THEN :now ELSE NULL END
      WHERE id = :id
    `).run({
      id,
      status:   newStatus,
      retries:  nextRetry,
      error:    error.slice(0, 2000),
      exhausted: exhausted ? 1 : 0,
      now:      new Date().toISOString(),
    });

    logger.warn({ id, retries: nextRetry, maxRetries: task.maxRetries, exhausted, newStatus }, 'Task failed');
  }

  /**
   * Cancel a task. Only queued, blocked, or running tasks can be cancelled.
   */
  cancel(id: string): void {
    this._assertId(id);
    const info = this.db.prepare(`
      UPDATE task_queue
      SET status = 'cancelled', completed_at = :now
      WHERE id = :id AND status IN ('queued','running','blocked')
    `).run({ id, now: new Date().toISOString() });

    if (info.changes === 0) {
      logger.warn({ id }, 'cancel: not found or already terminal');
    } else {
      logger.info({ id }, 'Task cancelled');
    }
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getTask(id: string): Task | null {
    this._assertId(id);
    const row = this.db.prepare<{ id: string }, TaskRow>(
      'SELECT * FROM task_queue WHERE id = :id'
    ).get({ id });
    return row ? rowToTask(row) : null;
  }

  /**
   * Find tasks by full id or id prefix. The management tool's list view shows
   * only the first 8 chars of each id, so callers routinely have a prefix rather
   * than the full UUID — looking up by exact id then returns "not found".
   *
   * An exact id match short-circuits to a single result. Otherwise every task
   * whose id starts with `idOrPrefix` is returned (capped), so the caller can
   * detect ambiguity. LIKE metacharacters in the input are escaped.
   */
  findByIdPrefix(idOrPrefix: string): Task[] {
    this._assertId(idOrPrefix);
    const exact = this.getTask(idOrPrefix);
    if (exact) return [exact];

    const escaped = idOrPrefix.replace(/[\\%_]/g, c => `\\${c}`);
    const rows = this.db.prepare<{ p: string }, TaskRow>(
      "SELECT * FROM task_queue WHERE id LIKE :p ESCAPE '\\' ORDER BY created_at DESC LIMIT 10"
    ).all({ p: `${escaped}%` });
    return rows.map(rowToTask);
  }

  listTasks(filter: { status?: string; priority?: string; limit?: number } = {}): Task[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.status)   { conditions.push('status = :status');     params['status']   = filter.status;   }
    if (filter.priority) { conditions.push('priority = :priority'); params['priority'] = filter.priority; }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params['limit'] = filter.limit ?? 100;

    const rows = this.db.prepare<Record<string, unknown>, TaskRow>(
      `SELECT * FROM task_queue ${where} ORDER BY created_at DESC LIMIT :limit`
    ).all(params);

    return rows.map(rowToTask);
  }

  getBlocked(): Task[] {
    return this.db.prepare<[], TaskRow>("SELECT * FROM task_queue WHERE status = 'blocked' ORDER BY created_at ASC").all().map(rowToTask);
  }

  getRunning(): Task[] {
    return this.db.prepare<[], TaskRow>("SELECT * FROM task_queue WHERE status = 'running' ORDER BY started_at ASC").all().map(rowToTask);
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  isReady(task: Task): boolean {
    if (task.dependsOn.length === 0) return true;
    return task.dependsOn.every(depId => this.getTask(depId)?.status === 'completed');
  }

  getNextBatch(n = 4): Task[] {
    return this.db.prepare<{ n: number }, TaskRow>(`
      SELECT * FROM task_queue WHERE status = 'queued'
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
        WHEN 'normal' THEN 2 WHEN 'low' THEN 3 WHEN 'background' THEN 4 ELSE 5 END ASC,
        created_at ASC LIMIT :n
    `).all({ n }).map(rowToTask);
  }

  retryFailed(): number {
    const info = this.db.prepare(
      "UPDATE task_queue SET status = 'queued', error = NULL WHERE status = 'failed' AND retries < max_retries"
    ).run();
    logger.info({ requeued: info.changes }, 'retryFailed: tasks re-queued');
    return info.changes;
  }

  pruneCompleted(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const info = this.db.prepare(
      "DELETE FROM task_queue WHERE status IN ('completed','cancelled') AND completed_at < :cutoff"
    ).run({ cutoff });
    logger.info({ removed: info.changes, olderThanDays }, 'pruneCompleted');
    return info.changes;
  }

  /**
   * Delete tasks in a terminal state — completed, cancelled, OR failed — that
   * finished more than `olderThanDays` ago. Unlike {@link pruneCompleted} this
   * also clears exhausted `failed` rows, and it falls back to `created_at` when a
   * row has no `completed_at`. Non-terminal tasks (queued/running/blocked) are
   * never touched. `olderThanDays = 0` prunes all terminal rows regardless of age.
   * Returns the number of rows removed.
   */
  pruneTerminal(olderThanDays = 7): number {
    const days = Math.max(0, olderThanDays);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    // Inclusive boundary: with olderThanDays = 0 the cutoff is "now", and a
    // strict `<` would skip rows finished in that same millisecond — so `prune 0`
    // would leave terminal rows behind. `<=` makes "0 = all terminal" exact.
    const info = this.db.prepare(
      "DELETE FROM task_queue WHERE status IN ('completed','cancelled','failed') AND COALESCE(completed_at, created_at) <= :cutoff"
    ).run({ cutoff });
    logger.info({ removed: info.changes, olderThanDays: days }, 'pruneTerminal');
    return info.changes;
  }

  getStats(): QueueStats {
    const rows = this.db.prepare<[], { status: string; count: number }>(
      "SELECT status, COUNT(*) as count FROM task_queue GROUP BY status"
    ).all();
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = r.count;
    const avgRow = this.db.prepare<[], { avg_ms: number | null }>(
      "SELECT AVG((julianday(completed_at)-julianday(started_at))*86400000) as avg_ms FROM task_queue WHERE status='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL"
    ).get();
    return {
      queued: c['queued'] ?? 0, running: c['running'] ?? 0, completed: c['completed'] ?? 0,
      failed: c['failed'] ?? 0, blocked: c['blocked'] ?? 0, cancelled: c['cancelled'] ?? 0,
      avgDurationMs: avgRow?.avg_ms ?? null,
    };
  }

  close(): void { this.db.close(); }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _assertId(id: unknown): asserts id is string {
    if (!id || typeof id !== 'string') throw new TypeError('Task id must be a non-empty string');
  }

  private _unblockDependents(completedId: string): void {
    let unblocked = 0;
    for (const task of this.getBlocked()) {
      if (task.dependsOn.includes(completedId) && this.isReady(task)) {
        this.db.prepare("UPDATE task_queue SET status = 'queued' WHERE id = :id").run({ id: task.id });
        unblocked++;
        logger.info({ id: task.id, name: task.name }, 'Dependent task unblocked');
      }
    }
    if (unblocked > 0) logger.info({ completedId, unblocked }, 'Unblocked dependent tasks');
  }
}
