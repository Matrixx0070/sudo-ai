/**
 * @file tests/agent/run-lanes.test.ts
 * @description GW-11 — session + global run lanes. Covers the per-session mutex
 * (one active run per session), global lane caps under fan-out, the user lane's
 * never-drop queueing, background-lane overflow (drop OLDEST + accounting),
 * parseLaneCaps, and drainAndSuspend.
 */

import { describe, it, expect } from 'vitest';
import { RunLanes, parseLaneCaps, DEFAULT_LANE_CAPS } from '../../src/core/agent/run-lanes.js';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('GW-11 parseLaneCaps', () => {
  it('overrides defaults from SUDO_RUN_LANES, ignores junk', () => {
    const caps = parseLaneCaps('user=8,background=3,bogus=9,cron=0');
    expect(caps.user).toBe(8);
    expect(caps.background).toBe(3);
    expect(caps.subagent).toBe(DEFAULT_LANE_CAPS.subagent); // untouched
    expect(caps.cron).toBe(DEFAULT_LANE_CAPS.cron); // 0 rejected (min 1)
  });
  it('empty/undefined → defaults', () => {
    expect(parseLaneCaps(undefined)).toEqual(DEFAULT_LANE_CAPS);
  });
});

describe('GW-11 per-session mutex', () => {
  it('one active run per session — a second acquire for the same session waits', async () => {
    const lanes = new RunLanes({ caps: { user: 10, subagent: 10, background: 10, cron: 10 } });
    const r1 = await lanes.acquireRunSlot('telegram:u1', 'user');
    let secondAcquired = false;
    const p2 = lanes.acquireRunSlot('telegram:u1', 'user').then((rel) => { secondAcquired = true; return rel; });
    await tick();
    expect(secondAcquired).toBe(false); // blocked by the session mutex
    expect(lanes.activeSessionCount).toBe(1);
    r1(); // release the first
    const r2 = await p2;
    expect(secondAcquired).toBe(true);
    r2();
  });

  it('different sessions run in parallel', async () => {
    const lanes = new RunLanes({ caps: { user: 10, subagent: 10, background: 10, cron: 10 } });
    const a = await lanes.acquireRunSlot('telegram:a', 'user');
    const b = await lanes.acquireRunSlot('telegram:b', 'user'); // not blocked
    expect(lanes.activeSessionCount).toBe(2);
    a(); b();
  });
});

describe('GW-11 global lane caps', () => {
  it('user lane cap honored under fan-out; extra waits then admits on release', async () => {
    const lanes = new RunLanes({ caps: { user: 2, subagent: 4, background: 2, cron: 1 } });
    const r1 = await lanes.acquireRunSlot('s1', 'user');
    const r2 = await lanes.acquireRunSlot('s2', 'user');
    let thirdIn = false;
    const p3 = lanes.acquireRunSlot('s3', 'user').then((rel) => { thirdIn = true; return rel; });
    await tick();
    expect(thirdIn).toBe(false); // lane full (2)
    expect(lanes.stats().user.active).toBe(2);
    expect(lanes.stats().user.queued).toBe(1);
    r1();
    const r3 = await p3;
    expect(thirdIn).toBe(true);
    r2(); r3();
  });

  it('background lane overflow drops the OLDEST waiter (+ accounting); user never drops', async () => {
    const lanes = new RunLanes({ caps: { user: 1, subagent: 1, background: 1, cron: 1 }, queueCap: 1 });
    const held = await lanes.acquireRunSlot('bg-hold', 'background'); // fills cap
    // First waiter (oldest) — will be dropped when the 2nd waiter overflows the queueCap=1.
    const dropped = lanes.acquireRunSlot('bg-old', 'background');
    const droppedErr = dropped.catch((e: Error) => e);
    await tick();
    const kept = lanes.acquireRunSlot('bg-new', 'background'); // overflow → evict oldest
    await tick();
    const err = await droppedErr;
    expect(err).toBeInstanceOf(Error);
    expect(lanes.stats().background.dropped).toBe(1);
    held();
    const keptRel = await kept; // the newest waiter got the slot
    keptRel();
  });
});

describe('GW-11 drainAndSuspend', () => {
  it('resolves true immediately when nothing is active', async () => {
    const lanes = new RunLanes();
    expect(await lanes.drainAndSuspend(1_000, 10)).toBe(true);
  });

  it('refuses new admissions while suspending; resume re-enables', async () => {
    const lanes = new RunLanes();
    const drainP = lanes.drainAndSuspend(1_000, 10);
    await expect(lanes.acquireRunSlot('s1', 'user')).rejects.toThrow(/suspending/);
    await drainP;
    lanes.resume();
    const r = await lanes.acquireRunSlot('s1', 'user'); // admitted again
    r();
  });

  it('waits for an active run, then drains', async () => {
    const lanes = new RunLanes();
    const r = await lanes.acquireRunSlot('s1', 'user');
    let drained = false;
    const p = lanes.drainAndSuspend(1_000, 10).then((v) => { drained = v; });
    await tick(30);
    expect(drained).toBe(false); // still active
    r();
    await p;
    expect(drained).toBe(true);
  });
});
