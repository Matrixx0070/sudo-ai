/**
 * @file task-manager.ts
 * @description User-facing task management with dependencies, assignment, and hooks.
 *
 * Provides a persistent, hook-aware task registry that supports:
 * - CRUD operations with subject/description/owner/priority
 * - Task dependencies (blockedBy / blocks)
 * - Task assignment (owner tracking)
 * - Status lifecycle: pending → in_progress → completed
 * - Hook emission on TaskCreated / TaskCompleted
 * - File-based persistence to data/tasks/<sessionId>.json
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import type { HookManager, HookContext } from '../hooks/index.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const log = createLogger('agent:task-manager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed task statuses. */
export type TaskManagerStatus = 'pending' | 'in_progress' | 'completed';

/** Numeric priority level (higher = more important). */
export type TaskPriority = number;

/** A single managed task. */
export interface ManagedTask {
  /** Unique nanoid identifier. */
  id: string;
  /** Short, human-readable title. */
  subject: string;
  /** Detailed description of what the task involves. */
  description: string;
  /** Current lifecycle state. */
  status: TaskManagerStatus;
  /** Agent or user assigned to this task. */
  owner: string;
  /** Numeric priority (higher = more important). Default 0. */
  priority: TaskPriority;
  /** IDs of tasks that must complete before this one can start. */
  blockedBy: string[];
  /** IDs of tasks that this task is blocking. */
  blocks: string[];
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
  /** ISO-8601 timestamp set when the task transitions to 'completed'. */
  completedAt?: string;
}

/** Options for creating a new task. */
export interface CreateTaskOptions {
  subject: string;
  description?: string;
  owner?: string;
  priority?: TaskPriority;
}

/** Filters for listTasks(). All fields are optional; multiple filters are ANDed. */
export interface TaskListFilter {
  status?: TaskManagerStatus;
  owner?: string;
  priorityMin?: TaskPriority;
  priorityMax?: TaskPriority;
  blocked?: boolean;
}

/** Hook events emitted by TaskManager. */
export type TaskHookEvent = 'task:created' | 'task:completed';

// ---------------------------------------------------------------------------
// TaskManager class
// ---------------------------------------------------------------------------

/**
 * User-facing task manager with persistence, dependencies, and hooks.
 *
 * @example
 * ```ts
 * const tm = new TaskManager('sess-abc');
 * const t1 = tm.createTask({ subject: 'Deploy API', priority: 5 });
 * const t2 = tm.createTask({ subject: 'Run smoke tests', priority: 3 });
 * tm.addBlocks(t2.id, [t1.id]); // t2 is blocked by t1
 * tm.updateTask(t1.id, { status: 'completed' }); // fires task:completed hook
 * ```
 */
export class TaskManager {
  private readonly tasks: Map<string, ManagedTask> = new Map();
  private readonly sessionId: string;
  private readonly persistDir: string;
  private readonly persistPath: string;
  private hookManager?: HookManager;
  private dirty = false;

  constructor(sessionId: string, opts?: { persistDir?: string; hooks?: HookManager }) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new TypeError('TaskManager: sessionId must be a non-empty string');
    }
    this.sessionId = sessionId;
    this.persistDir = opts?.persistDir ?? path.resolve('data/tasks');
    this.persistPath = path.join(this.persistDir, `${sessionId}.json`);
    this.hookManager = opts?.hooks;

    // Ensure persist directory exists.
    try {
      mkdirSync(this.persistDir, { recursive: true });
    } catch (err) {
      log.warn({ err: String(err), dir: this.persistDir }, 'Cannot create persist directory');
    }

    // Load persisted state if it exists.
    this.load();
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new task in 'pending' state.
   *
   * @param opts - Creation options (subject required, rest optional).
   * @returns The newly created task.
   */
  createTask(opts: CreateTaskOptions): ManagedTask {
    if (!opts?.subject || typeof opts.subject !== 'string') {
      throw new TypeError('createTask: subject must be a non-empty string');
    }

    const now = new Date().toISOString();
    const task: ManagedTask = {
      id: genId(),
      subject: opts.subject,
      description: opts.description ?? '',
      status: 'pending',
      owner: opts.owner ?? '',
      priority: opts.priority ?? 0,
      blockedBy: [],
      blocks: [],
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    this.markDirty();
    log.info({ id: task.id, subject: task.subject, owner: task.owner, priority: task.priority }, 'Task created');

    this.emitHook('task:created', { event: 'task:created', sessionId: this.sessionId, meta: { taskId: task.id, subject: task.subject } });

    return task;
  }

  /**
   * Update mutable fields of an existing task.
   * When status transitions to 'completed', sets completedAt and fires the task:completed hook.
   *
   * @param id    - Task ID.
   * @param patch - Partial fields to update (subject, description, status, owner, priority).
   * @returns The updated task, or undefined if not found.
   */
  updateTask(
    id: string,
    patch: Partial<Pick<ManagedTask, 'subject' | 'description' | 'status' | 'owner' | 'priority'>>,
  ): ManagedTask | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'updateTask: task not found');
      return undefined;
    }

    // Validate status transitions.
    if (patch.status !== undefined && patch.status !== task.status) {
      if (!isValidTransition(task.status, patch.status)) {
        log.warn({ id, from: task.status, to: patch.status }, 'updateTask: invalid status transition');
        return task;
      }
    }

    // Apply patch.
    if (patch.subject !== undefined) task.subject = patch.subject;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.owner !== undefined) task.owner = patch.owner;
    if (patch.priority !== undefined) task.priority = patch.priority;

    const wasCompleted = task.status === 'completed';
    if (patch.status !== undefined && patch.status !== task.status) {
      task.status = patch.status;
    }

    // Handle completion (only on an actual transition into 'completed').
    if (patch.status === 'completed' && !wasCompleted) {
      task.completedAt = new Date().toISOString();
      // Unblock dependant tasks.
      this.propagateUnblock(task);
      log.info({ id, subject: task.subject }, 'Task completed');
      this.emitHook('task:completed', { event: 'task:completed', sessionId: this.sessionId, meta: { taskId: task.id, subject: task.subject } });
    }

    task.updatedAt = new Date().toISOString();
    this.markDirty();
    return task;
  }

  /**
   * Retrieve a single task by ID.
   *
   * @param id - Task ID.
   * @returns The task, or undefined if not found.
   */
  getTask(id: string): ManagedTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * List tasks, optionally filtered.
   * Multiple filters are ANDed together.
   *
   * @param filter - Optional filter criteria.
   * @returns Array of matching tasks, ordered by priority descending then creation ascending.
   */
  listTasks(filter?: TaskListFilter): ManagedTask[] {
    let results = Array.from(this.tasks.values());

    if (filter) {
      if (filter.status !== undefined) {
        results = results.filter((t) => t.status === filter.status);
      }
      if (filter.owner !== undefined) {
        results = results.filter((t) => t.owner === filter.owner);
      }
      if (filter.priorityMin !== undefined) {
        results = results.filter((t) => t.priority >= filter.priorityMin!);
      }
      if (filter.priorityMax !== undefined) {
        results = results.filter((t) => t.priority <= filter.priorityMax!);
      }
      if (filter.blocked !== undefined) {
        results = results.filter((t) =>
          filter.blocked ? t.blockedBy.length > 0 : t.blockedBy.length === 0,
        );
      }
    }

    // Sort: highest priority first, then earliest created first.
    results.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.createdAt.localeCompare(b.createdAt);
    });

    return results;
  }

  /**
   * Delete a task by ID. Removes the task from all dependency arrays.
   *
   * @param id - Task ID.
   * @returns true if the task was found and deleted, false otherwise.
   */
  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'deleteTask: task not found');
      return false;
    }

    // Remove from dependency arrays of all other tasks.
    for (const other of this.tasks.values()) {
      if (other.id === id) continue;
      other.blockedBy = other.blockedBy.filter((bid) => bid !== id);
      other.blocks = other.blocks.filter((bid) => bid !== id);
    }

    this.tasks.delete(id);
    this.markDirty();
    log.info({ id, subject: task.subject }, 'Task deleted');
    return true;
  }

  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------

  /**
   * Add blocking dependencies: the task with `id` cannot start until all
   * tasks in `blockerIds` are completed.
   *
   * @param id         - Task to add blockers to.
   * @param blockerIds - IDs of tasks that must complete first.
   * @returns The updated task, or undefined if not found.
   */
  addBlocks(id: string, blockerIds: string[]): ManagedTask | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'addBlocks: task not found');
      return undefined;
    }
    if (!Array.isArray(blockerIds)) {
      throw new TypeError('addBlocks: blockerIds must be an array');
    }

    for (const blockerId of blockerIds) {
      if (blockerId === id) {
        log.warn({ id }, 'addBlocks: cannot block self — skipping');
        continue;
      }
      if (!task.blockedBy.includes(blockerId)) {
        task.blockedBy.push(blockerId);
      }
      // Register reverse link on the blocker.
      const blocker = this.tasks.get(blockerId);
      if (blocker && !blocker.blocks.includes(id)) {
        blocker.blocks.push(id);
      }
    }

    task.updatedAt = new Date().toISOString();
    this.markDirty();
    return task;
  }

  /**
   * Remove blocking dependencies from a task.
   *
   * @param id         - Task to remove blockers from.
   * @param blockerIds - IDs of blockers to remove.
   * @returns The updated task, or undefined if not found.
   */
  removeBlocks(id: string, blockerIds: string[]): ManagedTask | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'removeBlocks: task not found');
      return undefined;
    }
    if (!Array.isArray(blockerIds)) {
      throw new TypeError('removeBlocks: blockerIds must be an array');
    }

    for (const blockerId of blockerIds) {
      task.blockedBy = task.blockedBy.filter((bid) => bid !== blockerId);
      // Clean up reverse link.
      const blocker = this.tasks.get(blockerId);
      if (blocker) {
        blocker.blocks = blocker.blocks.filter((bid) => bid !== id);
      }
    }

    task.updatedAt = new Date().toISOString();
    this.markDirty();
    return task;
  }

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------

  /**
   * Assign a task to an owner (agent or user).
   *
   * @param id    - Task ID.
   * @param owner - New owner identifier.
   * @returns The updated task, or undefined if not found.
   */
  assignTo(id: string, owner: string): ManagedTask | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'assignTo: task not found');
      return undefined;
    }
    if (!owner || typeof owner !== 'string') {
      throw new TypeError('assignTo: owner must be a non-empty string');
    }
    task.owner = owner;
    task.updatedAt = new Date().toISOString();
    this.markDirty();
    log.info({ id, owner }, 'Task assigned');
    return task;
  }

  /**
   * Remove the owner from a task (unassign).
   *
   * @param id - Task ID.
   * @returns The updated task, or undefined if not found.
   */
  unassign(id: string): ManagedTask | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn({ id }, 'unassign: task not found');
      return undefined;
    }
    task.owner = '';
    task.updatedAt = new Date().toISOString();
    this.markDirty();
    log.info({ id }, 'Task unassigned');
    return task;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Save current task state to disk.
   */
  save(): void {
    try {
      const data = Array.from(this.tasks.values());
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf8');
      this.dirty = false;
      log.debug({ path: this.persistPath, count: data.length }, 'Tasks persisted');
    } catch (err) {
      log.error({ err: String(err), path: this.persistPath }, 'Failed to persist tasks');
    }
  }

  /**
   * Load task state from disk (called automatically in constructor).
   */
  load(): void {
    try {
      if (!existsSync(this.persistPath)) {
        log.debug({ path: this.persistPath }, 'No persisted tasks file — starting fresh');
        return;
      }
      const raw = readFileSync(this.persistPath, 'utf8');
      const data: ManagedTask[] = JSON.parse(raw);
      this.tasks.clear();
      for (const task of data) {
        this.tasks.set(task.id, task);
      }
      log.info({ count: this.tasks.size, path: this.persistPath }, 'Tasks loaded from disk');
    } catch (err) {
      log.warn({ err: String(err), path: this.persistPath }, 'Failed to load persisted tasks — starting fresh');
      this.tasks.clear();
    }
  }

  /**
   * Check whether unsaved changes exist.
   */
  get isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Return the session ID.
   */
  get id(): string {
    return this.sessionId;
  }

  /**
   * Return the total number of tasks.
   */
  get size(): number {
    return this.tasks.size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private markDirty(): void {
    this.dirty = true;
  }

  /**
   * When a task is completed, remove it from the blockedBy arrays of all
   * tasks that depend on it, so they can proceed.
   */
  private propagateUnblock(completedTask: ManagedTask): void {
    for (const dependentId of completedTask.blocks) {
      const dependent = this.tasks.get(dependentId);
      if (dependent) {
        dependent.blockedBy = dependent.blockedBy.filter((bid) => bid !== completedTask.id);
        dependent.updatedAt = new Date().toISOString();
        log.debug({ dependentId, unblockedBy: completedTask.id }, 'Dependency unblocked');
      }
    }
  }

  /**
   * Emit a hook event if a HookManager is attached.
   */
  private emitHook(event: TaskHookEvent, context: HookContext): void {
    if (!this.hookManager) return;
    this.hookManager.emit(event, context).catch((err: unknown) => {
      log.warn({ event, err: String(err) }, 'Hook emission failed');
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a status transition is allowed.
 *
 * Allowed transitions:
 * - pending → in_progress
 * - pending → completed
 * - in_progress → completed
 */
function isValidTransition(from: TaskManagerStatus, to: TaskManagerStatus): boolean {
  if (from === to) return false;
  const allowed: Record<TaskManagerStatus, TaskManagerStatus[]> = {
    pending: ['in_progress', 'completed'],
    in_progress: ['completed'],
    completed: [],
  };
  return (allowed[from] ?? []).includes(to);
}