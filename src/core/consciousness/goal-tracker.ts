/**
 * @file goal-tracker.ts
 * @description Goal-Driven tracking for SUDO-AI v4 Kairos consciousness daemon.
 *
 * Tracks named goals with target metrics and deadlines.
 * Produces KairosObservation-compatible objects when goals are at risk
 * or momentum is lost.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { KairosObservation } from './kairos.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalDefinition {
  id: string;
  name: string;
  description: string;
  targetMetric: string;
  targetValue: number;
  currentValue: number;
  deadline: string | null;
  status: 'active' | 'at_risk' | 'completed' | 'abandoned';
  createdAt: string;
  updatedAt: string;
}

interface GoalRow {
  id: string;
  name: string;
  description: string;
  target_metric: string;
  target_value: number;
  current_value: number;
  deadline: string | null;
  status: 'active' | 'at_risk' | 'completed' | 'abandoned';
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// GoalTracker
// ---------------------------------------------------------------------------

export class GoalTracker {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        target_metric TEXT NOT NULL,
        target_value REAL NOT NULL,
        current_value REAL NOT NULL DEFAULT 0,
        deadline TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','at_risk','completed','abandoned')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  private rowToDefinition(row: GoalRow): GoalDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      targetMetric: row.target_metric,
      targetValue: row.target_value,
      currentValue: row.current_value,
      deadline: row.deadline,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createGoal(def: Omit<GoalDefinition, 'id' | 'createdAt' | 'updatedAt' | 'status'> & Partial<Pick<GoalDefinition, 'id' | 'status'>>): GoalDefinition {
    const id = def.id ?? randomUUID();
    const now = new Date().toISOString();
    const status = def.status ?? 'active';

    this.db.prepare(`
      INSERT INTO goals (id, name, description, target_metric, target_value, current_value, deadline, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      def.name,
      def.description ?? '',
      def.targetMetric,
      def.targetValue,
      def.currentValue ?? 0,
      def.deadline ?? null,
      status,
      now,
      now,
    );

    const row = this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as GoalRow;
    return this.rowToDefinition(row);
  }

  getActiveGoals(): GoalDefinition[] {
    const rows = this.db.prepare(`
      SELECT * FROM goals WHERE status IN ('active', 'at_risk') ORDER BY created_at ASC
    `).all() as GoalRow[];
    return rows.map(r => this.rowToDefinition(r));
  }

  updateGoalProgress(goalId: string, currentValue: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE goals SET current_value = ?, updated_at = ? WHERE id = ?
    `).run(currentValue, now, goalId);
  }

  evaluate(_observations: unknown[]): KairosObservation[] {
    const results: KairosObservation[] = [];
    const now = new Date();
    const goals = this.getActiveGoals();

    for (const goal of goals) {
      const progress = goal.targetValue > 0 ? goal.currentValue / goal.targetValue : 1;

      // Check goal_at_risk: < 30% progress and deadline within 7 days
      if (progress < 0.3 && goal.deadline !== null) {
        const deadlineMs = new Date(goal.deadline).getTime();
        const daysLeft = (deadlineMs - now.getTime()) / (1000 * 60 * 60 * 24);
        if (daysLeft >= 0 && daysLeft <= 7) {
          // Mark as at_risk in DB
          this.db.prepare(`
            UPDATE goals SET status = 'at_risk', updated_at = ? WHERE id = ? AND status = 'active'
          `).run(now.toISOString(), goal.id);

          results.push({
            timestamp: now.toISOString(),
            type: 'goal_at_risk',
            severity: daysLeft <= 2 ? 'CRITICAL' : 'WARN',
            message: `Goal "${goal.name}" is at risk: ${Math.round(progress * 100)}% complete with ${Math.round(daysLeft)} day(s) remaining until deadline`,
            action: `Review goal "${goal.name}" (${goal.targetMetric}: ${goal.currentValue}/${goal.targetValue}) and accelerate progress`,
          });
        }
      }

      // Check momentum_loss: no updateGoalProgress called in 48h (updated_at is stale)
      const updatedMs = new Date(goal.updatedAt).getTime();
      const hoursSinceUpdate = (now.getTime() - updatedMs) / (1000 * 60 * 60);
      if (hoursSinceUpdate >= 48) {
        results.push({
          timestamp: now.toISOString(),
          type: 'momentum_loss',
          severity: hoursSinceUpdate >= 96 ? 'WARN' : 'INFO',
          message: `Goal "${goal.name}" has had no progress update in ${Math.round(hoursSinceUpdate)} hours`,
          action: `Update progress for goal "${goal.name}" (${goal.targetMetric}) or mark as abandoned if no longer active`,
        });
      }
    }

    return results;
  }

  close(): void {
    this.db.close();
  }
}
