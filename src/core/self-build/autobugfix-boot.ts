/**
 * @file autobugfix-boot.ts
 * @description F90 (docs/CORE_ROADMAP.md) — boot wiring for the tail of the
 * AutoBugFix chain (docs/autobugfix-spec.md). Modules A/B/E (error-reporter →
 * GitHub issues via the watchdog) have been live; Modules C (AutoFixTrigger)
 * and D (DeploymentHook) were built + tested but never constructed anywhere,
 * so the chain silently stopped after issue creation.
 *
 * Master opt-in: SUDO_AUTOBUGFIX=1 (default OFF — this creates branches, PRs
 * and deploys autonomously). The spec's per-module kill-switches still apply
 * underneath (SUDO_AUTOFIX_DISABLE, SUDO_AUTODEPLOY_DISABLE, rate limits).
 */

import { createLogger } from '../shared/logger.js';
import { ErrorMemory } from '../health/error-memory.js';
import { AutoFixTrigger } from './auto-fix-trigger.js';
import { DeploymentHook } from './deployment-hook.js';
import { GitHubIssuesConnector } from '../channels/github-issues.js';

const log = createLogger('self-build:autobugfix-boot');

const DEFAULT_DEPLOY_WATCH_MS = 300_000; // 5 min, matches trigger poll default

/** Minimal mind.db surface the auto-fix log queries need. */
export interface AutoBugFixDb {
  prepare<T = unknown>(sql: string): {
    run(params: Record<string, unknown>): { lastInsertRowid: number | bigint };
    get(params: Record<string, unknown>): T | undefined;
    all(params: Record<string, unknown>): T[];
  };
  exec(sql: string): void;
}

export interface AutoBugFixHandle {
  stop(): void;
}

interface OpenAttemptRow {
  issue_number: number;
  pr_number: number;
}

/**
 * Construct + start Modules C and D when SUDO_AUTOBUGFIX=1.
 * Returns null (fully dormant) otherwise. Never throws — this is boot code.
 */
export async function startAutoBugFix(
  opts: { mindDb?: AutoBugFixDb; deployWatchMs?: number } = {},
): Promise<AutoBugFixHandle | null> {
  if (process.env['SUDO_AUTOBUGFIX'] !== '1') {
    log.info('AutoBugFix C/D dormant — set SUDO_AUTOBUGFIX=1 to enable auto-fix PR creation + deploy watch');
    return null;
  }

  try {
    const errorMemory = new ErrorMemory();
    const metrics = {
      increment(name: string, amount?: number, tags?: Record<string, string>): void {
        log.debug({ metric: name, amount: amount ?? 1, tags }, 'autobugfix metric');
      },
      gauge(name: string, value: number, _unit?: string, tags?: Record<string, string>): void {
        log.debug({ metric: name, value, tags }, 'autobugfix gauge');
      },
      recordEvent(event: string, metadata?: Record<string, unknown>): void {
        log.debug({ event, metadata }, 'autobugfix event');
      },
    };

    const trigger = new AutoFixTrigger({
      errorMemory,
      metricsCollector: metrics,
      mindDb: opts.mindDb,
    });
    trigger.start();

    // Module D — watch auto-fix PRs recorded by Module C and deploy on merge.
    const githubIssues = new GitHubIssuesConnector();
    await githubIssues.initialize();
    const hook = new DeploymentHook(
      {
        addComment: async (issueNumber: number, body: string) => {
          const res = await githubIssues.addComment(issueNumber, body);
          return { success: res.success };
        },
      },
      metrics,
    );

    const checked = new Set<number>();
    const deployTimer = setInterval(() => {
      if (process.env['SUDO_AUTODEPLOY_DISABLE'] === '1') return;
      if (!opts.mindDb) return;
      try {
        const rows = opts.mindDb
          .prepare<OpenAttemptRow>(
            "SELECT issue_number, pr_number FROM auto_fix_log WHERE status = 'open' AND pr_number IS NOT NULL",
          )
          .all({});
        for (const row of rows) {
          if (checked.has(row.pr_number)) continue;
          checked.add(row.pr_number);
          hook.checkAndDeploy(row.pr_number, row.issue_number).catch((err: unknown) => {
            log.error({ pr: row.pr_number, err: String(err) }, 'deploy watch failed for PR');
          });
        }
      } catch (err) {
        log.error({ err: String(err) }, 'deploy watch query failed');
      }
    }, opts.deployWatchMs ?? DEFAULT_DEPLOY_WATCH_MS);
    deployTimer.unref?.();

    log.info('AutoBugFix C/D ACTIVE (SUDO_AUTOBUGFIX=1) — trigger polling + deploy watch running');
    return {
      stop(): void {
        trigger.stop();
        clearInterval(deployTimer);
      },
    };
  } catch (err) {
    log.error({ err: String(err) }, 'AutoBugFix C/D failed to start — continuing without');
    return null;
  }
}
