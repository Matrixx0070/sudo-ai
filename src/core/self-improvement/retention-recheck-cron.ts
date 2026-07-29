/**
 * @file self-improvement/retention-recheck-cron.ts
 * @description AL8.4 quarterly re-check cron — registered FLAG-OFF, following
 * the self-build/cron-entry.ts pattern (deterministic job id so pm2 reloads
 * never duplicate; agentTurn payload; enabled only under
 * SUDO_AL8_RETENTION_RECHECK=1, default OFF). Fires 04:00 UTC on the 1st of
 * every third month. The turn instructs the agent to drive
 * RetentionLedger.recheck() against the current bench and REPORT flags —
 * flagged rows await human review, never auto-revert (never-drop).
 */

import { createLogger } from '../shared/logger.js';
import type { CronJob } from '../cron/types.js';

const log = createLogger('self-improvement:retention-cron');

export const RETENTION_RECHECK_JOB_NAME = 'AL8.4 retention recheck (quarterly)';

const RECHECK_MSG = [
  '[AL8.4 quarterly retention re-check]',
  'Re-validate every retained improvement in the improvement_retention ledger',
  '(src/core/self-improvement/retention-ledger.ts) against the CURRENT bench:',
  'run RetentionLedger.recheck() with a bench evaluator; report checked/',
  'flagged/skipped counts and list every FLAGGED row with its flag_reason.',
  'Flags are for HUMAN review — never revert anything automatically.',
].join(' ');

interface SchedulerLike {
  listJobs(): CronJob[];
  removeJob(id: string): void;
  addJob(job: Omit<CronJob, 'id'> & { id: string }): CronJob;
}

/** Register the quarterly job (idempotent; enabled only when the flag is on). */
export function registerRetentionRecheckCron(scheduler: SchedulerLike): CronJob {
  const enabled = process.env['SUDO_AL8_RETENTION_RECHECK'] === '1';

  for (const job of scheduler.listJobs()) {
    if (job.name === RETENTION_RECHECK_JOB_NAME) scheduler.removeJob(job.id);
  }

  const job = scheduler.addJob({
    id: 'al8-retention-recheck', // deterministic — no duplication on pm2 reload
    name: RETENTION_RECHECK_JOB_NAME,
    schedule: { kind: 'cron', expr: '0 4 1 */3 *', tz: 'UTC' },
    payload: { kind: 'agentTurn', message: RECHECK_MSG },
    sessionTarget: 'isolated',
    enabled,
    consecutiveErrors: 0,
  } satisfies Omit<CronJob, 'id'> & { id: string });

  log.info({ jobId: job.id, enabled, expr: '0 4 1 */3 *' }, `Registered cron job: ${RETENTION_RECHECK_JOB_NAME}`);
  return job;
}
