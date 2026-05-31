/**
 * CronStore — persistence layer for cron jobs and run history.
 *
 * Jobs are stored in data/cron/jobs.json (pretty-printed JSON).
 * Run history is appended line-by-line to data/cron/runs.jsonl.
 * Atomic writes use a .bak intermediate to prevent corruption on crash.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { PATHS } from '../shared/constants.js';
import type { CronJob, CronRunRecord } from './types.js';

const log = createLogger('cron:store');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CRON_DIR = path.resolve(PATHS.CRON);
const JOBS_FILE = path.join(CRON_DIR, 'jobs.json');
const JOBS_BAK = path.join(CRON_DIR, 'jobs.json.bak');
const RUNS_FILE = path.join(CRON_DIR, 'runs.jsonl');

// ---------------------------------------------------------------------------
// CronStore
// ---------------------------------------------------------------------------

/**
 * Handles load/save of cron job definitions and append-only run history.
 *
 * All file I/O is synchronous (better-sqlite3 style) to keep it simple and
 * avoid partially written states on concurrent scheduler ticks.
 */
export class CronStore {
  private jobs: Map<string, CronJob> = new Map();

  constructor() {
    this._ensureDir();
    this._load();
  }

  // -------------------------------------------------------------------------
  // Job CRUD
  // -------------------------------------------------------------------------

  /**
   * Return a snapshot of all stored jobs (enabled and disabled).
   */
  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  /**
   * Return a single job by ID, or undefined if not found.
   */
  get(id: string): CronJob | undefined {
    if (!id) return undefined;
    return this.jobs.get(id);
  }

  /**
   * Insert or fully replace a job. If the job has no id, one is generated.
   *
   * @param job - Job definition to upsert.
   * @returns The upserted job (with id guaranteed).
   */
  upsert(job: Omit<CronJob, 'id'> & { id?: string }): CronJob {
    const existingById = job.id ? this.jobs.get(job.id) : undefined;
    // Preserve lastRun from an existing record if the incoming definition omits it.
    // For brand-new jobs (never seen before, no lastRun supplied), seed lastRun to the
    // current time so the cron-kind isDue logic does NOT back-fire immediately on
    // registration — the job will fire at the NEXT scheduled boundary after this moment.
    const inheritedLastRun = existingById?.lastRun ?? job.lastRun ?? new Date().toISOString();

    const record: CronJob = {
      ...job,
      consecutiveErrors: job.consecutiveErrors ?? existingById?.consecutiveErrors ?? 0,
      id: job.id ?? genId(),
      lastRun: inheritedLastRun,
    };

    if (!record.name || typeof record.name !== 'string') {
      throw new TypeError('CronStore.upsert: job.name must be a non-empty string');
    }

    this.jobs.set(record.id, record);
    this._save();

    log.info({ jobId: record.id, jobName: record.name }, 'Cron job upserted');
    return record;
  }

  /**
   * Remove a job by ID.
   *
   * @param id - The job ID to delete.
   * @returns True if the job existed and was removed.
   */
  remove(id: string): boolean {
    if (!id) return false;
    const existed = this.jobs.delete(id);
    if (existed) {
      this._save();
      log.info({ jobId: id }, 'Cron job removed');
    }
    return existed;
  }

  /**
   * Update specific fields on an existing job.
   *
   * @param id      - The job ID to update.
   * @param updates - Partial job fields to merge.
   * @returns The updated job, or undefined if not found.
   */
  patch(id: string, updates: Partial<CronJob>): CronJob | undefined {
    const existing = this.jobs.get(id);
    if (!existing) {
      log.warn({ jobId: id }, 'CronStore.patch: job not found');
      return undefined;
    }

    const updated: CronJob = { ...existing, ...updates, id };
    this.jobs.set(id, updated);
    this._save();

    log.debug({ jobId: id }, 'Cron job patched');
    return updated;
  }

  // -------------------------------------------------------------------------
  // Run history
  // -------------------------------------------------------------------------

  /**
   * Append a run record to runs.jsonl.
   * Each line is a self-contained JSON object terminated by a newline.
   *
   * @param record - Run record to append (id is generated if missing).
   */
  appendRun(record: Omit<CronRunRecord, 'id'> & { id?: string }): void {
    const full: CronRunRecord = {
      ...record,
      id: record.id ?? genId(),
    };

    try {
      appendFileSync(RUNS_FILE, JSON.stringify(full) + '\n', 'utf8');
    } catch (err) {
      log.error({ err, jobName: record.jobName }, 'Failed to append run record');
    }
  }

  // -------------------------------------------------------------------------
  // Private — persistence
  // -------------------------------------------------------------------------

  private _ensureDir(): void {
    try {
      mkdirSync(CRON_DIR, { recursive: true });
    } catch (err) {
      log.error({ err, dir: CRON_DIR }, 'Failed to create cron data directory');
      throw err;
    }
  }

  private _load(): void {
    try {
      const raw = readFileSync(JOBS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as CronJob[];

      if (!Array.isArray(parsed)) {
        log.warn({ file: JOBS_FILE }, 'jobs.json is not an array — starting empty');
        return;
      }

      for (const job of parsed) {
        if (job?.id && job?.name) {
          this.jobs.set(job.id, job);
        }
      }

      log.info({ count: this.jobs.size, file: JOBS_FILE }, 'Cron jobs loaded from disk');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.info({ file: JOBS_FILE }, 'jobs.json not found — starting with empty job list');
      } else {
        log.error({ err, file: JOBS_FILE }, 'Failed to load jobs.json');
      }
    }
  }

  private _save(): void {
    const payload = JSON.stringify([...this.jobs.values()], null, 2);

    try {
      // Write to backup first, then atomically rename.
      writeFileSync(JOBS_BAK, payload, 'utf8');
      renameSync(JOBS_BAK, JOBS_FILE);
    } catch (err) {
      log.error({ err, file: JOBS_FILE }, 'Failed to save jobs.json');
      throw err;
    }
  }
}
