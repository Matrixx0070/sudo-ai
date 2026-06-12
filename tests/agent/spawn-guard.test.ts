/**
 * @file tests/agent/spawn-guard.test.ts
 * @description SpawnSlotGuard (gap #10) — two-phase RAII commit guard.
 * Reserve resources via defer(), commit() once the outcome is reported,
 * release() from finally rolls back abandoned spawns and always runs
 * cleanups LIFO without throwing.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpawnSlotGuard } from '../../src/core/agent/spawn-guard.js';

describe('SpawnSlotGuard', () => {
  it('runs deferred cleanups on release in LIFO order, even when committed', async () => {
    const order: string[] = [];
    const guard = new SpawnSlotGuard();
    guard.defer(() => { order.push('first'); });
    guard.defer(() => { order.push('second'); });
    guard.commit();
    await guard.release();
    expect(order).toEqual(['second', 'first']);
  });

  it('fires the abandoned handler only when never committed', async () => {
    const abandoned = vi.fn();
    const guard = new SpawnSlotGuard(abandoned);
    await guard.release();
    expect(abandoned).toHaveBeenCalledTimes(1);

    const abandoned2 = vi.fn();
    const guard2 = new SpawnSlotGuard(abandoned2);
    guard2.commit();
    await guard2.release();
    expect(abandoned2).not.toHaveBeenCalled();
  });

  it('release is idempotent', async () => {
    const cleanup = vi.fn();
    const abandoned = vi.fn();
    const guard = new SpawnSlotGuard(abandoned);
    guard.defer(cleanup);
    await guard.release();
    await guard.release();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(abandoned).toHaveBeenCalledTimes(1);
  });

  it('contains throwing cleanups and abandoned handlers — remaining cleanups still run', async () => {
    const ran: string[] = [];
    const guard = new SpawnSlotGuard(() => { throw new Error('abandoned handler bug'); });
    guard.defer(() => { ran.push('a'); });
    guard.defer(() => { throw new Error('cleanup bug'); });
    guard.defer(() => { ran.push('c'); });
    await expect(guard.release()).resolves.toBeUndefined();
    expect(ran).toEqual(['c', 'a']);
  });

  it('awaits async cleanups', async () => {
    let done = false;
    const guard = new SpawnSlotGuard();
    guard.defer(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    guard.commit();
    await guard.release();
    expect(done).toBe(true);
  });

  it('exposes commit state via isCommitted', () => {
    const guard = new SpawnSlotGuard();
    expect(guard.isCommitted).toBe(false);
    guard.commit();
    expect(guard.isCommitted).toBe(true);
  });
});
