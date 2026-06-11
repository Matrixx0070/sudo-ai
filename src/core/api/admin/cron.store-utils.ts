/**
 * @file cron.store-utils.ts
 * @description File I/O and validation helpers for the cron admin handler.
 *
 * Operates directly on data/cron/jobs.json and data/cron/runs.jsonl to
 * avoid circular dependencies with CronStore / CronScheduler.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../shared/logger.js';
import { DATA_DIR } from '../../shared/paths.js';
import type { CronJob, CronRunRecord } from '../../cron/types.js';

const log = createLogger('api:admin:cron:utils');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const CRON_DIR  = path.join(DATA_DIR, 'cron');
export const JOBS_FILE = path.join(CRON_DIR, 'jobs.json');
export const JOBS_BAK  = path.join(CRON_DIR, 'jobs.json.bak');
export const RUNS_FILE = path.join(CRON_DIR, 'runs.jsonl');

/** Maximum run-history lines returned per request. */
export const MAX_HISTORY = 200;

// ---------------------------------------------------------------------------
// ID generator (nanoid-compatible — alphanumeric, 21 chars)
// ---------------------------------------------------------------------------

export function genId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ---------------------------------------------------------------------------
// Job file I/O
// ---------------------------------------------------------------------------

/**
 * Read all cron jobs from data/cron/jobs.json.
 * Returns an empty array if the file does not exist or is malformed.
 */
export function readJobs(): CronJob[] {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.warn({ file: JOBS_FILE }, 'jobs.json is not an array — returning empty list');
      return [];
    }
    return parsed as CronJob[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.error({ err, file: JOBS_FILE }, 'Failed to read jobs.json');
    }
    return [];
  }
}

/**
 * Atomically write the jobs array to data/cron/jobs.json.
 * Writes a .bak file first, then renames to prevent data loss on crash.
 */
export function writeJobs(jobs: CronJob[]): void {
  try {
    fs.mkdirSync(CRON_DIR, { recursive: true });
    const payload = JSON.stringify(jobs, null, 2);
    fs.writeFileSync(JOBS_BAK, payload, 'utf8');
    fs.renameSync(JOBS_BAK, JOBS_FILE);
    log.debug({ count: jobs.length }, 'jobs.json written');
  } catch (err) {
    log.error({ err, file: JOBS_FILE }, 'Failed to write jobs.json');
    throw new Error('Failed to persist cron jobs');
  }
}

/**
 * Read the last `limit` lines of runs.jsonl as CronRunRecord objects.
 * Returns an empty array if the file does not exist.
 */
export function readHistory(limit: number): CronRunRecord[] {
  try {
    const raw = fs.readFileSync(RUNS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    const records: CronRunRecord[] = [];
    for (const line of tail.reverse()) { // most-recent first
      try {
        records.push(JSON.parse(line) as CronRunRecord);
      } catch {
        // malformed line — skip
      }
    }
    return records;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn({ err, file: RUNS_FILE }, 'Could not read runs.jsonl');
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_SCHEDULE_KINDS = new Set(['at', 'every', 'cron']);
const VALID_PAYLOAD_KINDS  = new Set(['systemEvent', 'agentTurn']);

/**
 * Validate a CronSchedule object.
 * Returns an error message string on failure, or null on success.
 */
export function validateSchedule(schedule: unknown): string | null {
  if (typeof schedule !== 'object' || schedule === null) {
    return 'schedule must be an object';
  }
  const s = schedule as Record<string, unknown>;
  if (!VALID_SCHEDULE_KINDS.has(s['kind'] as string)) {
    return `schedule.kind must be one of: ${[...VALID_SCHEDULE_KINDS].join(', ')}`;
  }
  if (s['kind'] === 'at' && typeof s['datetime'] !== 'string') {
    return 'schedule.datetime is required for kind=at';
  }
  if (s['kind'] === 'every' && typeof s['ms'] !== 'number') {
    return 'schedule.ms (number) is required for kind=every';
  }
  if (s['kind'] === 'cron') {
    if (typeof s['expr'] !== 'string') return 'schedule.expr is required for kind=cron';
    if (typeof s['tz'] !== 'string')   return 'schedule.tz is required for kind=cron';
  }
  return null;
}

/**
 * Validate a CronPayload object.
 * Returns an error message string on failure, or null on success.
 */
export function validatePayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return 'payload must be an object';
  }
  const p = payload as Record<string, unknown>;
  if (!VALID_PAYLOAD_KINDS.has(p['kind'] as string)) {
    return `payload.kind must be one of: ${[...VALID_PAYLOAD_KINDS].join(', ')}`;
  }
  if (p['kind'] === 'systemEvent' && typeof p['event'] !== 'string') {
    return 'payload.event (string) is required for kind=systemEvent';
  }
  if (p['kind'] === 'agentTurn' && typeof p['message'] !== 'string') {
    return 'payload.message (string) is required for kind=agentTurn';
  }
  return null;
}

/**
 * Validate all required fields for creating a new cron job.
 * Returns an error message on first failure, or null on success.
 */
export function validateNewJob(input: Record<string, unknown>): string | null {
  if (typeof input['name'] !== 'string' || !input['name'].trim()) {
    return 'name (string) is required';
  }
  const schedErr = validateSchedule(input['schedule']);
  if (schedErr) return schedErr;
  const payErr = validatePayload(input['payload']);
  if (payErr) return payErr;
  if (input['sessionTarget'] !== 'main' && input['sessionTarget'] !== 'isolated') {
    return "sessionTarget must be 'main' or 'isolated'";
  }
  return null;
}

/**
 * Validate patch fields for updating an existing cron job.
 * Returns an error message on first failure, or null on success.
 */
export function validatePatchJob(input: Record<string, unknown>): string | null {
  if ('schedule' in input) {
    const err = validateSchedule(input['schedule']);
    if (err) return err;
  }
  if ('payload' in input) {
    const err = validatePayload(input['payload']);
    if (err) return err;
  }
  if ('sessionTarget' in input && input['sessionTarget'] !== 'main' && input['sessionTarget'] !== 'isolated') {
    return "sessionTarget must be 'main' or 'isolated'";
  }
  if ('name' in input && (typeof input['name'] !== 'string' || !(input['name'] as string).trim())) {
    return 'name must be a non-empty string';
  }
  return null;
}
