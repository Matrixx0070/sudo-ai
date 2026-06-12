/**
 * @file schema.ts
 * @description DDL and type definitions for the autonomy module's SQLite tables.
 *
 * Kept separate from event-loop.ts to keep each file under 300 lines.
 * Only imported by event-loop.ts.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: string;
}

export interface Plan {
  id: string;
  name: string;
  steps: PlanStep[];
  currentStep: number;
  createdAt: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
}

export interface EventLoopState {
  running: boolean;
  currentPlan?: string;
  pendingActions: string[];
  lastThinkCycle: string;
  cycleCount: number;
}

// ---------------------------------------------------------------------------
// Internal raw row types
// ---------------------------------------------------------------------------

export interface PlanRow {
  id: string;
  name: string;
  steps: string;
  current_step: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ActionRow {
  id: number;
  action: string;
  reason: string;
  priority: string;
  status: string;
  result: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// DDL statements
// ---------------------------------------------------------------------------

export const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS autonomous_plans (
    id           TEXT    PRIMARY KEY,
    name         TEXT    NOT NULL,
    steps        TEXT    NOT NULL DEFAULT '[]',
    current_step INTEGER NOT NULL DEFAULT 0,
    status       TEXT    NOT NULL DEFAULT 'active',
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS self_initiated_actions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
    priority   TEXT    NOT NULL DEFAULT 'normal',
    status     TEXT    NOT NULL DEFAULT 'pending',
    result     TEXT,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_autonomous_plans_status
     ON autonomous_plans(status)`,

  `CREATE INDEX IF NOT EXISTS idx_self_actions_status
     ON self_initiated_actions(status, priority)`,
];

// ---------------------------------------------------------------------------
// Schema initialiser
// ---------------------------------------------------------------------------

export function initAutonomySchema(db: Database): void {
  for (const ddl of SCHEMA_DDL) {
    db.exec(ddl);
  }
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

export function rowToPlan(row: PlanRow): Plan {
  let steps: PlanStep[] = [];
  try { steps = JSON.parse(row.steps) as PlanStep[]; } catch { /* leave empty */ }
  return {
    id:          row.id,
    name:        row.name,
    steps,
    currentStep: row.current_step,
    createdAt:   row.created_at,
    status:      row.status as Plan['status'],
  };
}
