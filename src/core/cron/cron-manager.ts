/**
 * @file cron/cron-manager.ts
 * @description Upgrade 49 — Simple in-memory cron job manager.
 *
 * Provides lightweight CRUD operations for named cron job records without
 * persisting to disk. This is intentionally separate from the full CronStore /
 * CronScheduler system which handles persistence and execution. Use this module
 * when you need fast in-memory tracking of agent-created cron jobs.
 *
 * NOTE: The CronJob type here uses the name SimpleCronJob to avoid colliding
 * with the persisted CronJob interface exported from ./types.ts.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cron:manager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimpleCronJob {
  /** Unique identifier generated at creation time. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Standard 5- or 6-field cron expression, e.g. "0 * * * *". */
  schedule: string;
  /** Shell command or agent instruction to execute when the job fires. */
  command: string;
  /** Whether the job should be considered active. */
  enabled: boolean;
  /** ISO timestamp of the most recent run. */
  lastRun?: string;
  /** ISO timestamp of the next scheduled run (informational). */
  nextRun?: string;
  /** ISO timestamp when the job was registered. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const jobs: Map<string, SimpleCronJob> = new Map();

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Create and register a new simple cron job.
 *
 * @param name     - Human-readable label.
 * @param schedule - Cron expression.
 * @param command  - Command to run.
 * @returns The newly created job record.
 */
export function createCronJob(name: string, schedule: string, command: string): SimpleCronJob {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('cron-manager: name must be a non-empty string');
  }
  if (!schedule || typeof schedule !== 'string' || schedule.trim() === '') {
    throw new Error('cron-manager: schedule must be a non-empty string');
  }
  if (!command || typeof command !== 'string' || command.trim() === '') {
    throw new Error('cron-manager: command must be a non-empty string');
  }

  const id = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: SimpleCronJob = {
    id,
    name: name.trim(),
    schedule: schedule.trim(),
    command: command.trim(),
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  jobs.set(id, job);
  log.info({ id, name: job.name, schedule: job.schedule }, 'Cron job created');
  return job;
}

/**
 * Remove a job by ID.
 *
 * @returns `true` when the job existed and was removed; `false` otherwise.
 */
export function deleteCronJob(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const deleted = jobs.delete(id);
  if (deleted) {
    log.info({ id }, 'Cron job deleted');
  } else {
    log.warn({ id }, 'cron-manager: deleteCronJob — job not found');
  }
  return deleted;
}

/**
 * Return all registered jobs (enabled and disabled).
 */
export function listCronJobs(): SimpleCronJob[] {
  return Array.from(jobs.values());
}

/**
 * Return only enabled jobs.
 */
export function getActiveCronJobs(): SimpleCronJob[] {
  return Array.from(jobs.values()).filter((j) => j.enabled);
}

/**
 * Retrieve a single job by ID.
 */
export function getCronJob(id: string): SimpleCronJob | undefined {
  return jobs.get(id);
}

/**
 * Enable a job. No-op when the job does not exist.
 */
export function enableCronJob(id: string): void {
  const j = jobs.get(id);
  if (!j) {
    log.warn({ id }, 'cron-manager: enableCronJob — job not found');
    return;
  }
  j.enabled = true;
  log.info({ id }, 'Cron job enabled');
}

/**
 * Disable a job without deleting it. No-op when the job does not exist.
 */
export function disableCronJob(id: string): void {
  const j = jobs.get(id);
  if (!j) {
    log.warn({ id }, 'cron-manager: disableCronJob — job not found');
    return;
  }
  j.enabled = false;
  log.info({ id }, 'Cron job disabled');
}

/**
 * Update the lastRun timestamp to now. Call this after a job fires.
 */
export function markCronRun(id: string): void {
  const j = jobs.get(id);
  if (!j) {
    log.warn({ id }, 'cron-manager: markCronRun — job not found');
    return;
  }
  j.lastRun = new Date().toISOString();
  log.info({ id, lastRun: j.lastRun }, 'Cron job run recorded');
}

/**
 * Set the anticipated next-run timestamp (informational only).
 */
export function setNextRun(id: string, nextRun: string): void {
  const j = jobs.get(id);
  if (!j) {
    log.warn({ id }, 'cron-manager: setNextRun — job not found');
    return;
  }
  j.nextRun = nextRun;
}
