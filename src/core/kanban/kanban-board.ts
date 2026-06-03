/**
 * @file kanban-board.ts
 * @description KanbanBoard — SQLite-backed task board for swarm orchestration.
 *
 * Provides CRUD operations for tasks with status tracking, priority, and
 * workspace isolation. Uses better-sqlite3 for synchronous persistence.
 *
 * Kill-switch: SUDO_KANBAN_DISABLE=1 disables all operations.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import type { KanbanTask, KanbanStatus, KanbanWorkspace, KanbanPriority } from './kanban-types.js';
import { isValidTransition } from './kanban-types.js';

const log = createLogger('kanban:board');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = process.env['DATA_DIR'] ?? 'data';
const DB_PATH = `${DATA_DIR}/kanban.db`;
const KILL_SWITCH = 'SUDO_KANBAN_DISABLE';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDisabled(): boolean {
  return process.env[KILL_SWITCH] === '1';
}

function rowToTask(row: unknown): KanbanTask {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    title: String(r.title),
    body: String(r.body),
    status: r.status as KanbanStatus,
    priority: Number(r.priority) as KanbanPriority,
    assignee: r.assignee ? String(r.assignee) : null,
    skills: r.skills ? (JSON.parse(String(r.skills)) as string[]) : [],
    parentId: r.parent_id ? String(r.parent_id) : null,
    workspace: r.workspace as KanbanWorkspace,
    tenantId: r.tenant_id ? String(r.tenant_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function taskToRow(task: KanbanTask): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    skills: JSON.stringify(task.skills),
    parent_id: task.parentId,
    workspace: task.workspace,
    tenant_id: task.tenantId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// KanbanBoard class
// ---------------------------------------------------------------------------

export class KanbanBoard {
  private db: Database.Database | null = null;
  private initialized = false;

  private stmtInsert: Database.Statement | null = null;
  private stmtSelectById: Database.Statement | null = null;
  private stmtUpdate: Database.Statement | null = null;
  private stmtDelete: Database.Statement | null = null;
  private stmtList: Database.Statement | null = null;
  private stmtMove: Database.Statement | null = null;
  private stmtStats: Database.Statement | null = null;

  /**
   * Initialize the database connection and prepare statements.
   */
  private ensureDb(): void {
    if (this.initialized) return;

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_tasks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'todo',
        priority    INTEGER NOT NULL DEFAULT 3,
        assignee    TEXT,
        skills      TEXT NOT NULL DEFAULT '[]',
        parent_id   TEXT REFERENCES kanban_tasks(id),
        workspace   TEXT NOT NULL DEFAULT 'scratch',
        tenant_id   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_kanban_workspace ON kanban_tasks(workspace);
      CREATE INDEX IF NOT EXISTS idx_kanban_tenant ON kanban_tasks(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_tasks(parent_id);
    `);

    // Prepare statements
    this.stmtInsert = db.prepare(`
      INSERT INTO kanban_tasks (id, title, body, status, priority, assignee, skills, parent_id, workspace, tenant_id, created_at, updated_at)
      VALUES (@id, @title, @body, @status, @priority, @assignee, @skills, @parent_id, @workspace, @tenant_id, @created_at, @updated_at)
    `);

    this.stmtSelectById = db.prepare('SELECT * FROM kanban_tasks WHERE id = ?');

    this.stmtUpdate = db.prepare(`
      UPDATE kanban_tasks
      SET title = COALESCE(@title, title),
          body = COALESCE(@body, body),
          status = COALESCE(@status, status),
          priority = COALESCE(@priority, priority),
          assignee = @assignee,
          skills = COALESCE(@skills, skills),
          parent_id = @parent_id,
          workspace = COALESCE(@workspace, workspace),
          tenant_id = @tenant_id,
          updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtDelete = db.prepare('DELETE FROM kanban_tasks WHERE id = ?');

    this.stmtList = db.prepare(`
      SELECT * FROM kanban_tasks
      WHERE (@status IS NULL OR status = @status)
        AND (@workspace IS NULL OR workspace = @workspace)
        AND (@tenant_id IS NULL OR tenant_id = @tenant_id)
      ORDER BY priority DESC, created_at ASC
    `);

    this.stmtMove = db.prepare(`
      UPDATE kanban_tasks
      SET status = @status, updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtStats = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
      FROM kanban_tasks
    `);

    this.db = db;
    this.initialized = true;
    log.info({ dbPath: DB_PATH }, 'KanbanBoard initialized');
  }

  /**
   * Create a new task.
   * @throws Error if kill-switch is enabled.
   */
  createTask(partial: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>): KanbanTask {
    if (isDisabled()) {
      throw new Error('KanbanBoard: SUDO_KANBAN_DISABLE=1');
    }
    this.ensureDb();

    const now = new Date().toISOString();
    const task: KanbanTask = {
      ...partial,
      id: genId(),
      createdAt: now,
      updatedAt: now,
    };

    const row = taskToRow(task);
    this.stmtInsert!.run(row);
    log.info({ taskId: task.id, title: task.title.slice(0, 50) }, 'Task created');
    return task;
  }

  /**
   * Get a task by ID.
   * @returns The task or null if not found.
   */
  getTask(id: string): KanbanTask | null {
    if (isDisabled()) {
      throw new Error('KanbanBoard: SUDO_KANBAN_DISABLE=1');
    }
    this.ensureDb();

    const row = this.stmtSelectById!.get(id) as unknown;
    if (!row) return null;
    return rowToTask(row);
  }

  /**
   * Update a task's fields.
   * @returns True if updated, false if not found.
   */
  updateTask(id: string, updates: Partial<KanbanTask>): boolean {
    if (isDisabled()) {
      throw new Error('KanbanBoard: SUDO_KANBAN_DISABLE=1');
    }
    this.ensureDb();

    const existing = this.getTask(id);
    if (!existing) return false;

    const row: Record<string, unknown> = {
      id,
      title: updates.title ?? null,
      body: updates.body ?? null,
      status: updates.status ?? null,
      priority: updates.priority ?? null,
      assignee: updates.assignee !== undefined ? updates.assignee : null,
      skills: updates.skills ? JSON.stringify(updates.skills) : null,
      parent_id: updates.parentId !== undefined ? updates.parentId : null,
      workspace: updates.workspace ?? null,
      tenant_id: updates.tenantId !== undefined ? updates.tenantId : null,
      updated_at: new Date().toISOString(),
    };

    const result = this.stmtUpdate!.run(row);
    const updated = result.changes > 0;
    if (updated) {
      log.info({ taskId: id }, 'Task updated');
    }
    return updated;
  }

  /**
   * Delete a task by ID.
   * @returns True if deleted, false if not found.
   */
  deleteTask(id: string): boolean {
    if (isDisabled()) {
      throw new Error('KanbanBoard: SUDO_KANBAN_DISABLE=1');
    }
    this.ensureDb();

    const result = this.stmtDelete!.run(id);
    const deleted = result.changes > 0;
    if (deleted) {
      log.info({ taskId: id }, 'Task deleted');
    }
    return deleted;
  }

  /**
   * List tasks with optional filters.
   */
  listTasks(options?: {
    status?: KanbanStatus;
    workspace?: KanbanWorkspace;
    tenantId?: string;
  }): KanbanTask[] {
    if (isDisabled()) {
      throw new Error('KanbanBoard: SUDO_KANBAN_DISABLE=1');
    }
    this.ensureDb();

    const params = {
      status: options?.status ?? null,
      workspace: options?.workspace ?? null,
      tenant_id: options?.tenantId ?? null,
    };

    const rows = this.stmtList!.all(params) as unknown[];
    return rows.map(rowToTask);
  }

  /**
   * Move a task to a new status.
   * @returns True if transition was valid and successful.
   */
  moveTask(id: string, newStatus: KanbanStatus): boolean {
    if (isDisabled()) {
      throw new Error('KanbanBoard: SUDO_KANBAN_DISABLE=1');
    }
    this.ensureDb();

    const existing = this.getTask(id);
    if (!existing) return false;

    if (!isValidTransition(existing.status, newStatus)) {
      log.warn({ taskId: id, from: existing.status, to: newStatus }, 'Invalid status transition');
      return false;
    }

    const result = this.stmtMove!.run({
      id,
      status: newStatus,
      updated_at: new Date().toISOString(),
    });

    const moved = result.changes > 0;
    if (moved) {
      log.info({ taskId: id, from: existing.status, to: newStatus }, 'Task moved');
    }
    return moved;
  }

  /**
   * Get board statistics.
   */
  getStats(): { todo: number; inProgress: number; review: number; done: number } {
    if (isDisabled()) {
      throw new Error('KanbanBoard: SUDO_KANBAN_DISABLE=1');
    }
    this.ensureDb();

    const row = this.stmtStats!.get() as Record<string, number | null>;
    return {
      todo: row.todo ?? 0,
      inProgress: row.in_progress ?? 0,
      review: row.review ?? 0,
      done: row.done ?? 0,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      log.info('KanbanBoard closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

/**
 * Global singleton instance of KanbanBoard.
 */
export const kanbanBoard = new KanbanBoard();
