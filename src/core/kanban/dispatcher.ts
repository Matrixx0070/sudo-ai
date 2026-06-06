/**
 * @file dispatcher.ts
 * @description KanbanDispatcher — periodic daemon that reclaims stale tasks,
 *              promotes ready tasks, and assigns idle workers.
 *
 * Inspired by Hermes Agent's Kanban dispatcher. Runs on a configurable tick
 * cycle (default 60s) to keep the board healthy and workers utilized.
 *
 * Tick lifecycle:
 *   1. reclaimStale  — 'in_progress' tasks with no heartbeat → back to 'todo'
 *   2. promoteReady  — 'todo' tasks whose dependencies are met → marked ready
 *   3. assignWorkers  — idle swarm workers assigned to ready tasks → 'in_progress'
 *
 * Kill-switch: SUDO_DISPATCHER_DISABLE=1 disables all operations.
 */

import { KanbanBoard } from './kanban-board.js';
import { SwarmManager } from '../swarm/swarm-manager.js';
import { createLogger } from '../shared/logger.js';
import type { KanbanTask } from './kanban-types.js';

const log = createLogger('kanban:dispatcher');

const KILL_SWITCH = 'SUDO_DISPATCHER_DISABLE';
function isDisabled(): boolean { return process.env[KILL_SWITCH] === '1'; }

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Configuration for the dispatcher daemon. */
export interface DispatcherConfig {
  tickIntervalMs: number;
  staleThresholdMs: number;
  maxWorkersPerTask: number;
  enableCircuitBreaker: boolean;
}

/** Snapshot of the dispatcher's current operational state. */
export interface DispatcherState {
  isRunning: boolean;
  lastTickAt: string;
  tasksReclaimed: number;
  tasksPromoted: number;
  workersAssigned: number;
  errors: number;
}

/** Cumulative statistics across the lifetime of the dispatcher. */
export interface DispatcherStats {
  totalTicks: number;
  totalReclaimed: number;
  totalPromoted: number;
  totalAssigned: number;
  totalErrors: number;
  avgTickTimeMs: number;
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DispatcherConfig = {
  tickIntervalMs: 60_000,
  staleThresholdMs: 300_000,
  maxWorkersPerTask: 1,
  enableCircuitBreaker: true,
};

const CIRCUIT_BREAKER_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// KanbanDispatcher class
// ---------------------------------------------------------------------------

export class KanbanDispatcher {
  private readonly kanbanBoard: KanbanBoard;
  private readonly swarmManager: SwarmManager;
  private readonly config: DispatcherConfig;

  private timerHandle: ReturnType<typeof setInterval> | null = null;

  /** Internal set of "ready" task IDs (todo + dependencies met, awaiting worker). */
  private readonly readyTaskIds = new Set<string>();

  // Per-tick counters (reset each tick)
  private tickReclaimed = 0;
  private tickPromoted  = 0;
  private tickAssigned  = 0;
  private tickErrors    = 0;

  // Lifetime accumulators
  private totalTicks     = 0;
  private totalReclaimed = 0;
  private totalPromoted  = 0;
  private totalAssigned  = 0;
  private totalErrors    = 0;
  private tickTimes: number[] = [];

  // Circuit breaker
  private consecutiveErrors = 0;
  private circuitOpen = false;

  private lastTickAt = '';

  constructor(
    kanbanBoard: KanbanBoard,
    swarmManager: SwarmManager,
    config?: Partial<DispatcherConfig>,
  ) {
    this.kanbanBoard = kanbanBoard;
    this.swarmManager = swarmManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info(
      { tickIntervalMs: this.config.tickIntervalMs, staleThresholdMs: this.config.staleThresholdMs },
      'KanbanDispatcher constructed',
    );
  }

  // -- Lifecycle -----------------------------------------------------------

  /** Start the periodic tick loop. Safe to call multiple times. */
  start(): void {
    if (isDisabled()) { log.warn('SUDO_DISPATCHER_DISABLE=1 — not starting'); return; }
    if (this.timerHandle !== null) { log.warn('Already running — ignoring start()'); return; }

    // First tick fires immediately, then on interval
    this.tick().catch((e: unknown) => log.error({ err: String(e) }, 'Initial tick failed'));
    this.timerHandle = setInterval(
      () => this.tick().catch((e: unknown) => log.error({ err: String(e) }, 'Scheduled tick failed')),
      this.config.tickIntervalMs,
    );
    log.info({ intervalMs: this.config.tickIntervalMs }, 'KanbanDispatcher started');
  }

  /** Stop the periodic tick loop. Can be restarted later. */
  stop(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
      log.info('KanbanDispatcher stopped');
    }
  }

  // -- Core dispatch cycle -------------------------------------------------

  /** Execute one full dispatch cycle: reclaim → promote → assign. */
  async tick(): Promise<void> {
    if (isDisabled()) return;
    if (this.config.enableCircuitBreaker && this.circuitOpen) {
      log.warn('tick skipped: circuit breaker open');
      return;
    }

    const t0 = Date.now();
    this.tickReclaimed = 0;
    this.tickPromoted  = 0;
    this.tickAssigned  = 0;
    this.tickErrors    = 0;

    try {
      this.tickReclaimed = this.reclaimStale();
      this.tickPromoted  = this.promoteReady();
      this.tickAssigned  = this.assignWorkers();
      this.consecutiveErrors = 0;
    } catch (err) {
      this.tickErrors++;
      this.totalErrors++;
      this.consecutiveErrors++;
      log.error({ err: String(err), consecutiveErrors: this.consecutiveErrors }, 'tick error');
      if (this.config.enableCircuitBreaker && this.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpen = true;
        log.error('Circuit breaker tripped — dispatcher paused');
      }
    }

    const elapsed = Date.now() - t0;
    this.tickTimes.push(elapsed);
    if (this.tickTimes.length > 100) this.tickTimes = this.tickTimes.slice(-100);

    this.totalTicks++;
    this.totalReclaimed += this.tickReclaimed;
    this.totalPromoted  += this.tickPromoted;
    this.totalAssigned  += this.tickAssigned;
    this.lastTickAt = new Date().toISOString();

    log.info({ reclaimed: this.tickReclaimed, promoted: this.tickPromoted, assigned: this.tickAssigned, tickMs: elapsed }, 'tick complete');
  }

  // -- Phase 1: Reclaim stale tasks ----------------------------------------

  /** Find 'in_progress' tasks past staleThresholdMs with no heartbeat, move back to 'todo'. */
  reclaimStale(): number {
    if (isDisabled()) return 0;
    const now = Date.now();
    let reclaimed = 0;

    for (const task of this.kanbanBoard.listTasks({ status: 'in_progress' })) {
      const lastBeat = new Date(task.updatedAt).getTime();
      const ageMs = now - (Number.isNaN(lastBeat) ? 0 : lastBeat);
      if (ageMs > this.config.staleThresholdMs) {
        if (this.kanbanBoard.moveTask(task.id, 'todo')) {
          this.readyTaskIds.delete(task.id);
          reclaimed++;
          log.info({ taskId: task.id, staleMs: ageMs }, 'Reclaimed stale task → todo');
        }
      }
    }
    return reclaimed;
  }

  // -- Phase 2: Promote ready tasks ----------------------------------------

  /** Identify 'todo' tasks whose dependencies (parentId) are 'done' and mark them ready. */
  promoteReady(): number {
    if (isDisabled()) return 0;
    let promoted = 0;

    for (const task of this.kanbanBoard.listTasks({ status: 'todo' })) {
      if (this.readyTaskIds.has(task.id)) continue;
      if (this.areDependenciesMet(task)) {
        this.readyTaskIds.add(task.id);
        promoted++;
        log.info({ taskId: task.id, parentId: task.parentId ?? 'none' }, 'Task promoted to ready');
      }
    }
    // Prune stale entries (task was moved/deleted externally)
    for (const id of this.readyTaskIds) {
      const t = this.kanbanBoard.getTask(id);
      if (!t || t.status !== 'todo') this.readyTaskIds.delete(id);
    }
    return promoted;
  }

  /** A task's dependency is its parentId — the parent must be 'done'. null parentId = no deps. */
  private areDependenciesMet(task: KanbanTask): boolean {
    if (!task.parentId) return true;
    const parent = this.kanbanBoard.getTask(task.parentId);
    if (!parent) return true; // deleted parent → resolved
    return parent.status === 'done';
  }

  // -- Phase 3: Assign workers to ready tasks -------------------------------

  /** Assign idle swarm workers to ready tasks. Moves task to 'in_progress' on assignment. */
  assignWorkers(): number {
    if (isDisabled()) return 0;
    const idleAgents = this.swarmManager.listAgents({ status: 'idle' });
    if (idleAgents.length === 0) return 0;

    const available = new Set(idleAgents.map(a => a.id));
    let assigned = 0;

    // Sort ready tasks: priority desc, then age asc
    const sorted = this.getSortedReadyTasks();

    for (const task of sorted) {
      if (available.size === 0) break;
      const agent = this.findBestAgent(task, available);
      if (!agent) continue;

      // Move task to 'in_progress' first — rollback if assignment fails
      if (!this.kanbanBoard.moveTask(task.id, 'in_progress')) {
        this.readyTaskIds.delete(task.id);
        continue;
      }
      try {
        this.swarmManager.assignTask({
          id: task.id,
          description: task.body,
          requiredRole: task.skills[0] ?? 'general',
          priority: task.priority,
          status: 'pending',
        });
        this.kanbanBoard.updateTask(task.id, { assignee: agent.id });
        available.delete(agent.id);
        this.readyTaskIds.delete(task.id);
        assigned++;
        log.info({ taskId: task.id, agentId: agent.id }, 'Worker assigned');
      } catch (err) {
        this.kanbanBoard.moveTask(task.id, 'todo'); // rollback
        log.warn({ taskId: task.id, err: String(err) }, 'Assignment failed — rolled back');
      }
    }
    return assigned;
  }

  /** Sort ready tasks by priority (highest first), then by age (oldest first). */
  private getSortedReadyTasks(): KanbanTask[] {
    const tasks: KanbanTask[] = [];
    for (const id of this.readyTaskIds) {
      const t = this.kanbanBoard.getTask(id);
      if (t && t.status === 'todo') tasks.push(t);
    }
    tasks.sort((a, b) =>
      a.priority !== b.priority ? b.priority - a.priority : a.createdAt.localeCompare(b.createdAt),
    );
    return tasks;
  }

  /** Skill-based agent matching with fallback to any idle agent. */
  private findBestAgent(task: KanbanTask, available: Set<string>): { id: string; role: string } | null {
    for (const skill of task.skills) {
      const a = this.swarmManager.getBestAgent(skill);
      if (a && available.has(a.id)) return { id: a.id, role: a.role };
    }
    for (const agentId of available) {
      const a = this.swarmManager.getAgent(agentId);
      if (a) return { id: a.id, role: a.role };
    }
    return null;
  }

  // -- State & Stats ------------------------------------------------------

  /** Snapshot of current operational state. */
  getState(): DispatcherState {
    return {
      isRunning: this.timerHandle !== null,
      lastTickAt: this.lastTickAt,
      tasksReclaimed: this.tickReclaimed,
      tasksPromoted: this.tickPromoted,
      workersAssigned: this.tickAssigned,
      errors: this.tickErrors,
    };
  }

  /** Cumulative lifetime stats with rolling avg tick time (last 100 ticks). */
  getStats(): DispatcherStats {
    const avgTickTimeMs = this.tickTimes.length > 0
      ? Math.round(this.tickTimes.reduce((s, t) => s + t, 0) / this.tickTimes.length)
      : 0;
    return {
      totalTicks: this.totalTicks,
      totalReclaimed: this.totalReclaimed,
      totalPromoted: this.totalPromoted,
      totalAssigned: this.totalAssigned,
      totalErrors: this.totalErrors,
      avgTickTimeMs,
    };
  }
}