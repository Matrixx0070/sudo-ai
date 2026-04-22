/**
 * @file task-tracker.ts
 * @description In-session task progress tracker for the agent loop.
 *
 * Based on Claude Code's TodoWrite/TodoRead and Codex's intermediary
 * progress updates. Provides a lightweight, in-memory registry of named
 * tasks with lifecycle transitions: pending → in_progress → completed|failed.
 *
 * The module exports a singleton {@link taskTracker} for process-wide use,
 * plus the {@link TaskTracker} class for isolated (e.g. per-session) instances.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:task-tracker');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle state of a tracked task. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** A single tracked unit of work. */
export interface TrackedTask {
  /** Unique auto-generated identifier, e.g. "task-1712345678901". */
  id: string;
  /** Human-readable description of what the task involves. */
  subject: string;
  /** Current lifecycle state. */
  status: TaskStatus;
  /** ISO-8601 timestamp set when the task transitions to 'in_progress'. */
  startedAt?: string;
  /** ISO-8601 timestamp set when the task transitions to 'completed'. */
  completedAt?: string;
  /** Error message set when the task transitions to 'failed'. */
  error?: string;
}

// ---------------------------------------------------------------------------
// TaskTracker class
// ---------------------------------------------------------------------------

/**
 * In-memory task registry with lifecycle management.
 *
 * All mutating methods are no-ops for unknown IDs (they log a warning instead
 * of throwing) to keep the agent loop resilient to ordering bugs.
 */
export class TaskTracker {
  private readonly tasks: Map<string, TrackedTask> = new Map();

  // -------------------------------------------------------------------------
  // Lifecycle methods
  // -------------------------------------------------------------------------

  /**
   * Create a new task in 'pending' state.
   *
   * @param subject - Human-readable description of the task.
   * @returns The newly created task object.
   */
  create(subject: string): TrackedTask {
    if (!subject || typeof subject !== 'string') {
      throw new TypeError('TaskTracker.create: subject must be a non-empty string');
    }
    const id = `task-${Date.now()}`;
    const task: TrackedTask = { id, subject, status: 'pending' };
    this.tasks.set(id, task);
    log.info({ id, subject }, 'Task created');
    return task;
  }

  /**
   * Transition a task from 'pending' to 'in_progress'.
   *
   * @param id - Task ID returned by {@link create}.
   */
  start(id: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'TaskTracker.start: unknown task ID — no-op');
      return;
    }
    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();
    log.debug({ id, subject: task.subject }, 'Task started');
  }

  /**
   * Transition a task to 'completed' and record the finish timestamp.
   *
   * @param id - Task ID returned by {@link create}.
   */
  complete(id: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'TaskTracker.complete: unknown task ID — no-op');
      return;
    }
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    log.info({ id, subject: task.subject }, 'Task completed');
  }

  /**
   * Transition a task to 'failed' and attach an error message.
   *
   * @param id    - Task ID returned by {@link create}.
   * @param error - Human-readable description of the failure reason.
   */
  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'TaskTracker.fail: unknown task ID — no-op');
      return;
    }
    task.status = 'failed';
    task.error = typeof error === 'string' ? error : String(error);
    log.warn({ id, subject: task.subject, error: task.error }, 'Task failed');
  }

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  /**
   * Return all tracked tasks as an ordered array (insertion order).
   */
  list(): TrackedTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Return a single task by ID, or undefined if not found.
   */
  get(id: string): TrackedTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Return a concise progress string: "done/total tasks completed".
   *
   * Useful for injecting into agent status messages.
   */
  getProgress(): string {
    const all = this.list();
    const done = all.filter((t) => t.status === 'completed').length;
    const failed = all.filter((t) => t.status === 'failed').length;
    const total = all.length;

    if (total === 0) return 'No tasks tracked';
    if (failed > 0) return `${done}/${total} tasks completed (${failed} failed)`;
    return `${done}/${total} tasks completed`;
  }

  /**
   * Remove all tasks from the registry.
   * Useful when starting a fresh agent session.
   */
  clear(): void {
    const count = this.tasks.size;
    this.tasks.clear();
    log.info({ cleared: count }, 'Task tracker cleared');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide singleton task tracker.
 * Import and use this directly in agent loop code.
 */
export const taskTracker = new TaskTracker();
