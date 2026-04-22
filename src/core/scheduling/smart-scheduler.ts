/**
 * SmartScheduler — dependency-aware, audience-optimised scheduling backed by better-sqlite3.
 *
 * Features:
 *   - Dependency chains: tasks block until all listed dep IDs have last_run set
 *   - IST peak-hour optimisation: auto-assigns next optimal slot on schedule()
 *   - Cooldown enforcement: skips tasks that ran too recently
 *   - Priority bypass: 'critical' tasks bypass the next_run gate
 *   - optimizeSchedule: reschedules overdue normal/low tasks to IST peak slots
 *
 * Types, DDL, constants, and helpers live in smart-scheduler-schema.ts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  initSmartScheduleSchema,
  rowToTask,
  nextPeakISO,
  nowInIST,
  isWeekendIST,
  PEAK_HOURS_IST,
  MORNING_CONTENT,
  type ScheduledTask,
  type NewTask,
  type SchedulerStats,
  type ScheduleRow,
} from './smart-scheduler-schema.js';

export type { ScheduledTask, NewTask, SchedulerStats };

const logger = createLogger('smart-scheduler');

const VALID_PRIORITIES = new Set<string>(['critical', 'high', 'normal', 'low']);

export class SmartScheduler {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('SmartScheduler: dbPath must be a non-empty string');
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    initSmartScheduleSchema(this.db);
    logger.info({ dbPath }, 'SmartScheduler initialised');
  }

  // ---------------------------------------------------------------------------
  // schedule
  // ---------------------------------------------------------------------------

  /**
   * Register a new task. Returns the generated UUID.
   * nextRun is computed from optimalTime (HH:MM IST) when provided,
   * otherwise from the next audience peak slot for the task's name.
   */
  schedule(task: NewTask): string {
    if (!task.name?.trim()) throw new Error('schedule: name is required');
    if (!VALID_PRIORITIES.has(task.priority)) {
      throw new Error(`schedule: invalid priority "${task.priority}"`);
    }
    if ((task.cooldownMs ?? 0) < 0) {
      throw new Error('schedule: cooldownMs must be >= 0');
    }

    const id = randomUUID();
    const deps = Array.isArray(task.dependencies) ? task.dependencies : [];

    let nextRun: string | null = null;
    if (task.optimalTime) {
      const [hh, mm] = task.optimalTime.split(':').map(Number);
      if (hh !== undefined && mm !== undefined && !isNaN(hh) && !isNaN(mm)) {
        const istNow = nowInIST();
        const candidate = new Date(istNow);
        candidate.setHours(hh, mm, 0, 0);
        if (candidate <= istNow) candidate.setDate(candidate.getDate() + 1);
        nextRun = candidate.toISOString();
      }
    } else {
      nextRun = this.getOptimalPostTime(task.name);
    }

    this.db.prepare(`
      INSERT INTO smart_schedule
        (id, name, cron_expression, dependencies, optimal_time, timezone,
         cooldown_ms, priority, enabled, last_run, next_run, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      task.name.trim(),
      task.cronExpression ?? null,
      JSON.stringify(deps),
      task.optimalTime ?? null,
      task.timezone ?? 'Asia/Kolkata',
      task.cooldownMs ?? 0,
      task.priority,
      task.enabled ? 1 : 0,
      task.lastRun ?? null,
      nextRun,
      JSON.stringify(task.payload ?? {}),
    );

    logger.info({ id, name: task.name, priority: task.priority, nextRun }, 'Task scheduled');
    return id;
  }

  // ---------------------------------------------------------------------------
  // unschedule
  // ---------------------------------------------------------------------------

  /** Delete a task by ID. Throws if not found. */
  unschedule(id: string): void {
    if (!id?.trim()) throw new Error('unschedule: id is required');
    const result = this.db.prepare('DELETE FROM smart_schedule WHERE id = ?').run(id);
    if (result.changes === 0) throw new Error(`unschedule: task not found: ${id}`);
    logger.info({ id }, 'Task unscheduled');
  }

  // ---------------------------------------------------------------------------
  // getOptimalPostTime
  // ---------------------------------------------------------------------------

  /**
   * Returns ISO-8601 of next IST peak slot for the given content type.
   * Morning content types (news, briefing, etc.) prefer early-hour slots.
   */
  getOptimalPostTime(contentType: string): string {
    const istNow = nowInIST();
    const peakHours = isWeekendIST(istNow) ? PEAK_HOURS_IST.weekend : PEAK_HOURS_IST.weekday;
    const preferMorning = MORNING_CONTENT.has((contentType ?? '').toLowerCase());
    const result = nextPeakISO(peakHours, istNow, preferMorning);
    logger.debug({ contentType, result }, 'Optimal post time computed');
    return result;
  }

  // ---------------------------------------------------------------------------
  // areDependenciesMet
  // ---------------------------------------------------------------------------

  /**
   * Returns true when every dependency of the given taskId has a non-null last_run.
   * Throws if the taskId itself does not exist.
   */
  areDependenciesMet(taskId: string): boolean {
    if (!taskId?.trim()) throw new Error('areDependenciesMet: taskId is required');
    const row = this.db
      .prepare('SELECT dependencies FROM smart_schedule WHERE id = ?')
      .get(taskId) as { dependencies: string } | undefined;
    if (!row) throw new Error(`areDependenciesMet: task not found: ${taskId}`);

    let deps: string[] = [];
    try { deps = JSON.parse(row.dependencies) as string[]; } catch { deps = []; }
    if (!deps.length) return true;

    for (const depId of deps) {
      const dep = this.db
        .prepare('SELECT last_run FROM smart_schedule WHERE id = ?')
        .get(depId) as { last_run: string | null } | undefined;
      if (!dep || dep.last_run === null) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // getReadyTasks
  // ---------------------------------------------------------------------------

  /**
   * Tasks eligible to run now:
   *   enabled=1, next_run <= now (critical tasks skip this gate),
   *   cooldown satisfied, all dependencies met.
   * Returns in priority order (critical first).
   */
  getReadyTasks(): ScheduledTask[] {
    const now = new Date().toISOString();
    const nowMs = Date.now();

    const rows = this.db.prepare(`
      SELECT * FROM smart_schedule
      WHERE enabled = 1
        AND (priority = 'critical' OR next_run IS NULL OR next_run <= ?)
      ORDER BY
        CASE priority
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1
          WHEN 'normal'   THEN 2 WHEN 'low'  THEN 3 ELSE 4
        END, next_run ASC
    `).all(now) as ScheduleRow[];

    const ready: ScheduledTask[] = [];
    for (const row of rows) {
      if (row.cooldown_ms > 0 && row.last_run) {
        const elapsed = nowMs - new Date(row.last_run).getTime();
        if (elapsed < row.cooldown_ms) {
          logger.debug({ id: row.id }, 'Task skipped: cooldown active');
          continue;
        }
      }

      let deps: string[] = [];
      try { deps = JSON.parse(row.dependencies) as string[]; } catch { deps = []; }
      if (deps.length > 0) {
        let allMet = true;
        for (const depId of deps) {
          const dep = this.db
            .prepare('SELECT last_run FROM smart_schedule WHERE id = ?')
            .get(depId) as { last_run: string | null } | undefined;
          if (!dep || dep.last_run === null) { allMet = false; break; }
        }
        if (!allMet) {
          logger.debug({ id: row.id }, 'Task skipped: dependencies not met');
          continue;
        }
      }
      ready.push(rowToTask(row));
    }

    logger.debug({ count: ready.length }, 'Ready tasks evaluated');
    return ready;
  }

  // ---------------------------------------------------------------------------
  // optimizeSchedule
  // ---------------------------------------------------------------------------

  /**
   * Reschedules all overdue enabled normal/low tasks to successive IST peak
   * slots (1 hour apart) to prevent execution pile-ups.
   */
  optimizeSchedule(): void {
    const now = new Date().toISOString();
    const overdue = this.db.prepare(`
      SELECT * FROM smart_schedule
      WHERE enabled = 1 AND priority IN ('normal', 'low')
        AND (next_run IS NULL OR next_run < ?)
    `).all(now) as ScheduleRow[];

    if (overdue.length === 0) {
      logger.info('optimizeSchedule: no overdue tasks');
      return;
    }

    const istNow = nowInIST();
    const peakHours = isWeekendIST(istNow) ? PEAK_HOURS_IST.weekend : PEAK_HOURS_IST.weekday;
    let slotBase = new Date(nextPeakISO(peakHours, istNow, false));

    const update = this.db.prepare('UPDATE smart_schedule SET next_run = ? WHERE id = ?');
    const tx = this.db.transaction((tasks: ScheduleRow[]) => {
      for (const task of tasks) {
        update.run(slotBase.toISOString(), task.id);
        logger.info({ id: task.id, name: task.name, nextRun: slotBase.toISOString() }, 'Task rescheduled');
        slotBase = new Date(slotBase.getTime() + 60 * 60 * 1000);
      }
    });
    tx(overdue);
    logger.info({ rescheduled: overdue.length }, 'optimizeSchedule complete');
  }

  // ---------------------------------------------------------------------------
  // listTasks / getStats
  // ---------------------------------------------------------------------------

  listTasks(filter?: { enabled?: boolean }): ScheduledTask[] {
    const ORDER = `ORDER BY CASE priority
      WHEN 'critical' THEN 0 WHEN 'high' THEN 1
      WHEN 'normal'   THEN 2 WHEN 'low'  THEN 3 ELSE 4
    END, next_run ASC`;

    if (filter?.enabled !== undefined) {
      const rows = this.db
        .prepare(`SELECT * FROM smart_schedule WHERE enabled = ? ${ORDER}`)
        .all(filter.enabled ? 1 : 0) as ScheduleRow[];
      return rows.map(rowToTask);
    }
    const rows = this.db.prepare(`SELECT * FROM smart_schedule ${ORDER}`).all() as ScheduleRow[];
    return rows.map(rowToTask);
  }

  getStats(): SchedulerStats {
    const total   = (this.db.prepare('SELECT COUNT(*) as c FROM smart_schedule').get() as { c: number }).c;
    const enabled = (this.db.prepare('SELECT COUNT(*) as c FROM smart_schedule WHERE enabled = 1').get() as { c: number }).c;
    const now = new Date().toISOString();
    const overdue = (this.db.prepare(
      `SELECT COUNT(*) as c FROM smart_schedule WHERE enabled = 1 AND next_run IS NOT NULL AND next_run < ?`
    ).get(now) as { c: number }).c;
    return { total, enabled, overdue };
  }
}
