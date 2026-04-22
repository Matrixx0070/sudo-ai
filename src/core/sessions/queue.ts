/**
 * @file queue.ts
 * @description KeyedAsyncQueue — per-key serialized task execution.
 *
 * Prevents race conditions when multiple messages arrive from the same peer
 * concurrently. Tasks for the same key are chained so they never overlap;
 * tasks for different keys run in parallel.
 *
 * Adapted from the OpenClaw pattern, production-hardened for SUDO-AI v3.
 */

import { createLogger } from '../shared/index.js';

const log = createLogger('sessions:queue');

/**
 * A lightweight in-process queue that serializes async tasks per key.
 *
 * @example
 * ```ts
 * const q = new KeyedAsyncQueue();
 * await q.enqueue('user-123', () => handleMessage(msg));
 * ```
 */
export class KeyedAsyncQueue {
  /** Map of key -> tail promise of the current task chain for that key. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Enqueue a task under a key.
   * The task will not start until the previous task for the same key resolves
   * or rejects. Tasks for different keys execute in parallel.
   *
   * @param key  - Serialization key (e.g. "telegram:user-123").
   * @param task - Async factory to execute. Must not throw synchronously;
   *               returned promise rejection is forwarded to the caller.
   * @returns A promise that resolves (or rejects) with the task's result.
   */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (!key || typeof key !== 'string') {
      throw new TypeError('KeyedAsyncQueue.enqueue: key must be a non-empty string');
    }
    if (typeof task !== 'function') {
      throw new TypeError('KeyedAsyncQueue.enqueue: task must be a function');
    }

    const prev = this.tails.get(key) ?? Promise.resolve();

    const result = new Promise<T>((resolve, reject) => {
      // Chain onto the previous tail. We swallow errors from prev to avoid
      // unhandled-rejection noise — the error was already surfaced to whoever
      // enqueued that prior task.
      const next = prev
        .catch(() => {
          // Previous task failed — still run ours (independent error domains).
        })
        .then(() => task().then(resolve, reject));

      // Register this chain link as the new tail.
      this.tails.set(key, next as Promise<void>);

      // Prune the map once this task's chain link settles, but only if we are
      // still the tail (a later enqueue may have replaced us).
      (next as Promise<void>).finally(() => {
        if (this.tails.get(key) === next) {
          this.tails.delete(key);
          log.trace({ key }, 'queue key drained');
        }
      });
    });

    return result;
  }

  /**
   * Keys with at least one pending or running task.
   */
  get pendingKeys(): string[] {
    return [...this.tails.keys()];
  }

  /**
   * Number of keys currently holding a live task chain.
   */
  get size(): number {
    return this.tails.size;
  }

  /**
   * Returns true if there are no active task chains.
   */
  get isEmpty(): boolean {
    return this.tails.size === 0;
  }
}
