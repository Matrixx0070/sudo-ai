/**
 * task-queue-schema.ts — DDL and row-to-domain conversion for task_queue table.
 *
 * Kept separate so task-queue.ts stays under the 300-line file limit.
 * Only imported by task-queue.ts — not part of the public module surface.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types (re-exported via task-queue.ts)
// ---------------------------------------------------------------------------

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface Task {
  id: string;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  dependsOn: string[];
  payload: unknown;
  result?: unknown;
  error?: string;
  retries: number;
  maxRetries: number;
  timeoutMs: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  createdBy: string;
}

export interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  avgDurationMs: number | null;
}

export type EnqueueInput = Omit<Task, 'id' | 'status' | 'retries' | 'createdAt'>;

// ---------------------------------------------------------------------------
// Internal raw row type
// ---------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  name: string;
  description: string;
  priority: string;
  status: string;
  depends_on: string;
  payload: string;
  result: string | null;
  error: string | null;
  retries: number;
  max_retries: number;
  timeout_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_by: string;
}

// ---------------------------------------------------------------------------
// Schema initialisation (idempotent)
// ---------------------------------------------------------------------------

export function initTaskQueueSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      priority     TEXT NOT NULL DEFAULT 'normal'
                     CHECK (priority IN ('critical','high','normal','low','background')),
      status       TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','completed','failed','blocked','cancelled')),
      depends_on   TEXT NOT NULL DEFAULT '[]',
      payload      TEXT NOT NULL DEFAULT '{}',
      result       TEXT,
      error        TEXT,
      retries      INTEGER NOT NULL DEFAULT 0,
      max_retries  INTEGER NOT NULL DEFAULT 3,
      timeout_ms   INTEGER NOT NULL DEFAULT 120000,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      started_at   TEXT,
      completed_at TEXT,
      created_by   TEXT NOT NULL DEFAULT 'system'
    );
    CREATE INDEX IF NOT EXISTS idx_tq_status   ON task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_tq_priority ON task_queue(priority);
    CREATE INDEX IF NOT EXISTS idx_tq_created  ON task_queue(created_at);
  `);
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

export function rowToTask(row: TaskRow): Task {
  let payload: unknown = {};
  let result: unknown = undefined;
  let dependsOn: string[] = [];

  try { payload = JSON.parse(row.payload ?? '{}'); } catch { /* keep default */ }
  try { result = row.result ? JSON.parse(row.result) : undefined; } catch { /* keep default */ }
  try { dependsOn = JSON.parse(row.depends_on ?? '[]') as string[]; } catch { /* keep default */ }

  return {
    id:          row.id,
    name:        row.name,
    description: row.description,
    priority:    row.priority as TaskPriority,
    status:      row.status as TaskStatus,
    dependsOn,
    payload,
    result,
    error:       row.error ?? undefined,
    retries:     row.retries,
    maxRetries:  row.max_retries,
    timeoutMs:   row.timeout_ms,
    createdAt:   row.created_at,
    startedAt:   row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdBy:   row.created_by,
  };
}
