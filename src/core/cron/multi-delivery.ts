/**
 * Multi-Delivery Cron System
 *
 * Manages cron jobs that execute prompts and deliver results to multiple targets.
 * Supports: local logging, Telegram, Discord, Slack, email, and generic webhooks.
 *
 * Kill-switch: SUDO_MULTI_DELIVERY_DISABLE=1
 */

import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import type { CronJob, DeliveryTarget, DeliveryResult, CronJobRow } from './multi-delivery-types.js';

// Dynamic import for better-sqlite3 (CommonJS module)
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const Database: any = (await import('better-sqlite3')).default;

const log = createLogger('cron:multi-delivery');

const DB_PATH = path.join(DATA_DIR, 'cron-jobs.db');

/** Generate a unique ID for new jobs */
function generateId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse interval ms from string */
function parseInterval(value: string): number {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? 0 : parsed;
}

/** Check if a cron expression is due (simplified: supports */
function isCronDue(cronExpr: string, now: Date): boolean {
  const [minute, hour, day, month, weekday] = cronExpr.split(' ');
  const currentMinute = now.getMinutes();
  const currentHour = now.getHours();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth() + 1;
  const currentWeekday = now.getDay();

  const match = (pattern: string | undefined, value: number): boolean => {
    if (!pattern || pattern === '*') return true;
    if (pattern === String(value)) return true;
    if (pattern?.startsWith('*/')) {
      const step = parseInt(pattern.slice(2), 10);
      if (!isNaN(step) && value % step === 0) return true;
    }
    return false;
  };

  return (
    match(minute, currentMinute) &&
    match(hour, currentHour) &&
    match(day, currentDay) &&
    match(month, currentMonth) &&
    match(weekday, currentWeekday)
  );
}

/**
 * MultiDeliveryCron - manages cron jobs with multiple delivery targets
 */
export class MultiDeliveryCron {
  private db: any = null;
  private ticker: NodeJS.Timeout | null = null;
  private readonly killSwitch = 'SUDO_MULTI_DELIVERY_DISABLE';

  constructor(dbPath: string = DB_PATH) {
    // Ensure data directory exists
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        log.warn({ err: String(err), dir }, 'Cannot create cron data directory');
      }
    }

    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.initSchema();
      log.info({ dbPath }, 'MultiDeliveryCron initialized');
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to initialize cron database');
    }
  }

  private initSchema(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'interval')),
        schedule_value TEXT NOT NULL,
        prompt TEXT NOT NULL,
        skills TEXT NOT NULL DEFAULT '[]',
        deliver TEXT NOT NULL DEFAULT '[]',
        repeat_times INTEGER,
        repeat_completed INTEGER DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled)`);
  }

  /** Add a new cron job */
  addJob(job: Omit<CronJob, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt'>): CronJob {
    const now = new Date().toISOString();
    const newJob: CronJob = {
      ...job,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };

    if (!this.db) return newJob;

    const stmt = this.db.prepare(`
      INSERT INTO cron_jobs (
        id, name, schedule_type, schedule_value, prompt, skills, deliver,
        repeat_times, repeat_completed, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      newJob.id,
      newJob.name,
      newJob.schedule.type,
      newJob.schedule.value,
      newJob.prompt,
      JSON.stringify(newJob.skills),
      JSON.stringify(newJob.deliver),
      newJob.repeat?.times ?? null,
      newJob.repeat?.completed ?? 0,
      newJob.enabled ? 1 : 0,
      newJob.createdAt,
      newJob.updatedAt,
    );

    log.info({ jobId: newJob.id, name: newJob.name }, 'Cron job added');
    return newJob;
  }

  /** Remove a cron job */
  removeJob(id: string): boolean {
    if (!this.db) return false;

    const stmt = this.db.prepare('DELETE FROM cron_jobs WHERE id = ?');
    const result = stmt.run(id);
    const removed = result.changes > 0;

    if (removed) {
      log.info({ jobId: id }, 'Cron job removed');
    }

    return removed;
  }

  /** Get a single job by ID */
  getJob(id: string): CronJob | null {
    if (!this.db) return null;

    const stmt = this.db.prepare('SELECT * FROM cron_jobs WHERE id = ?');
    const row = stmt.get(id) as CronJobRow | undefined;

    if (!row) return null;

    return this.rowToJob(row);
  }

  /** List all jobs */
  listJobs(): CronJob[] {
    if (!this.db) return [];

    const stmt = this.db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC');
    const rows = stmt.all() as CronJobRow[];

    return rows.map((row) => this.rowToJob(row));
  }

  /** Enable a job */
  enableJob(id: string): boolean {
    return this.setJobEnabled(id, true);
  }

  /** Disable a job */
  disableJob(id: string): boolean {
    return this.setJobEnabled(id, false);
  }

  private setJobEnabled(id: string, enabled: boolean): boolean {
    if (!this.db) return false;

    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?
    `);

    const result = stmt.run(enabled ? 1 : 0, new Date().toISOString(), id);
    const updated = result.changes > 0;

    if (updated) {
      log.info({ jobId: id, enabled }, 'Cron job enabled state changed');
    }

    return updated;
  }

  /** Update a job */
  updateJob(id: string, updates: Partial<CronJob>): CronJob | null {
    if (!this.db) return null;

    const existing = this.getJob(id);
    if (!existing) return null;

    const updated: CronJob = { ...existing, ...updates, updatedAt: new Date().toISOString() };

    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET
        name = ?, schedule_type = ?, schedule_value = ?, prompt = ?,
        skills = ?, deliver = ?, repeat_times = ?, repeat_completed = ?,
        enabled = ?, last_run_at = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updated.name,
      updated.schedule.type,
      updated.schedule.value,
      updated.prompt,
      JSON.stringify(updated.skills),
      JSON.stringify(updated.deliver),
      updated.repeat?.times ?? null,
      updated.repeat?.completed ?? 0,
      updated.enabled ? 1 : 0,
      updated.lastRunAt ?? null,
      updated.updatedAt,
      id,
    );

    log.info({ jobId: id }, 'Cron job updated');
    return updated;
  }

  /** Mark job as run */
  private markJobRun(id: string): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET last_run_at = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), new Date().toISOString(), id);
  }

  /** Increment repeat counter */
  private incrementRepeat(id: string): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET repeat_completed = COALESCE(repeat_completed, 0) + 1 WHERE id = ?
    `);
    stmt.run(id);
  }

  /** Check if job is due */
  private isJobDue(job: CronJob, now: Date): boolean {
    if (!job.enabled) return false;

    // Check repeat limit
    if (job.repeat && job.repeat.completed >= job.repeat.times) {
      return false;
    }

    if (job.schedule.type === 'interval') {
      const intervalMs = parseInterval(job.schedule.value);
      if (!intervalMs || !job.lastRunAt) return false;
      const lastRun = new Date(job.lastRunAt).getTime();
      return now.getTime() - lastRun >= intervalMs;
    }

    if (job.schedule.type === 'cron') {
      return isCronDue(job.schedule.value, now);
    }

    return false;
  }

  /** Convert database row to CronJob */
  private rowToJob(row: CronJobRow): CronJob {
    return {
      id: row.id,
      name: row.name,
      schedule: {
        type: row.schedule_type,
        value: row.schedule_value,
      },
      prompt: row.prompt,
      skills: JSON.parse(row.skills) as string[],
      deliver: JSON.parse(row.deliver) as DeliveryTarget[],
      repeat:
        row.repeat_times !== null
          ? { times: row.repeat_times, completed: row.repeat_completed ?? 0 }
          : undefined,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Deliver to a single target */
  async deliverToTarget(job: CronJob, target: DeliveryTarget): Promise<DeliveryResult> {
    const now = new Date().toISOString();
    const message = `[${job.name}] ${job.prompt}`;

    // Check kill switch
    if (process.env[this.killSwitch] === '1') {
      log.debug({ jobId: job.id, target: target.type }, 'Delivery skipped (kill-switch active)');
      return { target, success: false, error: 'Kill-switch active', deliveredAt: now };
    }

    try {
      switch (target.type) {
        case 'local': {
          log.info({ job: job.name, prompt: job.prompt }, 'Cron job delivery (local)');
          return { target, success: true, deliveredAt: now };
        }

        case 'telegram': {
          const { botToken, chatId } = target.config as { botToken?: string; chatId?: string };
          if (!botToken || !chatId) {
            return { target, success: false, error: 'Missing botToken or chatId', deliveredAt: now };
          }
          const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
          const body = new URLSearchParams({ chat_id: chatId, text: message });
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) throw new Error(`Telegram API: ${res.status}`);
          return { target, success: true, deliveredAt: now };
        }

        case 'discord': {
          const { webhookUrl } = target.config as { webhookUrl?: string };
          if (!webhookUrl) {
            return { target, success: false, error: 'Missing webhookUrl', deliveredAt: now };
          }
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message }),
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) throw new Error(`Discord webhook: ${res.status}`);
          return { target, success: true, deliveredAt: now };
        }

        case 'slack': {
          const { webhookUrl } = target.config as { webhookUrl?: string };
          if (!webhookUrl) {
            return { target, success: false, error: 'Missing webhookUrl', deliveredAt: now };
          }
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message }),
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) throw new Error(`Slack webhook: ${res.status}`);
          return { target, success: true, deliveredAt: now };
        }

        case 'email': {
          // Email integration deferred - just log
          const { to } = target.config as { to?: string };
          log.info({ to: to ?? 'unspecified', subject: job.name }, 'Email delivery (deferred)');
          return { target, success: true, deliveredAt: now, error: 'Email integration deferred - logged only' };
        }

        case 'webhook': {
          const { url, headers } = target.config as { url?: string; headers?: Record<string, string> };
          if (!url) {
            return { target, success: false, error: 'Missing webhook url', deliveredAt: now };
          }
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ job: job.name, prompt: job.prompt, timestamp: now }),
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) throw new Error(`Webhook: ${res.status}`);
          return { target, success: true, deliveredAt: now };
        }

        default:
          return { target, success: false, error: `Unknown target type: ${(target as DeliveryTarget).type}`, deliveredAt: now };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn({ jobId: job.id, target: target.type, error: errorMsg }, 'Delivery failed');
      return { target, success: false, error: errorMsg, deliveredAt: now };
    }
  }

  /** Tick - check all jobs and run due ones */
  async tick(): Promise<void> {
    if (process.env[this.killSwitch] === '1') {
      log.debug('Tick skipped (kill-switch active)');
      return;
    }

    if (!this.db) return;

    const now = new Date();
    const jobs = this.listJobs();
    let runCount = 0;

    for (const job of jobs) {
      if (this.isJobDue(job, now)) {
        log.info({ jobId: job.id, name: job.name }, 'Running due cron job');

        // Deliver to all targets in parallel
        const results = await Promise.all(job.deliver.map((target) => this.deliverToTarget(job, target)));

        const successCount = results.filter((r) => r.success).length;
        log.info({ jobId: job.id, success: successCount, total: results.length }, 'Cron job delivery complete');

        this.markJobRun(job.id);
        if (job.repeat) this.incrementRepeat(job.id);
        runCount++;
      }
    }

    if (runCount > 0) {
      log.debug({ runCount, total: jobs.length }, 'Tick complete');
    }
  }

  /** Start the ticker (runs every 10 seconds) */
  startTicker(intervalMs: number = 10000): void {
    if (this.ticker || process.env[this.killSwitch] === '1') return;

    this.ticker = setInterval(() => {
      this.tick().catch((err) => log.error({ err: String(err) }, 'Tick error'));
    }, intervalMs);

    log.info({ intervalMs }, 'Cron ticker started');
  }

  /** Stop the ticker */
  stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
      log.info('Cron ticker stopped');
    }
  }

  /** Close the database connection */
  close(): void {
    this.stopTicker();
    if (this.db) {
      this.db.close();
      this.db = null;
      log.info('MultiDeliveryCron closed');
    }
  }
}
