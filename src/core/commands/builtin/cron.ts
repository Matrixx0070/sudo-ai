/**
 * @file builtin/cron.ts
 * @description /cron — list all cron jobs with next run time and status.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:cron');

interface CronJobInfo {
  id: string;
  name?: string;
  enabled?: boolean;
  lastRun?: string | Date | null;
  nextRun?: string | Date | null;
  consecutiveErrors?: number;
  schedule?: { kind: string; expr?: string; ms?: number; datetime?: string };
}

interface SchedulerLike {
  listJobs?: () => CronJobInfo[];
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return 'never';
  try {
    return new Date(d).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return String(d);
  }
}

function scheduleLabel(job: CronJobInfo): string {
  const s = job.schedule;
  if (!s) return 'unknown';
  if (s.kind === 'cron') return `cron:${s.expr ?? '?'}`;
  if (s.kind === 'every') return `every ${Math.round((s.ms ?? 0) / 1000)}s`;
  if (s.kind === 'at') return `at:${s.datetime ?? '?'}`;
  return s.kind;
}

export const cronCommand: SlashCommand = {
  name: 'cron',
  description: 'List all cron jobs with schedule, last run, and status.',
  usage: '/cron',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.debug({ peerId: ctx.peerId }, '/cron executed');

    const config = ctx.config as { scheduler?: SchedulerLike; cronScheduler?: SchedulerLike } | null;
    const scheduler: SchedulerLike | undefined = config?.scheduler ?? config?.cronScheduler;

    let jobs: CronJobInfo[] = [];

    if (scheduler?.listJobs) {
      try {
        jobs = scheduler.listJobs();
      } catch (err) {
        log.error({ err }, '/cron: failed to read scheduler');
        return `Failed to list cron jobs: ${String(err)}`;
      }
    } else {
      // Fallback: read from DB cron table
      const db = ctx.db as {
        db?: {
          prepare: (q: string) => { all: () => Array<{ id: string; payload: string; enabled: number; last_run: string | null }> };
        };
      } | null;

      try {
        const rows = db?.db?.prepare(
          `SELECT id, payload, enabled, last_run FROM cron_jobs ORDER BY id`,
        ).all();

        if (rows) {
          jobs = rows.map((r) => {
            let name = r.id;
            try {
              const p = JSON.parse(r.payload) as { type?: string };
              name = p.type ?? r.id;
            } catch { /* ignore */ }
            return {
              id: r.id,
              name,
              enabled: Boolean(r.enabled),
              lastRun: r.last_run,
            };
          });
        }
      } catch {
        // non-fatal
      }
    }

    if (jobs.length === 0) {
      return 'No cron jobs found.';
    }

    const lines = [`Cron jobs (${jobs.length}):`, ''];
    for (const job of jobs) {
      const status = job.enabled !== false ? 'enabled' : 'DISABLED';
      const errors = job.consecutiveErrors ? ` errors:${job.consecutiveErrors}` : '';
      lines.push(
        `[${status}${errors}] ${job.name ?? job.id}`,
        `  Schedule: ${scheduleLabel(job)}`,
        `  Last run: ${fmtDate(job.lastRun)}`,
        `  Next run: ${fmtDate(job.nextRun)}`,
        '',
      );
    }

    return lines.join('\n').trimEnd();
  },
};
