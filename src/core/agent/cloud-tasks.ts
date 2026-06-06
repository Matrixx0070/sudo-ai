/**
 * Cloud Tasks — Codex-style background task records.
 *
 * Tracks long-running cloud agent tasks (prompt → diff → files changed).
 * In-memory store; a persistence layer can subscribe to task state changes.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:cloud-tasks');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle states for a cloud task. */
export type CloudTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A single cloud-executed agent task. */
export interface CloudTask {
  /** Unique identifier, e.g. "cloud-1712345678901". */
  id: string;
  /** The prompt that was dispatched. */
  prompt: string;
  /** Current lifecycle status. */
  status: CloudTaskStatus;
  /** Human-readable result summary when completed. */
  result?: string;
  /** Unified diff of all file changes produced by the task. */
  diff?: string;
  /** List of file paths changed during execution. */
  filesChanged?: string[];
  /** Total lines added across all changed files. */
  linesAdded?: number;
  /** Total lines removed across all changed files. */
  linesRemoved?: number;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 completion timestamp (set when status reaches a terminal state). */
  completedAt?: string;
  /** Optional environment/sandbox identifier. */
  environmentId?: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const tasks: Map<string, CloudTask> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new cloud task in `queued` status.
 *
 * @param prompt        - The prompt to execute.
 * @param environmentId - Optional sandbox/environment identifier.
 * @returns The newly created task.
 * @throws {Error} When prompt is empty.
 */
export function createCloudTask(prompt: string, environmentId?: string): CloudTask {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('createCloudTask: prompt must be a non-empty string');
  }

  const task: CloudTask = {
    id: `cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt,
    status: 'queued',
    createdAt: new Date().toISOString(),
    environmentId,
  };
  tasks.set(task.id, task);
  log.info({ id: task.id, environmentId }, 'Cloud task created');
  return task;
}

/**
 * Apply partial updates to an existing task.
 * Use this to transition status and attach results/diffs.
 *
 * @param id      - Task identifier.
 * @param updates - Partial fields to merge into the task.
 */
export function updateCloudTask(id: string, updates: Partial<CloudTask>): void {
  const task = tasks.get(id);
  if (!task) {
    log.warn({ id }, 'updateCloudTask: task not found');
    return;
  }
  Object.assign(task, updates);

  // Auto-stamp completedAt when moving to a terminal state.
  const terminal: CloudTaskStatus[] = ['completed', 'failed', 'cancelled'];
  if (updates.status && terminal.includes(updates.status) && !task.completedAt) {
    task.completedAt = new Date().toISOString();
  }

  log.debug({ id, status: task.status }, 'Cloud task updated');
}

/**
 * Retrieve a single task by ID.
 *
 * @param id - Task identifier.
 * @returns The task, or `undefined` when not found.
 */
export function getCloudTask(id: string): CloudTask | undefined {
  return tasks.get(id);
}

/**
 * Return all tasks in insertion order.
 */
export function listCloudTasks(): CloudTask[] {
  return Array.from(tasks.values());
}

/**
 * Cancel a task that has not yet reached a terminal state.
 * No-op when already completed or failed.
 *
 * @param id - Task identifier.
 */
export function cancelCloudTask(id: string): void {
  const task = tasks.get(id);
  if (!task) {
    log.warn({ id }, 'cancelCloudTask: task not found');
    return;
  }
  if (task.status === 'completed' || task.status === 'failed') {
    log.warn({ id, status: task.status }, 'cancelCloudTask: task already in terminal state');
    return;
  }
  task.status = 'cancelled';
  task.completedAt = new Date().toISOString();
  log.info({ id }, 'Cloud task cancelled');
}
