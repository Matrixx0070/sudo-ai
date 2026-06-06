/**
 * @file worker-protocol.ts
 * @description Worker protocol with heartbeat, complete, block, and per-worker
 *              circuit breakers for SUDO-AI v4.
 *
 * Inspired by Hermes Agent's worker protocol. Each worker in the kanban pool
 * must obey a simple contract:
 *
 *   1. HEARTBEAT — Workers send heartbeats every 30 s while working on a task.
 *      Missing heartbeats cause the dispatcher to reclaim the task as stale.
 *
 *   2. COMPLETE — Workers signal task completion with a result and duration.
 *      Successes reset the circuit breaker; failures increment it.
 *
 *   3. BLOCK    — Workers signal they cannot proceed, with a reason and
 *      whether human attention is required. Blocked tasks go back to 'todo'.
 *
 * Circuit breaker (per-worker):
 *   - Closed  → worker is available (normal operation)
 *   - Open    → worker removed from pool after N consecutive failures
 *   - Half-open → after cooldown, worker gets one chance; success → closed,
 *     failure → back to open
 */

import { KanbanDispatcher } from './dispatcher.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('kanban:worker-protocol');

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Heartbeat sent by a worker while actively working on a task. */
export interface WorkerHeartbeat {
  workerId: string;
  taskId: string;
  /** Progress as a fraction 0..1 */
  progress: number;
  /** ISO-8601 timestamp */
  timestamp: string;
}

/** Signal that a worker has finished a task (success or failure). */
export interface WorkerCompletion {
  workerId: string;
  taskId: string;
  /** Human-readable result summary or error message */
  result: string;
  /** Wall-clock duration the worker spent on this task */
  durationMs: number;
  /** true = task succeeded, false = task failed */
  success: boolean;
}

/** Signal that a worker cannot proceed with a task. */
export interface WorkerBlock {
  workerId: string;
  taskId: string;
  /** Why the worker is blocked */
  reason: string;
  /** True if a human must intervene before this task can continue */
  requiresHumanAttention: boolean;
}

/** Circuit breaker tri-state. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Per-worker circuit breaker snapshot. */
export interface CircuitBreaker {
  workerId: string;
  state: CircuitState;
  failureCount: number;
  /** ISO-8601 timestamp of the most recent failure */
  lastFailureAt: string;
  /** ISO-8601 timestamp when the cooldown expires and state becomes half-open */
  cooldownUntil: string;
}

/** Tunable knobs for the worker protocol. */
export interface WorkerProtocolConfig {
  /** How often workers should send heartbeats (ms). Default 30 000. */
  heartbeatIntervalMs: number;
  /** Consecutive failures before the circuit breaker trips. Default 3. */
  circuitBreakerThreshold: number;
  /** How long a worker stays in cooldown once the breaker is open (ms). Default 300 000 (5 min). */
  circuitBreakerCooldownMs: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WorkerProtocolConfig = {
  heartbeatIntervalMs: 30_000,
  circuitBreakerThreshold: 3,
  circuitBreakerCooldownMs: 300_000,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Registry entry for a known worker. */
interface WorkerEntry {
  workerId: string;
  capabilities: string[];
  /** ISO-8601 timestamp of the most recent heartbeat */
  lastHeartbeatAt: string;
  /** Currently assigned task, if any */
  currentTaskId: string | null;
}

// ---------------------------------------------------------------------------
// WorkerProtocolManager
// ---------------------------------------------------------------------------

/**
 * Manages the worker lifecycle protocol: registration, heartbeats,
 * completion, blocking, and per-worker circuit breakers.
 *
 * The manager is layered on top of the KanbanDispatcher — it enriches the
 * dispatcher's view with health/availability information so that only
 * viable workers are assigned new work.
 */
export class WorkerProtocolManager {
  private readonly dispatcher: KanbanDispatcher;
  private readonly config: WorkerProtocolConfig;

  /** Known workers keyed by workerId. */
  private readonly workers = new Map<string, WorkerEntry>();

  /** Per-worker circuit breaker state. */
  private readonly breakers = new Map<string, CircuitBreaker>();

  // Lifetime stats
  private totalHeartbeats = 0;
  private totalCompletions = 0;
  private totalBlocks = 0;
  private circuitBreakerTrips = 0;

  constructor(
    dispatcher: KanbanDispatcher,
    config?: Partial<WorkerProtocolConfig>,
  ) {
    this.dispatcher = dispatcher;
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info(
      {
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        circuitBreakerThreshold: this.config.circuitBreakerThreshold,
        circuitBreakerCooldownMs: this.config.circuitBreakerCooldownMs,
      },
      'WorkerProtocolManager constructed',
    );
  }

  // -- Registration --------------------------------------------------------

  /**
   * Register a new worker with declared capabilities.
   * Safe to call again for an already-registered worker (capabilities are
   * replaced and the circuit breaker is reset to closed).
   */
  registerWorker(workerId: string, capabilities: string[]): void {
    const now = new Date().toISOString();
    this.workers.set(workerId, {
      workerId,
      capabilities,
      lastHeartbeatAt: now,
      currentTaskId: null,
    });

    // Initialize or reset the circuit breaker for this worker
    this.breakers.set(workerId, {
      workerId,
      state: 'closed',
      failureCount: 0,
      lastFailureAt: '',
      cooldownUntil: '',
    });

    log.info({ workerId, capabilities }, 'Worker registered');
  }

  /**
   * Unregister a worker. Removes it from the pool and clears its
   * circuit breaker state.
   */
  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
    this.breakers.delete(workerId);
    log.info({ workerId }, 'Worker unregistered');
  }

  // -- Heartbeat -----------------------------------------------------------

  /**
   * Process a heartbeat from a worker. Updates the worker's last-seen
   * timestamp and progress on its current task. If the worker's circuit
   * breaker is in half-open state and the cooldown has elapsed, a heartbeat
   * does NOT transition the state — only a successful completion does.
   */
  heartbeat(hb: WorkerHeartbeat): void {
    const entry = this.workers.get(hb.workerId);
    if (!entry) {
      log.warn({ workerId: hb.workerId }, 'Heartbeat from unknown worker — ignoring');
      return;
    }

    entry.lastHeartbeatAt = hb.timestamp;
    entry.currentTaskId = hb.taskId;
    this.totalHeartbeats++;

    log.debug(
      { workerId: hb.workerId, taskId: hb.taskId, progress: hb.progress },
      'Heartbeat received',
    );
  }

  // -- Completion ----------------------------------------------------------

  /**
   * Process a task completion signal from a worker.
   *
   * On **success**: the worker's circuit breaker failure count is reset to 0
   * and, if the breaker was half-open, it transitions back to closed.
   *
   * On **failure**: the breaker's failure count increments. If the count
   * reaches the threshold the breaker trips to 'open'. In half-open state a
   * single failure sends the breaker back to 'open' immediately.
   */
  complete(comp: WorkerCompletion): void {
    const entry = this.workers.get(comp.workerId);
    if (!entry) {
      log.warn({ workerId: comp.workerId }, 'Completion from unknown worker — ignoring');
      return;
    }

    entry.currentTaskId = null;
    this.totalCompletions++;

    const breaker = this.ensureBreaker(comp.workerId);
    const now = new Date().toISOString();

    if (comp.success) {
      // Reset failure count; close the breaker if it was half-open
      breaker.failureCount = 0;
      if (breaker.state === 'half-open') {
        breaker.state = 'closed';
        log.info({ workerId: comp.workerId }, 'Circuit breaker closed (success in half-open)');
      }
      log.info(
        { workerId: comp.workerId, taskId: comp.taskId, durationMs: comp.durationMs },
        'Task completed successfully',
      );
    } else {
      // Record the failure
      breaker.lastFailureAt = now;
      breaker.failureCount++;

      if (breaker.state === 'half-open') {
        // Single failure in half-open immediately reopens the breaker
        this.tripBreaker(breaker, now);
        log.warn({ workerId: comp.workerId }, 'Circuit breaker re-opened (failure in half-open)');
      } else if (breaker.failureCount >= this.config.circuitBreakerThreshold) {
        // Threshold reached — trip the breaker
        this.tripBreaker(breaker, now);
        log.warn(
          { workerId: comp.workerId, failureCount: breaker.failureCount },
          'Circuit breaker tripped — worker removed from pool',
        );
      } else {
        log.warn(
          { workerId: comp.workerId, taskId: comp.taskId, failureCount: breaker.failureCount },
          'Task failed',
        );
      }
    }
  }

  // -- Block ---------------------------------------------------------------

  /**
   * Process a block signal from a worker. The worker cannot proceed with
   * the current task. The task is returned to 'todo' so the dispatcher can
   * re-assign it, and the worker is freed for new work.
   *
   * A block does NOT count as a circuit-breaker failure — the worker is
   * signalling an external blocker, not a crash or logic error.
   */
  block(blk: WorkerBlock): void {
    const entry = this.workers.get(blk.workerId);
    if (!entry) {
      log.warn({ workerId: blk.workerId }, 'Block from unknown worker — ignoring');
      return;
    }

    entry.currentTaskId = null;
    this.totalBlocks++;

    log.info(
      {
        workerId: blk.workerId,
        taskId: blk.taskId,
        reason: blk.reason,
        requiresHumanAttention: blk.requiresHumanAttention,
      },
      'Worker blocked — task returned to todo',
    );

    // Note: the actual task state transition (back to 'todo') is handled by
    // the KanbanBoard through the dispatcher's reclaim cycle. The protocol
    // manager just records the block and frees the worker.
  }

  // -- Circuit breaker queries ---------------------------------------------

  /** Return the circuit breaker state for a given worker, or undefined. */
  getCircuitBreaker(workerId: string): CircuitBreaker | undefined {
    return this.breakers.get(workerId);
  }

  /**
   * Is the worker available for new work?
   *
   * A worker is available when:
   *  1. It is registered.
   *  2. Its circuit breaker is 'closed' or 'half-open' (with cooldown elapsed).
   *  3. It is not currently assigned a task.
   */
  isWorkerAvailable(workerId: string): boolean {
    const entry = this.workers.get(workerId);
    if (!entry) return false;

    // Worker is busy
    if (entry.currentTaskId !== null) return false;

    const breaker = this.breakers.get(workerId);
    if (!breaker) return true; // no breaker = available

    // Closed → available
    if (breaker.state === 'closed') return true;

    // Open → check cooldown
    if (breaker.state === 'open') {
      return this.isCooldownElapsed(breaker);
    }

    // Half-open → available (gets one chance)
    return true;
  }

  /** Return all worker IDs that are currently available for assignment. */
  getAvailableWorkers(): string[] {
    const available: string[] = [];
    for (const workerId of this.workers.keys()) {
      if (this.isWorkerAvailable(workerId)) {
        available.push(workerId);
      }
    }
    return available;
  }

  // -- Stats ---------------------------------------------------------------

  /** Cumulative lifetime statistics. */
  getStats(): {
    totalHeartbeats: number;
    totalCompletions: number;
    totalBlocks: number;
    circuitBreakerTrips: number;
  } {
    return {
      totalHeartbeats: this.totalHeartbeats,
      totalCompletions: this.totalCompletions,
      totalBlocks: this.totalBlocks,
      circuitBreakerTrips: this.circuitBreakerTrips,
    };
  }

  // -- Private helpers -----------------------------------------------------

  /** Get or create a circuit breaker entry for a worker. */
  private ensureBreaker(workerId: string): CircuitBreaker {
    let breaker = this.breakers.get(workerId);
    if (!breaker) {
      breaker = {
        workerId,
        state: 'closed',
        failureCount: 0,
        lastFailureAt: '',
        cooldownUntil: '',
      };
      this.breakers.set(workerId, breaker);
    }
    return breaker;
  }

  /**
   * Trip a circuit breaker to 'open' state.
   * Sets the cooldown deadline based on the configured cooldown duration.
   */
  private tripBreaker(breaker: CircuitBreaker, nowIso: string): void {
    const cooldownUntil = new Date(
      new Date(nowIso).getTime() + this.config.circuitBreakerCooldownMs,
    ).toISOString();

    breaker.state = 'open';
    breaker.cooldownUntil = cooldownUntil;
    this.circuitBreakerTrips++;
  }

  /**
   * Check whether a breaker's cooldown period has elapsed.
   * If it has, transition the breaker to 'half-open' so the worker gets
   * one more chance on its next task.
   */
  private isCooldownElapsed(breaker: CircuitBreaker): boolean {
    if (!breaker.cooldownUntil) return true;

    const now = Date.now();
    const deadline = new Date(breaker.cooldownUntil).getTime();

    if (now >= deadline) {
      breaker.state = 'half-open';
      log.info({ workerId: breaker.workerId }, 'Circuit breaker → half-open (cooldown elapsed)');
      return true;
    }

    return false;
  }
}