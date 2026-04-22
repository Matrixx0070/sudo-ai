/**
 * @file src/core/self-build/cron-entry.ts
 * @description Registers self-build cron jobs with the CronScheduler.
 *
 * Registers two recurring jobs:
 *   system.self-build        — every 30 min, enabled only when SUDO_SELF_BUILD_MODE=1
 *   system.self-build-report — daily at 09:00 UTC, always enabled
 *
 * The CronScheduler dispatches payloads via a runner injected at construction
 * (see cli.ts — Builder L). This module also exports named handler functions
 * that Builder L calls from the runner based on the sentinel payload message.
 *
 * Sentinel messages:
 *   agentTurn { message: 'SELF_BUILD_TICK' }        → handleSelfBuildTick(deps)
 *   agentTurn { message: 'SELF_BUILD_DAILY_REPORT' } → handleDailyReport(deps)
 */

import { createLogger } from '../shared/logger.js';
import type { CronScheduler } from '../cron/scheduler.js';
import type { CronJob } from '../cron/types.js';
import { runSelfBuildTick, type SelfBuildDeps, type TickResult } from './orchestrator.js';
import { generateDailyReport, type DailyReportDeps, type DailyReportResult } from './daily-report.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TICK_JOB_NAME = 'system.self-build' as const;
const REPORT_JOB_NAME = 'system.self-build-report' as const;

/** Sentinel payload message for the 30-min tick. */
export const SELF_BUILD_TICK_MSG = 'SELF_BUILD_TICK' as const;

/** Sentinel payload message for the daily report. */
export const SELF_BUILD_DAILY_REPORT_MSG = 'SELF_BUILD_DAILY_REPORT' as const;

const log = createLogger('self-build:cron');

// ---------------------------------------------------------------------------
// Exported handler functions
// Called by cli.ts runner when the matching sentinel payload message is seen.
// ---------------------------------------------------------------------------

/**
 * Handle a self-build tick invocation.
 * Swallows errors to prevent scheduler disruption — logs failures instead.
 *
 * @returns TickResult on success, null if suppressed or on unexpected error.
 */
export async function handleSelfBuildTick(deps: SelfBuildDeps): Promise<TickResult | null> {
  if (process.env['SUDO_SELF_BUILD_MODE'] !== '1') {
    log.info({}, 'handleSelfBuildTick: SUDO_SELF_BUILD_MODE not set — skipping');
    return null;
  }

  try {
    const result = await runSelfBuildTick(deps);
    log.info(
      { status: result.status, commitSha: result.commitSha, message: result.message },
      'Self-build tick completed',
    );
    return result;
  } catch (err: unknown) {
    log.error({ err: String(err) }, 'handleSelfBuildTick: unexpected error — swallowed');
    return null;
  }
}

/**
 * Handle a daily-report invocation.
 * Converts SelfBuildDeps to DailyReportDeps and delegates.
 * Swallows errors — daily report failures must not affect scheduler.
 *
 * @returns DailyReportResult on success, null on error.
 */
export async function handleDailyReport(deps: SelfBuildDeps): Promise<DailyReportResult | null> {
  // Build DailyReportDeps from SelfBuildDeps — the two dep shapes partially overlap.
  const reportDeps: DailyReportDeps = {
    mindDb: deps.mindDb,
    alignmentAggregator: deps.alignmentAggregator ?? undefined,
    gitCwd: deps.gitCwd ?? process.cwd(),
    logger: deps.logger as unknown as import('pino').Logger,
  };

  try {
    const result = await generateDailyReport(reportDeps);
    log.info(
      { reportPath: result.reportPath, commitCount: result.commitCount, telegramPushed: result.telegramPushed },
      'Self-build daily report generated',
    );
    return result;
  } catch (err: unknown) {
    log.error({ err: String(err) }, 'handleDailyReport: unexpected error — swallowed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register both self-build cron jobs with the provided scheduler.
 *
 * The scheduler's runner (injected at construction in cli.ts) handles
 * dispatch: it checks payload.message and calls the appropriate handler.
 *
 * @param scheduler - Active CronScheduler instance.
 * @param deps      - SelfBuildDeps used by tick and report handlers.
 */
export function registerSelfBuildCron(
  scheduler: CronScheduler,
  deps: SelfBuildDeps,
): void {
  if (!scheduler) throw new TypeError('registerSelfBuildCron: scheduler must be provided');
  if (!deps) throw new TypeError('registerSelfBuildCron: deps must be provided');

  const selfBuildEnabled = process.env['SUDO_SELF_BUILD_MODE'] === '1';

  // -------------------------------------------------------------------
  // Job 1: 30-min tick — enabled only when SUDO_SELF_BUILD_MODE=1
  // -------------------------------------------------------------------
  const tickJob = scheduler.addJob({
    name: TICK_JOB_NAME,
    schedule: { kind: 'cron', expr: '*/30 * * * *', tz: 'UTC' },
    payload: { kind: 'agentTurn', message: SELF_BUILD_TICK_MSG },
    sessionTarget: 'isolated',
    enabled: selfBuildEnabled,
    consecutiveErrors: 0,
  } satisfies Omit<import('../cron/types.js').CronJob, 'id'>);

  log.info(
    { jobId: tickJob.id, enabled: selfBuildEnabled, expr: '*/30 * * * *' },
    `Registered cron job: ${TICK_JOB_NAME}`,
  );

  // -------------------------------------------------------------------
  // Job 2: daily report at 09:00 UTC — always enabled
  // -------------------------------------------------------------------
  const reportJob = scheduler.addJob({
    name: REPORT_JOB_NAME,
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    payload: { kind: 'agentTurn', message: SELF_BUILD_DAILY_REPORT_MSG },
    sessionTarget: 'isolated',
    enabled: true,
    consecutiveErrors: 0,
  } satisfies Omit<import('../cron/types.js').CronJob, 'id'>);

  log.info(
    { jobId: reportJob.id, enabled: true, expr: '0 9 * * *' },
    `Registered cron job: ${REPORT_JOB_NAME}`,
  );
}
