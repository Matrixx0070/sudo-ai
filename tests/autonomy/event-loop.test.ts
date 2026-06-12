/**
 * AutonomousEventLoop (autonomy v1) — plan persistence, self-initiated
 * actions, and lifecycle. Uses a real better-sqlite3 database in a tmpdir;
 * real timers (the immediate think cycle fires via setImmediate).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomousEventLoop } from '../../src/core/autonomy/event-loop.js';

const dirs: string[] = [];
const loops: AutonomousEventLoop[] = [];

function makeLoop(): AutonomousEventLoop {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-v1-'));
  dirs.push(dir);
  const loop = new AutonomousEventLoop(join(dir, 'mind.db'));
  loops.push(loop);
  return loop;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  for (const loop of loops.splice(0)) {
    if (loop.getState().running) loop.stop();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AutonomousEventLoop', () => {
  it('rejects an invalid dbPath', () => {
    expect(() => new AutonomousEventLoop('')).toThrow(TypeError);
  });

  it('round-trips a plan through savePlan/loadPlan and upserts on conflict', () => {
    const loop = makeLoop();
    const plan = AutonomousEventLoop.createPlan('ship-feature', [
      { description: 'write code', status: 'pending' },
      { description: 'write tests', status: 'pending' },
    ]);

    loop.savePlan(plan);
    const loaded = loop.loadPlan();
    expect(loaded?.id).toBe(plan.id);
    expect(loaded?.steps).toHaveLength(2);
    expect(loaded?.status).toBe('active');

    loop.savePlan({ ...plan, currentStep: 1, name: 'ship-feature-renamed' });
    const reloaded = loop.loadPlan();
    expect(reloaded?.currentStep).toBe(1);
    expect(reloaded?.name).toBe('ship-feature-renamed');
  });

  it('validates plans in savePlan', () => {
    const loop = makeLoop();
    const plan = AutonomousEventLoop.createPlan('p', []);
    expect(() => loop.savePlan({ ...plan, id: ' ' })).toThrow(TypeError);
    expect(() => loop.savePlan({ ...plan, name: ' ' })).toThrow(TypeError);
    expect(() => loop.savePlan({ ...plan, steps: 'nope' as never })).toThrow(TypeError);
  });

  it('completePlan retires active plans so loadPlan returns null', () => {
    const loop = makeLoop();
    loop.savePlan(AutonomousEventLoop.createPlan('to-complete', []));
    expect(loop.loadPlan()).not.toBeNull();

    loop.completePlan();
    expect(loop.loadPlan()).toBeNull();
  });

  it('enqueueAction persists and validates', () => {
    const loop = makeLoop();
    const id = loop.enqueueAction('meta.self-test', 'because tests', 'low');
    expect(id).toBeGreaterThan(0);
    expect(() => loop.enqueueAction('', 'reason')).toThrow(TypeError);
    expect(() => loop.enqueueAction('action', ' ')).toThrow(TypeError);
  });

  it('createPlan assigns ids and defaults', () => {
    const plan = AutonomousEventLoop.createPlan('named', [{ description: 'step', status: 'pending' }]);
    expect(plan.id).toBeTruthy();
    expect(plan.steps[0]!.id).toBeTruthy();
    expect(plan.currentStep).toBe(0);
    expect(plan.status).toBe('active');
    expect(() => AutonomousEventLoop.createPlan('  ', [])).toThrow(TypeError);
  });

  it('start() enforces the minimum interval and runs an immediate think cycle', async () => {
    const loop = makeLoop();
    expect(() => loop.start(500)).toThrow(RangeError);

    loop.start(60_000);
    expect(loop.getState().running).toBe(true);
    await sleep(50); // the immediate cycle fires via setImmediate
    expect(loop.getState().cycleCount).toBeGreaterThanOrEqual(1);

    loop.start(60_000); // double start is a logged no-op
    loop.stop();
    expect(loop.getState().running).toBe(false);
    loop.stop(); // double stop is a logged no-op
  });
});
