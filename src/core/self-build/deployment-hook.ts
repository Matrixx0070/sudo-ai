/**
 * @file self-build/deployment-hook.ts
 * @description Auto-deploy monitor: polls GitHub PRs, runs CI on merge, deploys or rolls back.
 *
 * Kill-switch: SUDO_AUTODEPLOY_DISABLE=1
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';

interface ExecFileResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const execFileAsync = promisify(execFileCb) as unknown as (
  command: string,
  args: readonly string[],
  options: { cwd: string; encoding: 'utf8'; maxBuffer: number },
) => Promise<ExecFileResult>;

const log = createLogger('self-build:deployment');

const GITHUB_API = 'https://api.github.com';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubPRStatus {
  number: number;
  merged: boolean;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
}

export interface CIResult {
  passed: boolean;
  output: string;
}

export interface DeployResult {
  success: boolean;
  action: 'deployed' | 'rolled-back' | 'skipped' | 'failed';
  output?: string;
}

// ---------------------------------------------------------------------------
// Dependencies interface (subset needed from connectors)
// ---------------------------------------------------------------------------

export interface GitHubIssuesConnector {
  addComment(issueNumber: number, body: string): Promise<{ success: boolean }>;
}

export interface MetricsCollector {
  recordEvent(event: string, metadata?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// DeploymentHook class
// ---------------------------------------------------------------------------

export class DeploymentHook {
  private readonly githubIssues: GitHubIssuesConnector;
  private readonly metrics: MetricsCollector;
  private readonly timers: Map<number, NodeJS.Timeout> = new Map();

  constructor(
    githubIssues: GitHubIssuesConnector,
    metrics: MetricsCollector,
  ) {
    this.githubIssues = githubIssues;
    this.metrics = metrics;
  }

  /**
   * Start polling a PR for merge status.
   * @param prNumber - GitHub PR number
   * @param issueNumber - Linked issue number for comments
   */
  monitorPR(prNumber: number, issueNumber: number): void {
    if (process.env['SUDO_AUTODEPLOY_DISABLE'] === '1') {
      log.warn({ prNumber }, 'monitorPR: autodeploy disabled — skipping');
      return;
    }

    if (this.timers.has(prNumber)) {
      log.warn({ prNumber }, 'monitorPR: already monitoring this PR');
      return;
    }

    log.info({ prNumber, issueNumber }, 'monitorPR: started');

    const intervalId = setInterval(() => {
      void this.checkAndDeploy(prNumber, issueNumber);
    }, 30_000);

    this.timers.set(prNumber, intervalId);
  }

  /**
   * Stop monitoring a PR.
   * @param prNumber - GitHub PR number
   */
  stopMonitoring(prNumber: number): void {
    const intervalId = this.timers.get(prNumber);
    if (intervalId) {
      clearInterval(intervalId);
      this.timers.delete(prNumber);
      log.info({ prNumber }, 'stopMonitoring: stopped');
    }
  }

  /**
   * Check PR status and deploy if merged.
   * @param prNumber - GitHub PR number
   * @param issueNumber - Linked issue number for comments
   */
  async checkAndDeploy(prNumber: number, issueNumber: number): Promise<void> {
    if (process.env['SUDO_AUTODEPLOY_DISABLE'] === '1') {
      log.warn({ prNumber }, 'checkAndDeploy: autodeploy disabled — skipping');
      return;
    }

    try {
      const prStatus = await this.getPRStatus(prNumber);
      log.info({ prNumber, state: prStatus.state, merged: prStatus.merged }, 'PR status fetched');

      if (prStatus.state !== 'merged') {
        return; // Not merged yet, continue polling
      }

      log.info({ prNumber }, 'PR merged — running CI');
      this.metrics.recordEvent('pr_merged', { prNumber, sha: prStatus.headSha });

      const ciResult = await this.runCI();
      if (!ciResult.passed) {
        log.warn({ prNumber, output: ciResult.output.slice(0, 300) }, 'CI failed — rolling back');
        await this.rollback(prStatus.headSha);
        await this.addDeploymentComment(issueNumber, {
          success: false,
          action: 'rolled-back',
          output: `CI failed:\n\`\`\`\n${ciResult.output.slice(0, 1000)}\n\`\`\``,
        });
        this.metrics.recordEvent('ci_failed', { prNumber });
        return;
      }

      log.info({ prNumber }, 'CI passed — deploying');
      const deployResult = await this.deploy();

      if (deployResult.success) {
        await this.addDeploymentComment(issueNumber, {
          success: true,
          action: 'deployed',
          output: deployResult.output,
        });
        this.metrics.recordEvent('deployed', { prNumber, sha: prStatus.headSha });
      } else {
        await this.addDeploymentComment(issueNumber, {
          success: false,
          action: deployResult.action,
          output: deployResult.output,
        });
        this.metrics.recordEvent('deploy_failed', { prNumber, action: deployResult.action });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ prNumber, err: msg }, 'checkAndDeploy failed');
      this.metrics.recordEvent('deploy_error', { prNumber, error: msg });
    }
  }

  /**
   * Fetch PR status from GitHub API.
   */
  private async getPRStatus(prNumber: number): Promise<GitHubPRStatus> {
    const token = await this.resolveToken();
    if (!token) {
      throw new Error('GitHub token not configured');
    }

    const repo = process.env['GITHUB_REPO'] ?? 'Matrixx0070/sudo-ai';
    const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sudo-ai-v5',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const merged = Boolean(data['merged']);
    const state = merged ? 'merged' : (data['state'] as 'open' | 'closed');
    const head = data['head'] as Record<string, unknown> | undefined;
    const headSha = (head?.['sha'] as string) ?? '';

    return {
      number: prNumber,
      merged,
      state,
      headSha,
    };
  }

  /**
   * Run CI: pnpm lint && pnpm test.
   */
  async runCI(): Promise<CIResult> {
    try {
      const cwd = '/root/sudo-ai-v4';

      const lintResult = await execFileAsync('pnpm', ['lint'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      if (lintResult.code !== 0) {
        return { passed: false, output: lintResult.stderr || lintResult.stdout };
      }

      const testResult = await execFileAsync('pnpm', ['test'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const passed = testResult.code === 0;
      return {
        passed,
        output: testResult.stdout || testResult.stderr,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: false, output: msg };
    }
  }

  /**
   * Deploy: pm2 reload sudo-ai-v5 --update-env.
   */
  async deploy(): Promise<DeployResult> {
    try {
      const cwd = '/root/sudo-ai-v4';

      const result = await execFileAsync('pm2', ['reload', 'sudo-ai-v5', '--update-env'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      if (result.code === 0) {
        return {
          success: true,
          action: 'deployed',
          output: result.stdout,
        };
      }

      return {
        success: false,
        action: 'failed',
        output: result.stderr || result.stdout,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, action: 'failed', output: msg };
    }
  }

  /**
   * Rollback: git reset --hard to previous commit.
   */
  async rollback(previousCommitSha: string): Promise<void> {
    try {
      const cwd = '/root/sudo-ai-v4';

      log.info({ sha: previousCommitSha }, 'rollback: executing');

      await execFileAsync('git', ['reset', '--hard', previousCommitSha], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      this.metrics.recordEvent('rolled_back', { sha: previousCommitSha });
      log.info({ sha: previousCommitSha }, 'rollback: completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sha: previousCommitSha, err: msg }, 'rollback failed');
      throw err;
    }
  }

  /**
   * Add deployment comment to GitHub issue.
   */
  async addDeploymentComment(
    issueNumber: number,
    result: { success: boolean; action: string; output?: string },
  ): Promise<void> {
    try {
      const body = [
        `### Auto-Deploy ${result.success ? 'SUCCESS' : 'FAILED'}`,
        `- Action: ${result.action}`,
        result.output ? `\n\`\`\`\n${result.output.slice(0, 2000)}\n\`\`\`` : '',
      ].join('\n');

      await this.githubIssues.addComment(issueNumber, body);
      log.info({ issueNumber, success: result.success }, 'Deployment comment added');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ issueNumber, err: msg }, 'addDeploymentComment failed');
    }
  }

  /**
   * Resolve GitHub token from env var.
   */
  private async resolveToken(): Promise<string | null> {
    return process.env['GITHUB_TOKEN'] ?? null;
  }

  /**
   * Cleanup: stop all active monitors.
   */
  cleanup(): void {
    for (const [prNumber, intervalId] of this.timers.entries()) {
      clearInterval(intervalId);
      log.info({ prNumber }, 'cleanup: stopped monitor');
    }
    this.timers.clear();
  }
}
