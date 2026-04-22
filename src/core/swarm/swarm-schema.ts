/**
 * Swarm database schema and row-to-domain conversion helpers.
 *
 * Contains:
 *  - DDL statements for swarm_agents, swarm_tasks, swarm_knowledge and their indexes
 *  - Raw DB row interface types (AgentRow, TaskRow)
 *  - Conversion functions rowToAgent() and rowToTask()
 *
 * Kept separate from SwarmManager to respect the 300-line file limit.
 */

import type { SwarmAgent, SwarmTask } from './swarm-manager.js';

// ---------------------------------------------------------------------------
// Raw DB row shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  status: string;
  current_task: string | null;
  specialization: string;
  tasks_completed: number;
  success_rate: number;
  avg_duration_ms: number;
  spawned_at: string;
  last_active_at: string;
}

export interface TaskRow {
  id: string;
  description: string;
  assigned_to: string | null;
  required_role: string;
  priority: number;
  result: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Schema DDL — one complete statement per element (no trailing semicolon)
// ---------------------------------------------------------------------------

export const SWARM_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS swarm_agents (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    role            TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'idle',
    current_task    TEXT,
    specialization  TEXT    NOT NULL DEFAULT '[]',
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    success_rate    REAL    NOT NULL DEFAULT 1.0,
    avg_duration_ms REAL    NOT NULL DEFAULT 0,
    spawned_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_active_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS swarm_tasks (
    id            TEXT    PRIMARY KEY,
    description   TEXT    NOT NULL,
    assigned_to   TEXT,
    required_role TEXT    NOT NULL,
    priority      INTEGER NOT NULL DEFAULT 5,
    result        TEXT,
    status        TEXT    NOT NULL DEFAULT 'pending',
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at  TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS swarm_knowledge (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   TEXT    NOT NULL,
    knowledge  TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT 'general',
    shared_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_swarm_agents_role     ON swarm_agents(role)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_agents_status   ON swarm_agents(status)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_tasks_status    ON swarm_tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_tasks_role      ON swarm_tasks(required_role)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_knowledge_agent ON swarm_knowledge(agent_id)`,
];

// ---------------------------------------------------------------------------
// Row → domain object converters
// ---------------------------------------------------------------------------

/**
 * Convert a raw SQLite agent row to a typed {@link SwarmAgent}.
 */
export function rowToAgent(row: AgentRow): SwarmAgent {
  let specialization: string[] = [];
  try { specialization = JSON.parse(row.specialization) as string[]; } catch { /* keep empty */ }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status as SwarmAgent['status'],
    currentTask: row.current_task ?? undefined,
    specialization,
    performance: {
      tasksCompleted: row.tasks_completed,
      successRate: row.success_rate,
      avgDurationMs: row.avg_duration_ms,
    },
    spawnedAt: row.spawned_at,
    lastActiveAt: row.last_active_at,
  };
}

/**
 * Convert a raw SQLite task row to a typed {@link SwarmTask}.
 */
export function rowToTask(row: TaskRow): SwarmTask {
  let result: unknown = undefined;
  if (row.result) {
    try { result = JSON.parse(row.result); } catch { result = row.result; }
  }
  return {
    id: row.id,
    description: row.description,
    assignedTo: row.assigned_to ?? undefined,
    requiredRole: row.required_role,
    priority: row.priority,
    result,
    status: row.status as SwarmTask['status'],
  };
}
