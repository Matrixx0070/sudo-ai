/**
 * Orchestration module — task queue and executor.
 *
 * Public surface:
 *   TaskQueue     — priority-based, dependency-aware SQLite-backed queue
 *   TaskExecutor  — poll-driven parallel task runner with handler registry
 *
 * Usage:
 * ```ts
 * import { TaskQueue, TaskExecutor } from '@core/orchestration';
 *
 * const queue = new TaskQueue('/root/sudo-ai-v4/data/mind.db');
 * const executor = new TaskExecutor(queue);
 * executor.registerHandler('my.task', async (task, signal) => {
 *   // ...do work...
 *   return { output: 'done' };
 * });
 * executor.start();
 * ```
 */

export { TaskQueue } from './task-queue.js';
export type {
  Task,
  TaskPriority,
  TaskStatus,
  QueueStats,
  EnqueueInput,
} from './task-queue.js';

export { TaskExecutor } from './executor.js';
export type { TaskHandler, ExecutorOptions } from './executor.js';
