/**
 * @file executor-tick-closure.test.ts
 * @description Regression for the unhandled rejection surfaced by the full test
 * run: TaskExecutor._tick used a single shared `let task` that its fire-and-
 * forget `.catch()` closed over. The catch runs asynchronously — after the drain
 * loop has advanced and, on exit, reassigned the variable to null — so when an
 * earlier task rejected later, the catch read `null.id` and threw an *unhandled*
 * TypeError. The fix captures each task in a per-iteration const. This test
 * reproduces the exact timing (task rejects after the loop drains to null) and
 * asserts no unhandled rejection leaks.
 */

import { describe, it, expect } from 'vitest';
import { TaskExecutor } from '../../src/core/orchestration/executor.js';
import type { Task, TaskQueue } from '../../src/core/orchestration/task-queue.js';

describe('TaskExecutor._tick — per-iteration closure capture', () => {
  it('does not leak an unhandled rejection when a task rejects after the loop drains', async () => {
    const task = { id: 't-123', name: 'demo' } as Task;
    let dequeued = 0;
    // Minimal queue: yields one task, then null (loop-exit). _tick only needs dequeue().
    const queue = { dequeue: () => (dequeued++ === 0 ? task : null) } as unknown as TaskQueue;
    const exec = new TaskExecutor(queue);

    // Force the fire-and-forget execution to reject — the condition that made the
    // old shared-`task` closure read `null.id` once the loop had drained to null.
    (exec as unknown as { _executeTask: (t: Task) => Promise<void> })._executeTask = () =>
      Promise.reject(new Error('boom'));

    const leaked: Error[] = [];
    const onRej = (e: unknown): void => {
      // Only count THIS bug's signature, so a stray rejection from another
      // concurrently-running file in the worker can't make us flaky.
      if (e instanceof Error && /Cannot read properties of null|reading 'id'/.test(e.message)) {
        leaked.push(e);
      }
    };
    process.on('unhandledRejection', onRej);
    try {
      await (exec as unknown as { _tick: () => Promise<void> })._tick();
      // Let the rejected _executeTask + its .catch settle, then a macrotask so a
      // would-be unhandled rejection is surfaced by the runtime.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onRej);
    }

    expect(leaked).toHaveLength(0);
    expect(dequeued).toBe(2); // proves the drain loop ran and exited on null
  });
});
