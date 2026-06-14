/**
 * WakeSleepCycle (autonomy v1) — goal dispatch, hook emission, error
 * containment, concurrency cap, and sleep scheduling. Uses a real
 * GoalEngineV2 on a tmpdir database and a real HookManager; ticks are driven
 * manually (large interval) so dispatch counts are deterministic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeSleepCycle } from '../../src/core/autonomy/wake-sleep-cycle.js';
import { GoalEngineV2, type GoalV2 } from '../../src/core/autonomy/goal-engine-v2.js';
import { HookManager } from '../../src/core/hooks/index.js';

const dirs: string[] = [];
const engines: GoalEngineV2[] = [];
const cycles: WakeSleepCycle[] = [];

function makeEngine(): GoalEngineV2 {
  const dir = mkdtempSync(join(tmpdir(), 'wake-sleep-'));
  dirs.push(dir);
  const engine = new GoalEngineV2(join(dir, 'goals.db'));
  engines.push(engine);
  return engine;
}

function track(cycle: WakeSleepCycle): WakeSleepCycle {
  cycles.push(cycle);
  return cycle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  for (const cycle of cycles.splice(0)) cycle.stop();
  for (const engine of engines.splice(0)) engine.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WakeSleepCycle', () => {
  it('validates constructor arguments', () => {
    const engine = makeEngine();
    expect(() => new WakeSleepCycle({} as GoalEngineV2, null, async () => {})).toThrow(TypeError);
    expect(() => new WakeSleepCycle(engine, null, 'nope' as never)).toThrow(TypeError);
  });

  it('dispatches a ready goal and emits goal:completed when the handler completes it', async () => {
    const engine = makeEngine();
    const hooks = new HookManager();
    const completedEvents: unknown[] = [];
    hooks.register('goal:completed', async (ctx) => { completedEvents.push(ctx.meta); });

    const worked: string[] = [];
    const cycle = track(new WakeSleepCycle(engine, hooks, async (goal: GoalV2) => {
      worked.push(goal.id);
      engine.completeGoal(goal.id);
    }, { tickIntervalMs: 60_000 }));

    const goal = engine.setGoal({ title: 'write the report', description: 'weekly summary' });
    cycle.start();
    await sleep(50); // immediate tick from start()

    expect(worked).toEqual([goal.id]);
    expect(engine.getGoal(goal.id)?.status).toBe('completed');
    expect(completedEvents).toHaveLength(1);
  });

  it('does not emit goal:completed for partial progress', async () => {
    const engine = makeEngine();
    const hooks = new HookManager();
    const completedEvents: unknown[] = [];
    hooks.register('goal:completed', async (ctx) => { completedEvents.push(ctx.meta); });

    const cycle = track(new WakeSleepCycle(engine, hooks, async (goal: GoalV2) => {
      // Partial turn: re-sleep instead of completing (the cli.ts wiring pattern).
      engine.scheduleWake(goal.id, new Date(Date.now() + 3_600_000).toISOString());
    }, { tickIntervalMs: 60_000 }));

    engine.setGoal({ title: 'long-running goal' });
    cycle.start();
    await sleep(50);

    expect(completedEvents).toHaveLength(0);
    expect(engine.getGoalsReadyToWork()).toHaveLength(0); // asleep until the wake time
  });

  it('contains work handler errors and keeps ticking', async () => {
    const engine = makeEngine();
    let calls = 0;
    const cycle = track(new WakeSleepCycle(engine, null, async () => {
      calls++;
      throw new Error('turn exploded');
    }, { tickIntervalMs: 60_000 }));

    engine.setGoal({ title: 'doomed goal' });
    cycle.start();
    await sleep(50);
    expect(calls).toBe(1);

    await expect(cycle.tick()).resolves.toBeUndefined(); // still operational
    expect(calls).toBe(2);
  });

  it('caps dispatch at maxConcurrentGoals per tick', async () => {
    const engine = makeEngine();
    const worked: string[] = [];
    const cycle = track(new WakeSleepCycle(engine, null, async (goal: GoalV2) => {
      worked.push(goal.id);
      engine.completeGoal(goal.id);
    }, { tickIntervalMs: 60_000, maxConcurrentGoals: 1 }));

    engine.setGoal({ title: 'goal one' });
    engine.setGoal({ title: 'goal two' });

    cycle.start();
    await sleep(50);
    expect(worked).toHaveLength(1);

    await cycle.tick();
    expect(worked).toHaveLength(2);
  });

  it('sleep() delegates to the engine and validates arguments', () => {
    const engine = makeEngine();
    const cycle = track(new WakeSleepCycle(engine, null, async () => {}, { tickIntervalMs: 60_000 }));
    const goal = engine.setGoal({ title: 'nap time' });

    cycle.sleep(goal.id, new Date(Date.now() + 3_600_000).toISOString());
    expect(engine.getGoal(goal.id)?.status).toBe('sleeping');
    expect(engine.getGoalsReadyToWork()).toHaveLength(0);

    expect(() => cycle.sleep('', 'soon')).toThrow(TypeError);
    expect(() => cycle.sleep(goal.id, '')).toThrow(TypeError);
  });

  it('createGoal emits goal:created', async () => {
    const engine = makeEngine();
    const hooks = new HookManager();
    const created: unknown[] = [];
    hooks.register('goal:created', async (ctx) => { created.push(ctx.meta); });

    const cycle = track(new WakeSleepCycle(engine, hooks, async () => {}, { tickIntervalMs: 60_000 }));
    const goal = await cycle.createGoal({ title: 'hooked goal' });

    expect(goal.id).toBeTruthy();
    expect(created).toHaveLength(1);
  });

  it('start() is idempotent and stop() returns the cycle to idle', async () => {
    const engine = makeEngine();
    const cycle = track(new WakeSleepCycle(engine, null, async () => {}, { tickIntervalMs: 60_000 }));

    cycle.start();
    cycle.start(); // no-op
    await sleep(20);
    expect(['awake', 'sleeping', 'working']).toContain(cycle.getStatus());

    cycle.stop();
    expect(cycle.getStatus()).toBe('idle');
    await expect(cycle.tick()).resolves.toBeUndefined(); // idle tick is a no-op
  });

  // --- Gap #28d slice 1 ----------------------------------------------------

  it('pause() short-circuits tick() without dispatching ready goals', async () => {
    const engine = makeEngine();
    const worked: string[] = [];
    const cycle = track(new WakeSleepCycle(engine, null, async (goal: GoalV2) => {
      worked.push(goal.id);
      engine.completeGoal(goal.id);
    }, { tickIntervalMs: 60_000 }));

    engine.setGoal({ title: 'do work' });
    cycle.start();
    await sleep(50); // immediate tick from start() runs first
    expect(worked).toHaveLength(1);

    // Pause then drop in a new goal — manual tick must NOT dispatch.
    const snap = cycle.pause();
    expect(snap.paused).toBe(true);
    expect(cycle.isPaused()).toBe(true);
    engine.setGoal({ title: 'second goal — should be skipped while paused' });
    await cycle.tick();
    expect(worked).toHaveLength(1); // still one
    expect(cycle.getStatus()).toBe('paused');
  });

  it('resume() lets the next tick dispatch the previously-skipped goal', async () => {
    const engine = makeEngine();
    const worked: string[] = [];
    const cycle = track(new WakeSleepCycle(engine, null, async (goal: GoalV2) => {
      worked.push(goal.id);
      engine.completeGoal(goal.id);
    }, { tickIntervalMs: 60_000 }));

    cycle.start();
    cycle.pause();
    const skipped = engine.setGoal({ title: 'queued during pause' });
    await cycle.tick();
    expect(worked).toHaveLength(0);

    const snap = cycle.resume();
    expect(snap.paused).toBe(false);
    expect(cycle.isPaused()).toBe(false);
    await cycle.tick();
    expect(worked).toEqual([skipped.id]);
  });

  it('pause()/resume() are idempotent and stable across repeated calls', () => {
    const engine = makeEngine();
    const cycle = track(new WakeSleepCycle(engine, null, async () => {}, { tickIntervalMs: 60_000 }));
    cycle.start();
    cycle.pause();
    cycle.pause(); // no state thrash
    expect(cycle.isPaused()).toBe(true);
    cycle.resume();
    cycle.resume();
    expect(cycle.isPaused()).toBe(false);
  });

  it('resume() on a stopped cycle does not re-arm — start() is the only way back', () => {
    const engine = makeEngine();
    const cycle = track(new WakeSleepCycle(engine, null, async () => {}, { tickIntervalMs: 60_000 }));
    cycle.start();
    cycle.pause();
    cycle.stop();
    expect(cycle.getStatus()).toBe('idle');
    cycle.resume();
    // resume() flipped paused=false but the interval is gone, so state stays 'idle'.
    expect(cycle.getStatus()).toBe('idle');
    expect(cycle.isPaused()).toBe(false);
  });
});
