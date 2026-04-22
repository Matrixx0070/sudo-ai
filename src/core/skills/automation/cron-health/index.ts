/**
 * Skill: automation.cron-health
 * Category: automation
 * Version: 1.0.0
 *
 * Checks all registered cron jobs and reports which are healthy (ran recently
 * without error) and which are failing (last run errored, or overdue).
 *
 * Data sources:
 *   - data/cron/jobs.json   — registered jobs with schedule info
 *   - mind.db cron_runs     — execution history (job_name, status, ran_at, error)
 *
 * No external calls — fully local.
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../tools/types.js';
import type { ToolRegistry } from '../../../tools/registry.js';

const logger = createLogger('skill.automation.cron-health');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(process.cwd());
const JOBS_FILE = resolve(PROJECT_ROOT, 'data', 'cron', 'jobs.json');
const DB_PATH = resolve(PROJECT_ROOT, 'data', 'mind.db');

/** A job is considered overdue if last run is older than 3× its interval. */
const OVERDUE_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CronJobDef {
  id: string;
  name: string;
  schedule?: { kind: string; ms?: number; cron?: string };
  enabled?: boolean;
}

interface CronRunRow {
  job_name: string;
  status: string;
  duration_ms: number;
  error: string | null;
  ran_at: string;
}

export interface CronHealthOutput {
  healthy: string[];
  failing: string[];
  lastRun: string;
  details: Array<{
    name: string;
    status: 'healthy' | 'failing' | 'unknown';
    lastRan: string | null;
    lastError: string | null;
    overdue: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJobs(): CronJobDef[] {
  if (!existsSync(JOBS_FILE)) {
    logger.warn({ path: JOBS_FILE }, 'jobs.json not found');
    return [];
  }
  try {
    const raw = readFileSync(JOBS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CronJobDef[]) : [];
  } catch (err) {
    logger.error({ err }, 'Failed to parse jobs.json');
    return [];
  }
}

function openDb(): Database.Database | null {
  if (!existsSync(DB_PATH)) {
    logger.warn({ path: DB_PATH }, 'mind.db not found');
    return null;
  }
  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch (err) {
    logger.error({ err }, 'Failed to open mind.db');
    return null;
  }
}

function getLastRuns(db: Database.Database): Map<string, CronRunRow> {
  const map = new Map<string, CronRunRow>();
  try {
    const rows = db.prepare<[], CronRunRow>(`
      SELECT job_name, status, duration_ms, error, ran_at
      FROM cron_runs
      WHERE ran_at = (SELECT MAX(r2.ran_at) FROM cron_runs r2 WHERE r2.job_name = cron_runs.job_name)
      ORDER BY job_name
    `).all();
    for (const row of rows) {
      map.set(row.job_name, row);
    }
  } catch (err) {
    logger.error({ err }, 'Failed to query cron_runs');
  }
  return map;
}

function isOverdue(job: CronJobDef, lastRanAt: string | null): boolean {
  if (!job.schedule?.ms || !lastRanAt) return false;
  const expectedIntervalMs = job.schedule.ms * OVERDUE_MULTIPLIER;
  const elapsed = Date.now() - new Date(lastRanAt).getTime();
  return elapsed > expectedIntervalMs;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function checkCronHealth(_ctx: ToolContext): CronHealthOutput {
  logger.info('automation.cron-health starting');

  const jobs = loadJobs();
  const db = openDb();
  const lastRuns = db ? getLastRuns(db) : new Map<string, CronRunRow>();
  if (db) db.close();

  const healthy: string[] = [];
  const failing: string[] = [];
  const details: CronHealthOutput['details'] = [];

  // If no jobs defined, include known job names from DB runs
  const allJobNames = new Set(jobs.map((j) => j.name));
  for (const jobName of lastRuns.keys()) {
    allJobNames.add(jobName);
  }

  for (const jobName of allJobNames) {
    const job = jobs.find((j) => j.name === jobName);
    const lastRun = lastRuns.get(jobName) ?? null;
    const lastRanAt = lastRun?.ran_at ?? null;
    const lastError = lastRun?.error ?? null;
    const lastStatus = lastRun?.status ?? 'unknown';
    const overdue = job ? isOverdue(job, lastRanAt) : false;

    if (lastStatus === 'ok' && !overdue) {
      healthy.push(jobName);
      details.push({ name: jobName, status: 'healthy', lastRan: lastRanAt, lastError: null, overdue: false });
    } else if (lastStatus === 'failed' || overdue) {
      failing.push(jobName);
      details.push({ name: jobName, status: 'failing', lastRan: lastRanAt, lastError, overdue });
    } else {
      details.push({ name: jobName, status: 'unknown', lastRan: lastRanAt, lastError, overdue: false });
    }
  }

  const lastRun = details
    .filter((d) => d.lastRan)
    .sort((a, b) => new Date(b.lastRan!).getTime() - new Date(a.lastRan!).getTime())[0]?.lastRan
    ?? 'never';

  logger.info({ healthy: healthy.length, failing: failing.length }, 'automation.cron-health complete');
  return { healthy, failing, lastRun, details };
}

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export const skillTool: ToolDefinition = {
  name: 'automation.cron-health',
  description:
    'Check all registered cron jobs and report which are healthy (ran recently without error) '
    + 'and which are failing (last run errored or job is overdue). '
    + 'Input: {} (no params). Output: { healthy, failing, lastRun, details }.',
  category: 'system',
  timeout: 15_000,
  parameters: {},

  async execute(_params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = checkCronHealth(ctx);
      const lines = [
        `Cron Health — ${result.healthy.length} healthy, ${result.failing.length} failing`,
        `Last run: ${result.lastRun}`,
        result.healthy.length > 0 ? `Healthy: ${result.healthy.join(', ')}` : 'No healthy jobs.',
        result.failing.length > 0 ? `Failing: ${result.failing.join(', ')}` : 'No failing jobs.',
      ];
      for (const d of result.details) {
        if (d.status === 'failing') {
          lines.push(`  [FAIL] ${d.name}: lastRan=${d.lastRan ?? 'never'}, overdue=${d.overdue}, error=${d.lastError ?? 'none'}`);
        }
      }
      return { success: true, output: lines.join('\n'), data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'automation.cron-health error');
      return { success: false, output: `automation.cron-health error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration export
// ---------------------------------------------------------------------------

export function registerSkill(registry: ToolRegistry): void {
  registry.register(skillTool);
}

export default skillTool;
