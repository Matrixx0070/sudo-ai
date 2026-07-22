/**
 * Auto-disable → probation re-enable on the CronScheduler.
 *
 * Before this change, MAX_CONSECUTIVE_ERRORS auto-disable was PERMANENT
 * (enabled:false persisted, human-only recovery) — one long provider outage
 * ("all model profiles in cooldown") could silently kill a job forever. The
 * scheduler now stamps autoDisabledAt and re-enables the job for probation
 * after a cool-off; manual disables (no stamp) are never touched.
 */

import { describe, it, expect, vi } from 'vitest';
import { CronScheduler } from '../../src/core/cron/scheduler.js';
import type { CronJob, CronRunRecord } from '../../src/core/cron/types.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Contract-faithful in-memory stand-in for the store surface the scheduler uses. */
function fakeStore(seed: CronJob[]) {
  const jobs = new Map(seed.map((j) => [j.id, { ...j }]));
  const runs: CronRunRecord[] = [];
  return {
    list: () => [...jobs.values()].map((j) => ({ ...j })),
    patch: (id: string, partial: Partial<CronJob>) => {
      const j = jobs.get(id);
      if (!j) return undefined;
      const next = { ...j, ...partial };
      jobs.set(id, next);
      return next;
    },
    appendRun: (r: CronRunRecord) => { runs.push(r); },
    upsert: (j: CronJob) => { jobs.set(j.id, { ...j }); return j; },
    remove: (id: string) => jobs.delete(id),
    get: (id: string) => jobs.get(id),
    runs,
  };
}

function job(overrides: Partial<CronJob>): CronJob {
  return {
    id: 'j1',
    name: 'test-job',
    schedule: { kind: 'every', ms: 1_000 },
    payload: { kind: 'agentMessage', message: 'x' } as CronJob['payload'],
    sessionTarget: 'isolated',
    enabled: true,
    consecutiveErrors: 0,
    ...overrides,
  };
}

async function tick(scheduler: CronScheduler): Promise<void> {
  await (scheduler as unknown as { _tick(): Promise<void> })._tick();
  // _fireJob is fired without awaiting inside _tick — let it settle.
  await new Promise((r) => setImmediate(r));
}

describe('CronScheduler auto-disable probation', () => {
  it('stamps autoDisabledAt when the error cap disables a job', async () => {
    const store = fakeStore([job({ consecutiveErrors: 9, lastRun: new Date(Date.now() - 600_000).toISOString() })]);
    const runner = vi.fn().mockRejectedValue(new Error('provider outage'));
    const scheduler = new CronScheduler(store as never, runner);
    await tick(scheduler);
    const j = store.get('j1')!;
    expect(runner).toHaveBeenCalledTimes(1);
    expect(j.enabled).toBe(false);
    expect(j.consecutiveErrors).toBe(10);
    expect(j.autoDisabledAt).toBeTruthy();
  });

  it('re-enables an auto-disabled job after the cool-off and lets it run', async () => {
    const past = new Date(Date.now() - SIX_HOURS - 60_000).toISOString();
    const store = fakeStore([job({ enabled: false, consecutiveErrors: 10, autoDisabledAt: past, lastRun: past })]);
    const runner = vi.fn().mockResolvedValue(undefined);
    const scheduler = new CronScheduler(store as never, runner);
    await tick(scheduler);
    const j = store.get('j1')!;
    expect(j.enabled).toBe(true);
    expect(j.autoDisabledAt).toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(1);      // probation run happened
    expect(j.consecutiveErrors).toBe(0);          // success resets the count
  });

  it('re-quarantines with a fresh stamp when the probation run fails', async () => {
    const past = new Date(Date.now() - SIX_HOURS - 60_000).toISOString();
    const store = fakeStore([job({ enabled: false, consecutiveErrors: 10, autoDisabledAt: past, lastRun: past })]);
    const runner = vi.fn().mockRejectedValue(new Error('still down'));
    const scheduler = new CronScheduler(store as never, runner);
    await tick(scheduler);
    const j = store.get('j1')!;
    expect(runner).toHaveBeenCalledTimes(1);
    expect(j.enabled).toBe(false);                // back in quarantine
    expect(j.consecutiveErrors).toBe(11);
    expect(new Date(j.autoDisabledAt!).getTime()).toBeGreaterThan(new Date(past).getTime());
  });

  it('never touches a manually disabled job (no autoDisabledAt)', async () => {
    const store = fakeStore([job({ enabled: false, lastRun: new Date(Date.now() - SIX_HOURS * 2).toISOString() })]);
    const runner = vi.fn();
    const scheduler = new CronScheduler(store as never, runner);
    await tick(scheduler);
    expect(store.get('j1')!.enabled).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not re-enable before the cool-off has passed', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const store = fakeStore([job({ enabled: false, consecutiveErrors: 10, autoDisabledAt: recent, lastRun: recent })]);
    const runner = vi.fn();
    const scheduler = new CronScheduler(store as never, runner);
    await tick(scheduler);
    expect(store.get('j1')!.enabled).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
