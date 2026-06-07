/**
 * @file session-lanes.ts
 * @description SessionLaneManager — multi-lane task queue for SUDO-AI v4.
 *
 * Provides parallel execution across different lane types while serializing
 * tasks within the same lane type + key combination.
 *
 * Lane types:
 * - 'default': Standard session tasks
 * - 'nested': Nested sub-sessions (e.g., tool evaluation contexts)
 * - 'subagent': Autonomous subagent executions
 * - 'cron': Scheduled background tasks
 *
 * Kill-switch: SUDO_SESSION_LANES_DISABLE=1 routes everything to 'default'
 */

import { nanoid } from 'nanoid';
import { KeyedAsyncQueue } from './queue.js';
import { createLogger } from '../shared/index.js';

const log = createLogger('sessions:lanes');

/** Lane type for session task categorization */
export type SessionLaneType = 'default' | 'nested' | 'subagent' | 'cron';

/** Internal tracking for active tasks */
interface ActiveTask {
  laneType: SessionLaneType;
  laneKey: string;
  startedAt: number;
}

/**
 * SessionLaneManager manages parallel task execution across different lane types.
 *
 * Different lane types run in parallel. Same lane type + same key serializes.
 */
export class SessionLaneManager {
  /** Per-lane-type queues for parallel execution */
  private readonly queues: Record<SessionLaneType, KeyedAsyncQueue>;

  /** Track currently running tasks for observability */
  private readonly activeTasks = new Map<string, ActiveTask>();

  /** Track queue depth per lane key */
  private readonly queueDepths = new Map<string, number>();

  /** Kill-switch check */
  private readonly isDisabled: boolean;

  constructor() {
    this.queues = {
      default: new KeyedAsyncQueue(),
      nested: new KeyedAsyncQueue(),
      subagent: new KeyedAsyncQueue(),
      cron: new KeyedAsyncQueue(),
    };
    this.isDisabled = process.env.SUDO_SESSION_LANES_DISABLE === '1';

    if (this.isDisabled) {
      log.warn('Session lanes disabled via kill-switch, all tasks route to default lane');
    }
  }

  /**
   * Generate a composite key for internal tracking
   */
  private makeTaskKey(laneType: SessionLaneType, laneKey: string): string {
    return `${laneType}:${laneKey}`;
  }

  /**
   * Enqueue a task for execution.
   *
   * @param laneType - Type of lane (determines parallelization bucket)
   * @param laneKey - Unique key within lane type (e.g., sessionId)
   * @param task - Async task to execute
   * @returns Promise resolving to task result
   *
   * Behavior:
   * - Different lane types run in parallel
   * - Same lane type + same key = serialized execution
   * - Same lane type + different key = parallel execution
   * - If SUDO_SESSION_LANES_DISABLE=1, all tasks route to 'default' lane
   */
  enqueue<T>(
    laneType: SessionLaneType,
    laneKey: string,
    task: () => Promise<T>
  ): Promise<T> {
    if (!laneKey || typeof laneKey !== 'string') {
      throw new TypeError('SessionLaneManager.enqueue: laneKey must be a non-empty string');
    }
    if (typeof task !== 'function') {
      throw new TypeError('SessionLaneManager.enqueue: task must be a function');
    }

    // Kill-switch: route everything to default lane
    const effectiveLaneType = this.isDisabled ? 'default' : laneType;
    const queue = this.queues[effectiveLaneType];

    const taskKey = this.makeTaskKey(effectiveLaneType, laneKey);

    // Unique per-invocation id so concurrent/serialized tasks sharing the same
    // composite key each get their own active-task entry (no overwrite, no
    // premature delete by a sibling task).
    const taskId = nanoid();

    // Track queue depth
    const currentDepth = this.queueDepths.get(taskKey) ?? 0;
    this.queueDepths.set(taskKey, currentDepth + 1);

    log.trace(
      { laneType: effectiveLaneType, laneKey, depth: currentDepth + 1 },
      'enqueue task'
    );

    return queue
      .enqueue(laneKey, async () => {
        // Track active task at start (when it actually begins running), so
        // queued-but-not-yet-running tasks are not counted as active.
        this.activeTasks.set(taskId, {
          laneType: effectiveLaneType,
          laneKey,
          startedAt: Date.now(),
        });
        try {
          return await task();
        } finally {
          // Decrement queue depth
          const depth = this.queueDepths.get(taskKey) ?? 1;
          if (depth <= 1) {
            this.queueDepths.delete(taskKey);
          } else {
            this.queueDepths.set(taskKey, depth - 1);
          }

          // Remove this invocation from active tasks
          this.activeTasks.delete(taskId);

          log.trace(
            { laneType: effectiveLaneType, laneKey },
            'task completed'
          );
        }
      })
      .catch((error) => {
        log.error({ laneType: effectiveLaneType, laneKey, error }, 'task failed');
        throw error;
      });
  }

  /**
   * Get the count of currently active (running) tasks.
   *
   * @param laneType - Optional filter by lane type
   * @returns Number of active tasks
   */
  getActiveCount(laneType?: SessionLaneType): number {
    if (laneType === undefined) {
      return this.activeTasks.size;
    }
    let count = 0;
    for (const task of this.activeTasks.values()) {
      if (task.laneType === laneType) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the queue depth (pending tasks) for a specific lane key.
   *
   * @param laneKey - The lane key to check
   * @returns Number of tasks waiting in queue (0 if not queued)
   */
  getQueueDepth(laneKey: string): number {
    if (!laneKey || typeof laneKey !== 'string') {
      throw new TypeError('SessionLaneManager.getQueueDepth: laneKey must be a non-empty string');
    }

    // Check all lane types for this key
    let totalDepth = 0;
    for (const lt of Object.keys(this.queues) as SessionLaneType[]) {
      const taskKey = this.makeTaskKey(lt, laneKey);
      totalDepth += this.queueDepths.get(taskKey) ?? 0;
    }
    return totalDepth;
  }

  /**
   * Drain tasks from a specific lane key.
   *
   * Note: This does not cancel running tasks, only prevents new tasks from
   * being queued under this key. Returns the number of lane types affected.
   *
   * @param laneKey - The lane key to drain
   * @returns Number of lane types that had tasks for this key
   */
  drain(laneKey: string): number {
    if (!laneKey || typeof laneKey !== 'string') {
      throw new TypeError('SessionLaneManager.drain: laneKey must be a non-empty string');
    }

    let drainedCount = 0;
    for (const lt of Object.keys(this.queues) as SessionLaneType[]) {
      const taskKey = this.makeTaskKey(lt, laneKey);
      const hasActive = [...this.activeTasks.values()].some(
        (t) => t.laneType === lt && t.laneKey === laneKey
      );
      if (this.queueDepths.has(taskKey) || hasActive) {
        this.queueDepths.delete(taskKey);
        // Note: We don't remove activeTasks here as they're already running
        // The activeTasks map is cleaned up when tasks complete
        drainedCount++;
      }
    }

    if (drainedCount > 0) {
      log.info({ laneKey, drainedCount }, 'drained lane key');
    }

    return drainedCount;
  }

  /**
   * Get statistics about the current state of all lanes.
   */
  getStats(): {
    totalActive: number;
    byLaneType: Record<SessionLaneType, number>;
    totalQueued: number;
  } {
    const byLaneType: Record<SessionLaneType, number> = {
      default: 0,
      nested: 0,
      subagent: 0,
      cron: 0,
    };

    for (const task of this.activeTasks.values()) {
      byLaneType[task.laneType]++;
    }

    let totalQueued = 0;
    for (const depth of this.queueDepths.values()) {
      totalQueued += depth;
    }

    return {
      totalActive: this.activeTasks.size,
      byLaneType,
      totalQueued,
    };
  }

  /**
   * Check if lanes are enabled (kill-switch status).
   */
  isEnabled(): boolean {
    return !this.isDisabled;
  }
}

// Singleton instance for global use
let globalLaneManager: SessionLaneManager | undefined;

/**
 * Get or create the global SessionLaneManager instance.
 */
export function getLaneManager(): SessionLaneManager {
  if (!globalLaneManager) {
    globalLaneManager = new SessionLaneManager();
  }
  return globalLaneManager;
}

/**
 * Reset the global instance (for testing).
 */
export function resetLaneManager(): void {
  globalLaneManager = undefined;
}
