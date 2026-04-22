/**
 * @file goal-engine-v2.ts
 * @description SQLite-backed goal persistence with wake/sleep scheduling.
 *
 * Goals survive process restarts (unlike goal-pursuit.ts which uses an
 * in-memory Map).  Each goal tracks a wake_at timestamp so the autonomous
 * work loop can poll for goals that are ready to be worked on.
 *
 * Types, DDL, and row converters live in goal-engine-v2-schema.ts.
 * Uses better-sqlite3 with WAL mode for safe concurrent reads.
 * DB file: data/goals.db (shared with outcomes.ts).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import {
  initGoalsV2Schema,
  rowToGoal,
  type GoalRow,
  type GoalV2,
  type GoalPriorityV2,
  type GoalStatusV2,
  type SetGoalOptions,
  type ListGoalsFilter,
} from './goal-engine-v2-schema.js';

export type {
  GoalV2,
  GoalPriorityV2,
  GoalStatusV2,
  GoalMilestoneV2,
  SetGoalOptions,
  ListGoalsFilter,
} from './goal-engine-v2-schema.js';

const log = createLogger('autonomy:goal-engine-v2');

const DB_PATH = path.resolve('data/goals.db');

// ---------------------------------------------------------------------------
// GoalEngineV2
// ---------------------------------------------------------------------------

/**
 * SQLite-backed goal store with wake/sleep scheduling support.
 *
 * Instantiate once and share the instance.  All writes use synchronous
 * better-sqlite3 statements (no async needed for SQLite).
 *
 * @example
 * ```ts
 * const engine = new GoalEngineV2();
 * const goal = engine.setGoal({ title: 'Earn $1k', description: '...' });
 * engine.scheduleWake(goal.id, new Date(Date.now() + 3_600_000).toISOString());
 * const ready = engine.getGoalsReadyToWork();
 * ```
 */
export class GoalEngineV2 {
  private readonly db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    initGoalsV2Schema(this.db);
    log.info({ dbPath }, 'GoalEngineV2 initialised');
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Create and persist a new goal.
   * @throws TypeError when title is missing or empty.
   */
  setGoal(opts: SetGoalOptions): GoalV2 {
    if (!opts.title || !opts.title.trim()) {
      throw new TypeError('GoalEngineV2.setGoal: title is required');
    }

    const id  = genId();
    const now = new Date().toISOString();

    const milestones = (opts.milestones ?? []).map((m) => ({
      id:          genId(),
      description: m.description,
      completed:   false,
    }));

    this.db.prepare(
      `INSERT INTO goals_v2
         (id, title, description, priority, status, progress,
          milestones_json, created_at, deadline)
       VALUES
         (@id, @title, @description, @priority, 'active', 0,
          @milestones_json, @created_at, @deadline)`,
    ).run({
      id,
      title:           opts.title.trim(),
      description:     (opts.description ?? '').trim(),
      priority:        opts.priority ?? 'normal',
      milestones_json: JSON.stringify(milestones),
      created_at:      now,
      deadline:        opts.deadline ?? null,
    });

    log.info({ id, title: opts.title, priority: opts.priority ?? 'normal' }, 'Goal created');
    return this.getGoalOrThrow(id);
  }

  /**
   * Set a wake-up time for a sleeping or active goal.
   * Active goals are automatically put to sleep.
   */
  scheduleWake(goalId: string, wakeAt: string): void {
    this.assertExists(goalId);
    this.db.prepare(
      `UPDATE goals_v2
          SET wake_at = @wakeAt,
              status  = CASE WHEN status = 'active' THEN 'sleeping' ELSE status END
        WHERE id = @id`,
    ).run({ id: goalId, wakeAt });
    log.info({ goalId, wakeAt }, 'Goal sleep scheduled');
  }

  /**
   * Record a completed work session.
   * Optionally advances progress (0–100); setting ≥100 auto-completes the goal.
   */
  recordWorkSession(goalId: string, progress?: number): void {
    this.assertExists(goalId);

    if (progress !== undefined) {
      if (typeof progress !== 'number' || progress < 0 || progress > 100) {
        throw new RangeError('GoalEngineV2.recordWorkSession: progress must be 0–100');
      }
      this.db.prepare(
        `UPDATE goals_v2
            SET last_worked_at = @now,
                progress       = @progress,
                status         = CASE WHEN @progress >= 100 THEN 'completed' ELSE status END
          WHERE id = @id`,
      ).run({ id: goalId, now: new Date().toISOString(), progress });
    } else {
      this.db.prepare(
        `UPDATE goals_v2 SET last_worked_at = @now WHERE id = @id`,
      ).run({ id: goalId, now: new Date().toISOString() });
    }

    log.debug({ goalId, progress }, 'Work session recorded');
  }

  /** Pause an active goal. */
  pauseGoal(goalId: string): void {
    this.assertExists(goalId);
    this.db.prepare(`UPDATE goals_v2 SET status = 'paused' WHERE id = @id`).run({ id: goalId });
    log.info({ goalId }, 'Goal paused');
  }

  /** Resume a paused goal. */
  resumeGoal(goalId: string): void {
    this.assertExists(goalId);
    this.db.prepare(`UPDATE goals_v2 SET status = 'active' WHERE id = @id`).run({ id: goalId });
    log.info({ goalId }, 'Goal resumed');
  }

  /** Mark a goal as completed with full progress. */
  completeGoal(goalId: string): void {
    this.assertExists(goalId);
    this.db.prepare(
      `UPDATE goals_v2
          SET status = 'completed', progress = 100, last_worked_at = @now
        WHERE id = @id`,
    ).run({ id: goalId, now: new Date().toISOString() });
    log.info({ goalId }, 'Goal completed');
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Return goals eligible to be worked on right now:
   *   - status = 'active' with no future wake_at, OR
   *   - status = 'sleeping' with wake_at <= now
   */
  getGoalsReadyToWork(): GoalV2[] {
    const now  = new Date().toISOString();
    const rows = this.db.prepare(
      `SELECT * FROM goals_v2
        WHERE (status = 'active'   AND (wake_at IS NULL OR wake_at <= @now))
           OR (status = 'sleeping' AND wake_at <= @now)
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 0
            WHEN 'high'     THEN 1
            WHEN 'normal'   THEN 2
            WHEN 'low'      THEN 3
            ELSE 4
          END,
          created_at ASC`,
    ).all({ now }) as GoalRow[];

    return rows.map(rowToGoal);
  }

  /** Retrieve a single goal by id. Returns undefined when not found. */
  getGoal(id: string): GoalV2 | undefined {
    if (!id) return undefined;
    const row = this.db.prepare(
      `SELECT * FROM goals_v2 WHERE id = @id`,
    ).get({ id }) as GoalRow | undefined;
    return row ? rowToGoal(row) : undefined;
  }

  /** List all goals, optionally filtered. */
  listGoals(filter?: ListGoalsFilter): GoalV2[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter?.priority) {
      conditions.push('priority = @priority');
      params['priority'] = filter.priority;
    }

    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      const placeholders = statuses.map((_, i) => `@s${i}`).join(', ');
      conditions.push(`status IN (${placeholders})`);
      statuses.forEach((s, i) => { params[`s${i}`] = s; });
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows  = this.db.prepare(
      `SELECT * FROM goals_v2 ${where}
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 0
            WHEN 'high'     THEN 1
            WHEN 'normal'   THEN 2
            WHEN 'low'      THEN 3
            ELSE 4
          END,
          created_at ASC`,
    ).all(params) as GoalRow[];

    return rows.map(rowToGoal);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private getGoalOrThrow(id: string): GoalV2 {
    const goal = this.getGoal(id);
    if (!goal) throw new RangeError(`GoalEngineV2: goal not found: ${id}`);
    return goal;
  }

  private assertExists(goalId: string): void {
    if (!goalId) throw new TypeError('goalId is required');
    const row = this.db.prepare(`SELECT id FROM goals_v2 WHERE id = @id`).get({ id: goalId });
    if (!row)   throw new RangeError(`GoalEngineV2: goal not found: ${goalId}`);
  }

  /** Close the database connection. Call on graceful shutdown. */
  close(): void {
    this.db.close();
    log.info({}, 'GoalEngineV2 database closed');
  }
}
