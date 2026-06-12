/**
 * @file spawn-guard.ts
 * @description SpawnSlotGuard — two-phase RAII commit guard for sub-agent
 * spawn slots.
 *
 * Usage pattern (mirrors Rust's reserve-then-commit Drop guards):
 *   1. Reserve a slot, then create a guard and register rollback cleanups
 *      via defer() as resources are acquired (active record, isolation env).
 *   2. Once the spawn outcome has been *reported* (completion or failure
 *      pushed to subscribers), call commit().
 *   3. Always call release() from a finally block. It runs the abandoned
 *      handler when the guard was never committed (so subscribers are not
 *      left waiting forever), then runs every deferred cleanup in LIFO
 *      order regardless of commit state.
 *
 * release() is idempotent and never throws: cleanup failures are logged
 * and must not mask the original error propagating through the finally.
 */

import { createLogger } from '../shared/index.js';

const log = createLogger('agent:spawn-guard');

export class SpawnSlotGuard {
  private committed = false;
  private released = false;
  private readonly cleanups: Array<() => void | Promise<void>> = [];

  /**
   * @param onAbandoned - Invoked by release() when the guard was never
   *   committed — i.e. the spawn aborted before reporting an outcome.
   */
  constructor(private readonly onAbandoned?: () => void) {}

  /** Register a cleanup that always runs on release (LIFO order). */
  defer(fn: () => void | Promise<void>): void {
    this.cleanups.push(fn);
  }

  /** Mark the spawn outcome as reported. Disables the abandoned handler. */
  commit(): void {
    this.committed = true;
  }

  get isCommitted(): boolean {
    return this.committed;
  }

  /**
   * Run the abandoned handler (if uncommitted) and all deferred cleanups.
   * Idempotent; swallows and logs cleanup errors.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;

    if (!this.committed && this.onAbandoned) {
      try {
        this.onAbandoned();
      } catch (err) {
        log.warn({ err: String(err) }, 'SpawnSlotGuard: abandoned handler threw — continuing cleanup');
      }
    }

    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      try {
        await this.cleanups[i]!();
      } catch (err) {
        log.warn({ err: String(err) }, 'SpawnSlotGuard: deferred cleanup threw — continuing');
      }
    }
  }
}
