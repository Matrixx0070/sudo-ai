/**
 * CronScheduler — timer-based job runner for SUDO-AI v3.
 *
 * Ticks every second. On each tick evaluates all enabled jobs against their
 * schedule using the `croner` library for cron expressions, and runs jobs
 * whose time has come. Applies exponential backoff for jobs that fail
 * consecutively. Dispatches payloads to an injected runner function so the
 * scheduler itself has no dependency on Brain or the agent loop.
 */

import { Cron } from 'croner';
import { createLogger } from '../shared/logger.js';
import { genId, sleep } from '../shared/utils.js';
import { CronStore } from './store.js';
import type { CronJob, CronPayload, CronSchedule } from './types.js';

const log = createLogger('cron:scheduler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tick interval for the evaluation loop (ms). */
const TICK_MS = 1_000 as const;

/** Maximum consecutive errors before a job is auto-disabled. */
const MAX_CONSECUTIVE_ERRORS = 10 as const;

/**
 * Cool-off before an auto-disabled job is re-enabled for probation. Without
 * this, one long provider outage (e.g. "all model profiles in cooldown")
 * permanently killed a job — enabled:false persisted, human-only recovery.
 * On probation: one success resets errors, one failure re-quarantines.
 */
const AUTO_REENABLE_MS = 6 * 60 * 60 * 1000;

/**
 * Exponential backoff delays (ms) applied between retries of a failing job.
 * Index is min(consecutiveErrors - 1, length - 1).
 */
const BACKOFF_MS: readonly number[] = [
  1_000,
  5_000,
  15_000,
  60_000,
  300_000,
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Async function that executes a job payload. Injected at construction. */
export type PayloadRunner = (payload: CronPayload, job: CronJob) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a job's schedule is due at the given moment.
 * Uses croner for `cron` kind; arithmetic for `every` and `at`.
 */
function isDue(job: CronJob, now: Date): boolean {
  const schedule: CronSchedule = job.schedule;

  switch (schedule.kind) {
    case 'at': {
      const target = new Date(schedule.datetime);
      if (isNaN(target.getTime())) {
        log.warn({ jobId: job.id, datetime: schedule.datetime }, 'Invalid at datetime — skipping');
        return false;
      }
      // Fire once within a 1-second window of the target.
      return Math.abs(now.getTime() - target.getTime()) < TICK_MS;
    }

    case 'every': {
      if (!job.lastRun) return true; // Never run — fire immediately.
      const elapsed = now.getTime() - new Date(job.lastRun).getTime();
      return elapsed >= schedule.ms;
    }

    case 'cron': {
      try {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz });
        // _previous(now) returns the most recent cron occurrence strictly before now.
        // croner requires ≥1 second past a boundary to register it as "previous".
        // If that occurrence is after lastRun there is an unfired window — fire now.
        // lastRun is always set (CronStore.upsert seeds it to registration time for
        // brand-new jobs), so we never back-fire occurrences before registration.
        const prevCronerDate = (cron as unknown as { _previous: (d: Date) => { getDate: () => Date } | null })._previous(now);
        if (!prevCronerDate) return false;
        const prev = prevCronerDate.getDate();
        const lastRunMs = job.lastRun
          ? new Date(job.lastRun).getTime()
          : now.getTime(); // fallback: treat as just-now to avoid back-fire
        return prev.getTime() > lastRunMs;
      } catch (err) {
        log.warn({ jobId: job.id, expr: schedule.expr, err }, 'Invalid cron expression — skipping');
        return false;
      }
    }

    default:
      return false;
  }
}

/** Compute backoff delay for a job based on its consecutive error count. */
function backoffFor(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

/**
 * Evaluates all registered cron jobs on a 1-second interval and dispatches
 * payloads via an injected runner. All job state changes are persisted via
 * CronStore.
 */
export class CronScheduler {
  private readonly store: CronStore;
  private readonly runner: PayloadRunner;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly runningJobs = new Set<string>();

  /**
   * @param store  - CronStore instance for job persistence.
   * @param runner - Function that handles payload dispatch (agent turn / event).
   */
  constructor(store: CronStore, runner: PayloadRunner) {
    if (!store) throw new TypeError('CronScheduler: store must be provided');
    if (typeof runner !== 'function') throw new TypeError('CronScheduler: runner must be a function');

    this.store = store;
    this.runner = runner;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the scheduler tick loop. Idempotent — safe to call multiple times. */
  start(): void {
    if (this.running) {
      log.warn('CronScheduler.start called while already running — ignoring');
      return;
    }

    this.running = true;
    this.timer = setInterval(() => {
      this._tick().catch((err) => log.error({ err }, 'Unexpected error in scheduler tick'));
    }, TICK_MS);

    log.info({ tickMs: TICK_MS }, 'CronScheduler started');
  }

  /** Stop the scheduler tick loop. Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    log.info('CronScheduler stopped');
  }

  /** Whether the scheduler is currently ticking. */
  get isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Job management
  // -------------------------------------------------------------------------

  /**
   * Add or replace a job definition in the store.
   *
   * @param job - Job definition (id is generated if omitted).
   * @returns The stored job.
   */
  addJob(job: Omit<CronJob, 'id'> & { id?: string }): CronJob {
    const stored = this.store.upsert(job);
    log.info({ jobId: stored.id, jobName: stored.name }, 'Job added to scheduler');
    return stored;
  }

  /**
   * Remove a job from the store by ID.
   *
   * @param id - Job ID to remove.
   * @returns True if the job was found and removed.
   */
  removeJob(id: string): boolean {
    const removed = this.store.remove(id);
    if (removed) {
      log.info({ jobId: id }, 'Job removed from scheduler');
    } else {
      log.warn({ jobId: id }, 'removeJob: job not found');
    }
    return removed;
  }

  /**
   * Return the current list of all jobs (enabled and disabled).
   */
  listJobs(): CronJob[] {
    return this.store.list();
  }

  // -------------------------------------------------------------------------
  // Private — tick evaluation
  // -------------------------------------------------------------------------

  private async _tick(): Promise<void> {
    const now = new Date();

    // Probation: re-enable jobs the scheduler itself disabled once the
    // cool-off has passed. Manual disables (no autoDisabledAt) are untouched.
    for (const job of this.store.list()) {
      if (job.enabled || !job.autoDisabledAt) continue;
      if (now.getTime() - new Date(job.autoDisabledAt).getTime() < AUTO_REENABLE_MS) continue;
      this.store.patch(job.id, { enabled: true, autoDisabledAt: undefined });
      log.warn(
        { jobId: job.id, jobName: job.name, consecutiveErrors: job.consecutiveErrors },
        'Auto-disabled cron job re-enabled for probation after cool-off',
      );
    }

    const jobs = this.store.list().filter((j) => j.enabled);

    for (const job of jobs) {
      if (!isDue(job, now)) continue;

      // Apply backoff: if there are recent errors, check if we should wait.
      if (job.consecutiveErrors > 0) {
        const delay = backoffFor(job.consecutiveErrors);
        if (job.lastRun) {
          const elapsed = now.getTime() - new Date(job.lastRun).getTime();
          if (elapsed < delay) continue; // Still in backoff window.
        }
      }

      // Fire without blocking the tick loop.
      this._fireJob(job, now).catch((err) => {
        log.error({ jobId: job.id, jobName: job.name, err }, 'Unhandled error firing job');
      });
    }
  }

  private async _fireJob(job: CronJob, now: Date): Promise<void> {
    // Prevent re-entry: if this job is already running, skip.
    if (this.runningJobs.has(job.id)) return;
    this.runningJobs.add(job.id);

    // Set lastRun BEFORE the async work to prevent the next tick from
    // re-triggering the same job while it is still in flight.
    this.store.patch(job.id, { lastRun: now.toISOString() });

    const startMs = Date.now();
    const runId = genId();

    log.info({ jobId: job.id, jobName: job.name, runId }, 'Firing cron job');

    try {
      await this.runner(job.payload, job);

      const durationMs = Date.now() - startMs;

      this.store.patch(job.id, {
        lastRun: now.toISOString(),
        consecutiveErrors: 0,
      });

      this.store.appendRun({
        id: runId,
        jobName: job.name,
        ranAt: now.toISOString(),
        durationMs,
        success: true,
      });

      log.info({ jobId: job.id, jobName: job.name, durationMs }, 'Cron job completed successfully');
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const newErrorCount = job.consecutiveErrors + 1;
      const errorMsg = String(err);

      this.store.patch(job.id, {
        lastRun: now.toISOString(),
        consecutiveErrors: newErrorCount,
        // Auto-disable after too many consecutive failures; the probation
        // sweep in _tick re-enables it after AUTO_REENABLE_MS.
        enabled: newErrorCount < MAX_CONSECUTIVE_ERRORS,
        ...(newErrorCount >= MAX_CONSECUTIVE_ERRORS ? { autoDisabledAt: now.toISOString() } : {}),
      });

      this.store.appendRun({
        id: runId,
        jobName: job.name,
        ranAt: now.toISOString(),
        durationMs,
        success: false,
        error: errorMsg,
      });

      if (newErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        log.error(
          { jobId: job.id, jobName: job.name, consecutiveErrors: newErrorCount },
          'Cron job auto-disabled after too many consecutive failures',
        );
      } else {
        const nextBackoff = backoffFor(newErrorCount);
        log.warn(
          { jobId: job.id, jobName: job.name, consecutiveErrors: newErrorCount, nextBackoffMs: nextBackoff },
          'Cron job failed — will retry after backoff',
        );
      }
    } finally {
      this.runningJobs.delete(job.id);
    }
  }
}
