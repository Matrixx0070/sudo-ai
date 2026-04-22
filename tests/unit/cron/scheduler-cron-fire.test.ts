/**
 * @file tests/unit/cron/scheduler-cron-fire.test.ts
 * @description Regression test for the cron-kind isDue logic.
 *
 * Bug: The original implementation used Math.abs(now - prev) < TICK_MS (1 second
 * window).  Under event-loop drift the tick could arrive 1.2 s after the cron
 * boundary, failing silently and causing the job to never fire until the next
 * boundary — where the same drift might recur.
 *
 * Fix: use croner._previous(now).getDate() > lastRun.  CronStore.upsert seeds
 * lastRun = registration time for brand-new jobs, so "no-lastRun" back-fire
 * is avoided without any scheduler-side special-casing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronScheduler } from '../../../src/core/cron/scheduler.js';
import { CronStore } from '../../../src/core/cron/store.js';
import type { CronJob, CronPayload } from '../../../src/core/cron/types.js';

// ---------------------------------------------------------------------------
// Logger mock — keep tests silent
// ---------------------------------------------------------------------------

vi.mock('../../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'test-job-1',
    name: 'test.job',
    schedule: { kind: 'cron', expr: '*/30 * * * *', tz: 'UTC' },
    payload: { kind: 'systemEvent', event: 'test' } as CronPayload,
    sessionTarget: 'isolated',
    enabled: true,
    consecutiveErrors: 0,
    ...overrides,
  };
}

function makeStore(job: CronJob): CronStore {
  const jobs = [{ ...job }];
  const runs: unknown[] = [];
  return {
    list: vi.fn(() => [{ ...jobs[0] }]),
    upsert: vi.fn((j: Partial<CronJob>) => {
      jobs[0] = { ...jobs[0], ...j } as CronJob;
      return jobs[0];
    }),
    patch: vi.fn((id: string, delta: Partial<CronJob>) => {
      if (jobs[0].id === id) {
        jobs[0] = { ...jobs[0], ...delta };
      }
    }),
    remove: vi.fn(() => true),
    appendRun: vi.fn((r: unknown) => { runs.push(r); }),
    listRuns: vi.fn(() => runs),
  } as unknown as CronStore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CronScheduler — cron kind isDue fix', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // -------------------------------------------------------------------------
  // Primary regression case: */30 with lastRun 31 minutes ago should fire
  // -------------------------------------------------------------------------
  it('fires when a cron boundary has passed since lastRun (drift-proof)', async () => {
    // "now" = 17:31 UTC.  */30 → _previous(17:31) = 17:30:00.
    // lastRun = 17:00:00 → 17:30 > 17:00 → TRUE → fires.
    const now = new Date('2026-04-21T17:31:00.000Z');
    vi.setSystemTime(now);

    const lastRunTime = new Date('2026-04-21T17:00:00.000Z');
    const job = makeJob({ lastRun: lastRunTime.toISOString() });
    const store = makeStore(job);
    const runner = vi.fn().mockResolvedValue(undefined);

    const scheduler = new CronScheduler(store, runner);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();

    expect(runner).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Drift simulation: tick arrives 1.2 s late (old code failed, new code passes)
  // -------------------------------------------------------------------------
  it('fires even when the tick arrives 1200 ms after the cron boundary', async () => {
    // */30 boundary at 17:30:00.  Tick arrives at 17:30:01.200 (1200 ms late).
    // Old code: Math.abs(1200) < 1000 → FALSE (missed fire).
    // New code: _previous(17:30:01) = 17:30:00 > lastRun(17:00:00) → TRUE.
    const boundaryPlus1200 = new Date('2026-04-21T17:30:01.200Z');
    vi.setSystemTime(boundaryPlus1200);

    const lastRunTime = new Date('2026-04-21T17:00:00.000Z');
    const job = makeJob({ lastRun: lastRunTime.toISOString() });
    const store = makeStore(job);
    const runner = vi.fn().mockResolvedValue(undefined);

    const scheduler = new CronScheduler(store, runner);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();

    expect(runner).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // No double-fire: once lastRun is updated to >= boundary, tick should not re-fire
  // -------------------------------------------------------------------------
  it('does NOT fire a second time once lastRun is updated past the boundary', async () => {
    // Job fired at 17:30:01 (lastRun = 17:30:01).  Next tick at 17:30:05.
    // _previous(17:30:05) = 17:30:00 > lastRun(17:30:01) → FALSE → no re-fire.
    const now = new Date('2026-04-21T17:30:05.000Z');
    vi.setSystemTime(now);

    // Simulate: job already ran 1 second after the boundary
    const lastRunTime = new Date('2026-04-21T17:30:01.000Z');
    const job = makeJob({ lastRun: lastRunTime.toISOString() });
    const store = makeStore(job);
    const runner = vi.fn().mockResolvedValue(undefined);

    const scheduler = new CronScheduler(store, runner);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5000);
    scheduler.stop();

    expect(runner).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // No-lastRun (seeded by store): does NOT fire before the next boundary
  // -------------------------------------------------------------------------
  it('does NOT fire before the next boundary when lastRun = registration time', async () => {
    // CronStore.upsert seeds lastRun = registration time.
    // Registered at 17:45.  _previous(17:45) = 17:30.
    // 17:30 > 17:45 → FALSE → no immediate fire.
    const registrationTime = new Date('2026-04-21T17:45:00.000Z');
    vi.setSystemTime(registrationTime);

    const job = makeJob({ lastRun: registrationTime.toISOString() });
    const store = makeStore(job);
    const runner = vi.fn().mockResolvedValue(undefined);

    const scheduler = new CronScheduler(store, runner);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();

    expect(runner).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // No-lastRun (seeded by store): fires at the next boundary after registration
  // -------------------------------------------------------------------------
  it('fires at the next boundary after registration (no back-fire)', async () => {
    // Registered at 17:45 (lastRun=17:45).  */30 next boundary = 18:00.
    // At 18:00:01: _previous(18:00:01) = 18:00:00 > lastRun(17:45) → fires.
    const registrationTime = new Date('2026-04-21T17:45:00.000Z');
    vi.setSystemTime(registrationTime);

    const job = makeJob({ lastRun: registrationTime.toISOString() });
    const store = makeStore(job);
    const runner = vi.fn().mockResolvedValue(undefined);

    const scheduler = new CronScheduler(store, runner);
    scheduler.start();

    // Advance 15m 1s past registration = 18:00:01
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1001);
    scheduler.stop();

    expect(runner).toHaveBeenCalledTimes(1);
  });
});
