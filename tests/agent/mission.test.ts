/**
 * @file tests/agent/mission.test.ts
 * @description The mission spine: durable multi-day goals that survive session
 * boundaries. Covers the store's durability, the planner's refusal to emit
 * uncheckable steps, and the runner's central promise — the cursor advances
 * ONLY on verified completion, and owner-gated work parks instead of looping.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'mission-'));
  process.env['DATA_DIR'] = tmp;
  vi.resetModules(); // paths.ts captures DATA_DIR at import time
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env['DATA_DIR'];
});

const store = () => import('../../src/core/agent/mission/store.js');
const planner = () => import('../../src/core/agent/mission/planner.js');
const runner = () => import('../../src/core/agent/mission/runner.js');
const types = () => import('../../src/core/agent/mission/types.js');

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('mission store — durable and cross-session', () => {
  it('creates, persists and reloads a mission by id', async () => {
    const s = await store();
    const m = s.createMission({ goal: 'ship the thing', maxSpendUsd: 50 });
    expect(m.status).toBe('planning');
    const again = s.loadMission(m.id);
    expect(again?.goal).toBe('ship the thing');
    expect(again?.maxSpendUsd).toBe(50);
  });

  it('returns null for an unknown id instead of throwing', async () => {
    const s = await store();
    expect(s.loadMission('mission-nope')).toBeNull();
  });

  it('lists missions newest-first and serves the OLDEST advanceable one', async () => {
    const s = await store();
    const first = s.createMission({ goal: 'older' });
    first.createdAt = '2026-08-01T00:00:00.000Z'; // distinct ages, not same-ms luck
    s.saveMission(first);
    const second = s.createMission({ goal: 'newer' });
    second.createdAt = '2026-08-02T00:00:00.000Z';
    s.saveMission(second);
    // Both are advanceable; the longest-waiting must be served to avoid starvation.
    expect(s.listMissions()[0]!.id).toBe(second.id);
    expect(s.nextAdvanceableMission()?.id).toBe(first.id);
  });

  it('skips blocked / over-budget / expired missions when picking work', async () => {
    const s = await store();
    const t = await types();

    const blocked = s.createMission({ goal: 'blocked' });
    s.addBlocker(blocked, { kind: 'credential', detail: 'need an API key' });
    s.saveMission(blocked);

    const broke = s.createMission({ goal: 'broke', maxSpendUsd: 5 });
    broke.spendUsd = 5.01;
    s.saveMission(broke);

    const late = s.createMission({ goal: 'late', deadline: '2020-01-01T00:00:00Z' });
    s.saveMission(late);

    expect(s.nextAdvanceableMission()).toBeNull();
    expect(t.isAdvanceable(blocked)).toBe(false);
    expect(t.stallReason(broke)).toContain('mission budget reached');
    expect(t.stallReason(late)).toContain('deadline passed');
  });

  it('clearing blockers resumes the mission', async () => {
    const s = await store();
    const m = s.createMission({ goal: 'g' });
    s.addBlocker(m, { kind: 'money', detail: 'needs $20 of credits' });
    expect(m.status).toBe('blocked');
    expect(s.clearBlockers(m, 'topped up')).toBe(1);
    expect(m.status).toBe('active');
    s.saveMission(m);
    expect(s.nextAdvanceableMission()?.id).toBe(m.id);
  });

  it('does not duplicate an identical open blocker', async () => {
    const s = await store();
    const m = s.createMission({ goal: 'g' });
    s.addBlocker(m, { kind: 'credential', detail: 'same' });
    s.addBlocker(m, { kind: 'credential', detail: 'same' });
    expect(m.blockers).toHaveLength(1);
  });

  it('deleteMission removes the record', async () => {
    const s = await store();
    const m = s.createMission({ goal: 'g' });
    expect(s.deleteMission(m.id)).toBe(true);
    expect(s.loadMission(m.id)).toBeNull();
    expect(s.deleteMission(m.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

describe('mission planner — every step must be checkable', () => {
  it('parses a clean plan', async () => {
    const p = await planner();
    const steps = p.parsePlan('[{"description":"write the module","doneWhen":"src/x.ts exists and tsc passes"}]');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.doneWhen).toContain('tsc passes');
    expect(steps[0]!.status).toBe('pending');
  });

  it('tolerates a fenced block and surrounding prose', async () => {
    const p = await planner();
    const steps = p.parsePlan('Sure!\n```json\n[{"description":"a","doneWhen":"b"}]\n```\nHope that helps.');
    expect(steps).toHaveLength(1);
  });

  it('DROPS steps with no completion criterion (no fake progress)', async () => {
    const p = await planner();
    const steps = p.parsePlan('[{"description":"improve things"},{"description":"a","doneWhen":"b"},{"doneWhen":"orphan"}]');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.description).toBe('a');
  });

  it('returns [] for junk rather than throwing', async () => {
    const p = await planner();
    expect(p.parsePlan('not json at all')).toEqual([]);
    expect(p.parsePlan('')).toEqual([]);
    expect(p.parsePlan('{"not":"an array"}')).toEqual([]);
  });

  it('falls back to a single actionable step when the model fails', async () => {
    const p = await planner();
    const brain = { call: vi.fn().mockRejectedValue(new Error('brain down')) };
    const steps = await p.planMission(brain, 'do the big thing');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.description).toContain('do the big thing');
    expect(steps[0]!.doneWhen).toBeTruthy();
  });

  it('uses the model plan when it is usable', async () => {
    const p = await planner();
    const brain = { call: vi.fn().mockResolvedValue({ content: '[{"description":"s1","doneWhen":"c1"},{"description":"s2","doneWhen":"c2"}]' }) };
    expect(await p.planMission(brain, 'goal')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('verdict parsing', () => {
  it('reads DONE / NOT_DONE / BLOCKED', async () => {
    const r = await runner();
    expect(r.parseVerdict('DONE: file exists at src/x.ts')).toEqual({ kind: 'done', evidence: 'file exists at src/x.ts' });
    expect(r.parseVerdict('NOT_DONE: no tests were added')).toEqual({ kind: 'not_done', missing: 'no tests were added' });
    expect(r.parseVerdict('BLOCKED|credential: need a Stripe key')).toEqual({
      kind: 'blocked', blockerKind: 'credential', detail: 'need a Stripe key',
    });
  });

  it('treats an unparseable verdict as NOT_DONE (never advances on ambiguity)', async () => {
    const r = await runner();
    expect(r.parseVerdict('looks good to me!').kind).toBe('not_done');
    expect(r.parseVerdict('').kind).toBe('not_done');
  });
});

describe('mission runner — the cursor moves only on verified completion', () => {
  /** Executor whose 2nd call (the verifier) returns a scripted verdict. */
  function executor(verdicts: string[], report = 'did the work') {
    let n = 0;
    return {
      run: vi.fn(async (prompt: string) => {
        // Verification prompts carry the criterion header.
        if (prompt.includes('You are verifying whether')) return verdicts[n++] ?? 'NOT_DONE: no verdict';
        return report;
      }),
      lastRunCostUsd: () => 0.25,
    };
  }
  const planBrain = (json: string) => ({ call: vi.fn().mockResolvedValue({ content: json }) });

  it('plans first, then advances one verified step per call', async () => {
    const s = await store();
    const r = await runner();
    const m = s.createMission({ goal: 'g' });
    const deps = {
      executor: executor(['DONE: artifact present']),
      brain: planBrain('[{"description":"s1","doneWhen":"c1"},{"description":"s2","doneWhen":"c2"}]'),
    };

    expect(await r.advanceMission(m, deps)).toEqual({ kind: 'planned', steps: 2 });
    expect(m.status).toBe('active');
    expect(m.cursor).toBe(0);

    const out = await r.advanceMission(m, deps);
    expect(out.kind).toBe('advanced');
    expect(m.cursor).toBe(1);
    expect(m.steps[0]!.status).toBe('done');
    expect(m.steps[0]!.note).toBe('artifact present');
    expect(m.spendUsd).toBeGreaterThan(0); // execution + verification both counted
  });

  it('does NOT advance on NOT_DONE — it retries the same step', async () => {
    const s = await store();
    const r = await runner();
    const m = s.createMission({ goal: 'g' });
    const deps = {
      executor: executor(['NOT_DONE: nothing on disk']),
      brain: planBrain('[{"description":"s1","doneWhen":"c1"}]'),
    };
    await r.advanceMission(m, deps); // plan
    const out = await r.advanceMission(m, deps);
    expect(out.kind).toBe('retry');
    expect(m.cursor).toBe(0);
    expect(m.steps[0]!.status).toBe('pending');
    expect(m.steps[0]!.attempts).toBe(1);
  });

  it('parks the mission with a typed blocker when the owner is needed', async () => {
    const s = await store();
    const r = await runner();
    const notify = vi.fn();
    const m = s.createMission({ goal: 'g' });
    const deps = {
      executor: executor(['BLOCKED|money: needs $50 of API credit']),
      brain: planBrain('[{"description":"s1","doneWhen":"c1"}]'),
      notify,
    };
    await r.advanceMission(m, deps);
    const out = await r.advanceMission(m, deps);
    expect(out.kind).toBe('blocked');
    expect(m.status).toBe('blocked');
    expect(m.blockers[0]!.kind).toBe('money');
    expect(m.cursor).toBe(0); // no silent progress
    expect(notify).toHaveBeenCalled();
    const t = await types();
    expect(t.isAdvanceable(m)).toBe(false); // scheduler will skip it
  });

  it('escalates to a blocker after repeated failures instead of grinding forever', async () => {
    const s = await store();
    const r = await runner();
    const m = s.createMission({ goal: 'g' });
    const deps = {
      executor: executor(['NOT_DONE: a', 'NOT_DONE: b', 'NOT_DONE: c']),
      brain: planBrain('[{"description":"s1","doneWhen":"c1"}]'),
    };
    await r.advanceMission(m, deps); // plan
    expect((await r.advanceMission(m, deps)).kind).toBe('retry');
    expect((await r.advanceMission(m, deps)).kind).toBe('retry');
    expect((await r.advanceMission(m, deps)).kind).toBe('blocked'); // 3rd attempt escalates
    expect(m.status).toBe('blocked');
    expect(m.blockers[0]!.kind).toBe('error');
  });

  it('completes the mission when the plan is exhausted', async () => {
    const s = await store();
    const r = await runner();
    const notify = vi.fn();
    const m = s.createMission({ goal: 'g' });
    const deps = {
      executor: executor(['DONE: ok']),
      brain: planBrain('[{"description":"s1","doneWhen":"c1"}]'),
      notify,
    };
    await r.advanceMission(m, deps);
    await r.advanceMission(m, deps);
    const out = await r.advanceMission(m, deps);
    expect(out).toEqual({ kind: 'completed' });
    expect(m.status).toBe('completed');
    expect(notify).toHaveBeenCalledWith(m, expect.stringContaining('COMPLETE'));
  });

  it('survives a throwing executor without losing the mission', async () => {
    const s = await store();
    const r = await runner();
    const m = s.createMission({ goal: 'g' });
    const deps = {
      executor: { run: vi.fn().mockRejectedValue(new Error('boom')), lastRunCostUsd: () => 0 },
      brain: planBrain('[{"description":"s1","doneWhen":"c1"}]'),
    };
    await r.advanceMission(m, deps);
    const out = await r.advanceMission(m, deps);
    expect(out.kind).toBe('idle');
    expect(s.loadMission(m.id)).not.toBeNull(); // persisted, not lost
    expect(m.consecutiveFailures).toBe(1);
  });
});

describe('step prompt carries the mission across the session boundary', () => {
  it('includes goal, completed work, artifacts and the criterion', async () => {
    const s = await store();
    const r = await runner();
    const m = s.createMission({ goal: 'build the launcher' });
    m.steps = [
      { id: 's1', description: 'scaffold', doneWhen: 'dir exists', status: 'done', attempts: 1, artifacts: [], note: 'created src/launcher' },
      { id: 's2', description: 'write the entrypoint', doneWhen: 'src/launcher/main.ts exists', status: 'pending', attempts: 0, artifacts: [] },
    ];
    m.cursor = 1;
    m.artifacts = ['src/launcher/'];
    const prompt = r.buildStepPrompt(m, m.steps[1]!);
    expect(prompt).toContain('build the launcher');       // goal survives
    expect(prompt).toContain('created src/launcher');      // prior work survives
    expect(prompt).toContain('src/launcher/');             // artifacts survive
    expect(prompt).toContain('THIS STEP IS DONE WHEN: src/launcher/main.ts exists');
    expect(prompt).toContain('Do this step only');
  });

  it('tells a retry that the previous attempt failed', async () => {
    const s = await store();
    const r = await runner();
    const m = s.createMission({ goal: 'g' });
    const step = { id: 's1', description: 'd', doneWhen: 'c', status: 'pending' as const, attempts: 2, artifacts: [] };
    expect(r.buildStepPrompt(m, step)).toContain('attempt 3');
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const scheduler = () => import('../../src/core/agent/mission/scheduler.js');

describe('mission scheduler — armed explicitly, serial, crash-proof', () => {
  afterEach(() => { delete process.env['SUDO_MISSIONS']; delete process.env['SUDO_MISSION_TICK_MIN']; });

  it('is OFF by default and arms only on SUDO_MISSIONS=1', async () => {
    const sc = await scheduler();
    expect(sc.missionsEnabled({})).toBe(false);
    expect(sc.missionsEnabled({ SUDO_MISSIONS: '0' })).toBe(false);
    expect(sc.missionsEnabled({ SUDO_MISSIONS: '1' })).toBe(true);
  });

  it('clamps the tick interval and defaults to 30 min', async () => {
    const sc = await scheduler();
    expect(sc.tickIntervalMs({})).toBe(30 * 60_000);
    expect(sc.tickIntervalMs({ SUDO_MISSION_TICK_MIN: '5' })).toBe(5 * 60_000);
    expect(sc.tickIntervalMs({ SUDO_MISSION_TICK_MIN: '1' })).toBe(30 * 60_000);    // below floor
    expect(sc.tickIntervalMs({ SUDO_MISSION_TICK_MIN: '9999' })).toBe(30 * 60_000); // above ceiling
    expect(sc.tickIntervalMs({ SUDO_MISSION_TICK_MIN: 'abc' })).toBe(30 * 60_000);
  });

  it('startMissionScheduler is a no-op when disarmed', async () => {
    const sc = await scheduler();
    const deps = { executor: { run: vi.fn(), lastRunCostUsd: () => 0 }, brain: { call: vi.fn() } };
    const stop = sc.startMissionScheduler(deps, {});
    expect(typeof stop).toBe('function');
    stop();
    expect(deps.executor.run).not.toHaveBeenCalled();
  });

  it('a tick with no missions is idle, not an error', async () => {
    const sc = await scheduler();
    const out = await sc.missionTick({ executor: { run: vi.fn(), lastRunCostUsd: () => 0 }, brain: { call: vi.fn() } });
    expect(out).toEqual({ kind: 'idle', reason: 'no advanceable mission' });
  });

  it('a tick advances the longest-waiting mission', async () => {
    const s = await store();
    const sc = await scheduler();
    const older = s.createMission({ goal: 'older goal' });
    older.createdAt = '2026-08-01T00:00:00.000Z';
    s.saveMission(older);
    s.createMission({ goal: 'newer goal' });

    const brain = { call: vi.fn().mockResolvedValue({ content: '[{"description":"s1","doneWhen":"c1"}]' }) };
    const out = await sc.missionTick({ executor: { run: vi.fn(), lastRunCostUsd: () => 0 }, brain });
    expect(out).toEqual({ kind: 'planned', steps: 1 });
    expect(s.loadMission(older.id)!.status).toBe('active'); // the OLDER one was served
  });
});

describe('mission budget meter is truthful (gateway cost_usd is NULL on OAuth lanes)', () => {
  it('accumulates the executor-reported spend across execute AND verify calls', async () => {
    const s = await store();
    const r = await runner();
    const m = s.createMission({ goal: 'g', maxSpendUsd: 10 });
    let n = 0;
    const deps = {
      executor: {
        run: vi.fn(async (p: string) => (p.includes('You are verifying whether') ? 'DONE: ok' : 'worked')),
        lastRunCostUsd: () => { n += 1; return 0.5; }, // charged once per call
      },
      brain: { call: vi.fn().mockResolvedValue({ content: '[{"description":"s1","doneWhen":"c1"}]' }) },
    };
    await r.advanceMission(m, deps); // plan
    await r.advanceMission(m, deps); // execute + verify
    expect(n).toBe(2);               // both calls metered
    expect(m.spendUsd).toBeCloseTo(1.0);
  });

  it('a mission that reaches its ceiling stops being scheduled', async () => {
    const s = await store();
    const t = await types();
    const m = s.createMission({ goal: 'g', maxSpendUsd: 1 });
    m.status = 'active';
    m.spendUsd = 1.0;
    s.saveMission(m);
    expect(t.isAdvanceable(m)).toBe(false);
    expect(s.nextAdvanceableMission()).toBeNull();
    expect(t.stallReason(m)).toContain('mission budget reached');
  });
});

// ---------------------------------------------------------------------------
// Wake wiring (OpenClaw heartbeat semantics: event-driven + busy-gated)
// ---------------------------------------------------------------------------

const wake = () => import('../../src/core/agent/mission/wake.js');
const activity = () => import('../../src/core/agent/activity.js');
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('mission wake — event-driven, not a blind interval', () => {
  it('a wake request runs a tick promptly instead of waiting out an interval', async () => {
    const w = await wake();
    const tick = vi.fn().mockResolvedValue({ kind: 'idle' });
    w.setWakeDeps({ tick, isBusy: () => false, hasWork: () => true });
    w.requestMissionWake('mission-created', 1);
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);
    w.__resetWakeForTests();
  });

  it('coalesces a burst of requests into ONE tick', async () => {
    const w = await wake();
    const tick = vi.fn().mockResolvedValue({ kind: 'idle' });
    w.setWakeDeps({ tick, isBusy: () => false, hasWork: () => true });
    for (let i = 0; i < 10; i++) w.requestMissionWake('mission-created', 1);
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);
    w.__resetWakeForTests();
  });

  it('DEFERS (does not drop) a wake while the owner is being served', async () => {
    const w = await wake();
    const tick = vi.fn().mockResolvedValue({ kind: 'idle' });
    let busy = true;
    w.setWakeDeps({ tick, isBusy: () => busy, hasWork: () => true });
    w.requestMissionWake('mission-created', 1);
    await settle();
    expect(tick).not.toHaveBeenCalled();   // never interrupts the conversation
    expect(w.hasPendingWake()).toBe(true); // but the wake survives
    busy = false;
    w.__resetWakeForTests();
  });

  it('does nothing when there is no advanceable mission', async () => {
    const w = await wake();
    const tick = vi.fn().mockResolvedValue({ kind: 'idle' });
    w.setWakeDeps({ tick, isBusy: () => false, hasWork: () => false });
    w.requestMissionWake('interval', 1);
    await settle();
    expect(tick).not.toHaveBeenCalled();
    w.__resetWakeForTests();
  });

  it('CHAINS: a productive tick immediately requests the next one', async () => {
    const w = await wake();
    let calls = 0;
    const tick = vi.fn(async () => ({ kind: calls++ < 2 ? 'advanced' : 'completed' }));
    w.setWakeDeps({ tick, isBusy: () => false, hasWork: () => true });
    w.requestMissionWake('mission-created', 1);
    await settle(1200);
    // advanced -> advanced -> completed: it kept going while idle rather than
    // sleeping a full interval between steps.
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);
    w.__resetWakeForTests();
  });

  it('is inert before deps are installed (flag off / not wired)', async () => {
    const w = await wake();
    w.__resetWakeForTests();
    w.requestMissionWake('mission-created', 1);
    expect(w.hasPendingWake()).toBe(false);
  });

  it('a throwing tick does not wedge the wake loop', async () => {
    const w = await wake();
    const tick = vi.fn().mockRejectedValue(new Error('boom'));
    w.setWakeDeps({ tick, isBusy: () => false, hasWork: () => true });
    w.requestMissionWake('mission-created', 1);
    await settle();
    expect(tick).toHaveBeenCalled();
    w.requestMissionWake('interval', 1); // still accepts work afterwards
    await settle();
    expect(tick).toHaveBeenCalledTimes(2);
    w.__resetWakeForTests();
  });
});

describe('user-turn activity signal', () => {
  it('counts overlapping turns and clears only when all finish', async () => {
    const a = await activity();
    a.__resetActivityForTests();
    expect(a.isServingUser()).toBe(false);
    const end1 = a.beginUserTurn();
    const end2 = a.beginUserTurn();
    expect(a.activeUserTurnCount()).toBe(2);
    end1();
    expect(a.isServingUser()).toBe(true);  // still one in flight
    end2();
    expect(a.isServingUser()).toBe(false);
  });

  it('end is idempotent (a double-call cannot drive the count negative)', async () => {
    const a = await activity();
    a.__resetActivityForTests();
    const end = a.beginUserTurn();
    end(); end(); end();
    expect(a.activeUserTurnCount()).toBe(0);
  });
});
