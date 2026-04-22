/**
 * @file goal-engine-v2-schema.ts
 * @description Types, DDL, and row-converter helpers for GoalEngineV2.
 * Kept separate to hold goal-engine-v2.ts under 300 lines.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GoalPriorityV2 = 'critical' | 'high' | 'normal' | 'low';
export type GoalStatusV2   = 'active' | 'sleeping' | 'paused' | 'completed' | 'failed';

export interface GoalMilestoneV2 {
  id: string;
  description: string;
  completed: boolean;
  completedAt?: string;
}

export interface GoalV2 {
  id: string;
  title: string;
  description: string;
  priority: GoalPriorityV2;
  status: GoalStatusV2;
  /** 0.0 – 100.0 */
  progress: number;
  milestones: GoalMilestoneV2[];
  createdAt: string;
  deadline?: string;
  /** ISO-8601: when the goal should next wake from sleep. Null = immediately eligible. */
  wakeAt?: string;
  lastWorkedAt?: string;
}

/** Options accepted by GoalEngineV2.setGoal(). */
export interface SetGoalOptions {
  title: string;
  description: string;
  priority?: GoalPriorityV2;
  deadline?: string;
  milestones?: Array<Omit<GoalMilestoneV2, 'id' | 'completed' | 'completedAt'>>;
}

/** Filter options for GoalEngineV2.listGoals(). */
export interface ListGoalsFilter {
  status?: GoalStatusV2 | GoalStatusV2[];
  priority?: GoalPriorityV2;
}

// ---------------------------------------------------------------------------
// Internal row shape (not exported — only used by goal-engine-v2.ts)
// ---------------------------------------------------------------------------

export interface GoalRow {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  progress: number;
  milestones_json: string;
  created_at: string;
  deadline: string | null;
  wake_at: string | null;
  last_worked_at: string | null;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export const CREATE_GOALS_V2 = `
  CREATE TABLE IF NOT EXISTS goals_v2 (
    id              TEXT    PRIMARY KEY,
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    priority        TEXT    NOT NULL DEFAULT 'normal',
    status          TEXT    NOT NULL DEFAULT 'active',
    progress        REAL    NOT NULL DEFAULT 0,
    milestones_json TEXT    NOT NULL DEFAULT '[]',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deadline        TEXT,
    wake_at         TEXT,
    last_worked_at  TEXT
  )
`;

export const GOALS_V2_INDEXES: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_goals_v2_status   ON goals_v2(status)`,
  `CREATE INDEX IF NOT EXISTS idx_goals_v2_wake_at  ON goals_v2(wake_at)`,
  `CREATE INDEX IF NOT EXISTS idx_goals_v2_priority ON goals_v2(priority)`,
];

// ---------------------------------------------------------------------------
// Schema initialiser
// ---------------------------------------------------------------------------

export function initGoalsV2Schema(db: Database): void {
  db.exec(CREATE_GOALS_V2);
  for (const idx of GOALS_V2_INDEXES) {
    db.exec(idx);
  }
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

export function rowToGoal(row: GoalRow): GoalV2 {
  let milestones: GoalMilestoneV2[] = [];
  try {
    milestones = JSON.parse(row.milestones_json) as GoalMilestoneV2[];
  } catch {
    /* leave empty on corrupt JSON */
  }

  return {
    id:           row.id,
    title:        row.title,
    description:  row.description,
    priority:     row.priority as GoalPriorityV2,
    status:       row.status as GoalStatusV2,
    progress:     row.progress,
    milestones,
    createdAt:    row.created_at,
    deadline:     row.deadline ?? undefined,
    wakeAt:       row.wake_at ?? undefined,
    lastWorkedAt: row.last_worked_at ?? undefined,
  };
}
