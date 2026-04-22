/**
 * @file event-loop.ts
 * @description Autonomous Event Loop — SUDO-AI's persistent thinking process.
 * Checks pending tasks, resumes interrupted plans, detects anomalies, and
 * self-initiates actions when idle. State persisted to better-sqlite3.
 * Types and DDL live in schema.ts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  initAutonomySchema,
  rowToPlan,
  type Plan,
  type PlanStep,
  type EventLoopState,
  type PlanRow,
} from './schema.js';
import { GoalEngineV2 } from './goal-engine-v2.js';
import { WakeSleepCycle } from './wake-sleep-cycle.js';

export type { Plan, PlanStep, EventLoopState } from './schema.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('autonomy:event-loop');

// ---------------------------------------------------------------------------
// AutonomousEventLoop
// ---------------------------------------------------------------------------

export class AutonomousEventLoop {
  private readonly db: Database.Database;
  private state: EventLoopState;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param dbPath      Absolute path to mind.db (or any valid SQLite path).
   * @param goalEngine  Optional GoalEngineV2 instance. When provided, the think
   *                    cycle delegates goal-readiness checks to it.
   * @param wakeSleep   Optional WakeSleepCycle instance. When provided, its
   *                    tick() is called each think cycle to dispatch background
   *                    agents for goals that are ready to work on.
   */
  constructor(
    private readonly dbPath: string,
    private readonly goalEngine?: GoalEngineV2 | null,
    private readonly wakeSleep?: WakeSleepCycle | null,
  ) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('AutonomousEventLoop: dbPath must be a non-empty string');
    }

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    initAutonomySchema(this.db);

    this.state = {
      running:        false,
      pendingActions: [],
      lastThinkCycle: new Date(0).toISOString(),
      cycleCount:     0,
    };

    log.info({ dbPath }, 'AutonomousEventLoop initialised');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the event loop.
   * @param thinkIntervalMs How often the think-cycle fires. Default 300 000 ms (5 min).
   */
  start(thinkIntervalMs = 300_000): void {
    if (this.state.running) {
      log.warn('AutonomousEventLoop already running — ignoring start()');
      return;
    }
    if (thinkIntervalMs < 1_000) {
      throw new RangeError('thinkIntervalMs must be at least 1 000 ms');
    }

    this.state.running = true;
    this.timer = setInterval(() => {
      this._thinkCycle().catch(err => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Think cycle error');
      });
    }, thinkIntervalMs);

    log.info({ thinkIntervalMs }, 'Event loop started');

    // Run one immediate cycle so the first tick does not wait a full interval.
    setImmediate(() => {
      this._thinkCycle().catch(err => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Initial think cycle error');
      });
    });
  }

  /** Stop the event loop. In-flight thinkCycle calls are not interrupted. */
  stop(): void {
    if (!this.state.running) {
      log.warn('AutonomousEventLoop not running — ignoring stop()');
      return;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state.running = false;
    log.info({ cycleCount: this.state.cycleCount }, 'Event loop stopped');
  }

  getState(): EventLoopState {
    return { ...this.state };
  }

  // ---------------------------------------------------------------------------
  // Plan management (inter-session persistence)
  // ---------------------------------------------------------------------------

  /** Upsert a plan (insert or replace). */
  savePlan(plan: Plan): void {
    if (!plan.id?.trim()) throw new TypeError('savePlan: plan.id is required');
    if (!plan.name?.trim()) throw new TypeError('savePlan: plan.name is required');
    if (!Array.isArray(plan.steps)) throw new TypeError('savePlan: plan.steps must be an array');

    this.db.prepare(`
      INSERT INTO autonomous_plans (id, name, steps, current_step, status, created_at, updated_at)
      VALUES (:id, :name, :steps, :current_step, :status, :created_at, :updated_at)
      ON CONFLICT(id) DO UPDATE SET
        name         = excluded.name,
        steps        = excluded.steps,
        current_step = excluded.current_step,
        status       = excluded.status,
        updated_at   = excluded.updated_at
    `).run({
      id:           plan.id,
      name:         plan.name.trim(),
      steps:        JSON.stringify(plan.steps),
      current_step: plan.currentStep,
      status:       plan.status,
      created_at:   plan.createdAt,
      updated_at:   new Date().toISOString(),
    });

    if (plan.status === 'active') {
      this.state.currentPlan = plan.id;
    }

    log.info({ planId: plan.id, name: plan.name, status: plan.status }, 'Plan saved');
  }

  /** Load the most recently updated active plan, or null if none. */
  loadPlan(): Plan | null {
    const row = this.db.prepare(`
      SELECT * FROM autonomous_plans
      WHERE  status = 'active'
      ORDER  BY updated_at DESC
      LIMIT  1
    `).get() as PlanRow | undefined;

    if (!row) return null;
    return rowToPlan(row);
  }

  /** Mark all active plans as completed. */
  completePlan(): void {
    const updated = this.db.prepare(`
      UPDATE autonomous_plans
      SET    status     = 'completed',
             updated_at = :now
      WHERE  status     = 'active'
    `).run({ now: new Date().toISOString() });

    this.state.currentPlan = undefined;
    log.info({ changes: updated.changes }, 'Active plans marked completed');
  }

  // ---------------------------------------------------------------------------
  // Self-initiated actions
  // ---------------------------------------------------------------------------

  /** Enqueue a self-initiated action (stored persistently). Returns the row ID. */
  enqueueAction(action: string, reason: string, priority: 'high' | 'normal' | 'low' = 'normal'): number {
    if (!action?.trim()) throw new TypeError('enqueueAction: action is required');
    if (!reason?.trim()) throw new TypeError('enqueueAction: reason is required');

    const info = this.db.prepare(`
      INSERT INTO self_initiated_actions (action, reason, priority)
      VALUES (:action, :reason, :priority)
    `).run({ action: action.trim(), reason: reason.trim(), priority });

    log.info({ actionId: info.lastInsertRowid, action, priority }, 'Self-initiated action queued');
    return info.lastInsertRowid as number;
  }

  /** Create a new Plan object (not saved — call savePlan() to persist). */
  static createPlan(name: string, steps: Omit<PlanStep, 'id'>[]): Plan {
    if (!name?.trim()) throw new TypeError('createPlan: name is required');
    return {
      id:          randomUUID(),
      name:        name.trim(),
      steps:       steps.map(s => ({ ...s, id: randomUUID() })),
      currentStep: 0,
      createdAt:   new Date().toISOString(),
      status:      'active',
    };
  }

  // ---------------------------------------------------------------------------
  // Private — think cycle
  // ---------------------------------------------------------------------------

  private async _thinkCycle(): Promise<void> {
    const start = Date.now();
    this.state.cycleCount += 1;
    this.state.lastThinkCycle = new Date().toISOString();

    log.debug({ cycle: this.state.cycleCount }, 'Think cycle start');

    try {
      // 1. Count ready tasks in the task_queue table (may not exist yet)
      const readyTaskCount = this._countReadyTasks();

      // 2. Check for an interrupted plan from a previous session
      const activePlan = this.loadPlan();
      if (activePlan) {
        this.state.currentPlan = activePlan.id;
        const nextStep = activePlan.steps.find(s => s.status === 'pending');
        if (nextStep) {
          log.info(
            { planId: activePlan.id, stepId: nextStep.id, desc: nextStep.description },
            'Interrupted plan detected — next step pending',
          );
        }
      }

      // 3. Count pending self-initiated actions (overdue detection)
      const overdueCount = this._countPendingActions();

      // 4. Tick the WakeSleepCycle — dispatches background agents for any goals
      //    that GoalEngineV2 considers ready to work on this cycle.
      if (this.wakeSleep) {
        try {
          await this.wakeSleep.tick();
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'WakeSleepCycle.tick() threw — skipping this cycle',
          );
        }
      }

      // 5. Generate an idle action every 5 cycles when nothing else is active
      if (readyTaskCount === 0 && overdueCount === 0 && !activePlan) {
        this._maybeGenerateIdleAction();
      }

      const elapsed = Date.now() - start;
      log.debug({
        cycle:      this.state.cycleCount,
        elapsedMs:  elapsed,
        readyTasks: readyTaskCount,
        activePlan: activePlan?.id ?? null,
        pending:    overdueCount,
      }, 'Think cycle complete');

    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Think cycle internal error');
    }
  }

  private _countReadyTasks(): number {
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM task_queue WHERE status = 'queued'`
      ).get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0; // table may not exist yet
    }
  }

  private _countPendingActions(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM self_initiated_actions WHERE status = 'pending'`
    ).get() as { cnt: number };
    return row.cnt;
  }

  private _maybeGenerateIdleAction(): void {
    if (this.state.cycleCount % 5 !== 0) return;

    const action = 'meta.self-test';
    const reason = `Idle cycle ${this.state.cycleCount} — running self-diagnostics`;

    try {
      this.enqueueAction(action, reason, 'low');
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to enqueue idle action');
    }
  }
}
