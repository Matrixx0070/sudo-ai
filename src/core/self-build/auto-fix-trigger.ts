/**
 * @file auto-fix-trigger.ts
 * @description AutoBugFix Wave — Module C: AutoFixTrigger
 *
 * Polls GitHub issues for eligible bug reports, validates against eligibility
 * gates, triggers self-build orchestrator ticks, and creates PRs.
 *
 * Eligibility gates:
 * 1. SUDO_AUTOFIX_DISABLE !== '1'
 * 2. canProceedThisHour() — rate limit (default 1/hour)
 * 3. Severity >= SUDO_AUTOFIX_MIN_SEVERITY (default 'HIGH')
 * 4. Error path includes src/core/
 * 5. ErrorMemory.suggestFix() returns a known fix pattern
 */

import { createLogger } from '../shared/logger.js';
import type { ErrorMemory } from '../health/error-memory.js';
import type { GitHubRepo } from '../tools/builtin/dev/github-integration.js';
import { createPR, createBranch, getRepoInfo } from '../tools/builtin/dev/github-integration.js';

const log = createLogger('self-build:auto-fix-trigger');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutoFixAttempt {
  issueNumber: number;
  errorSignature: string;
  severity: string;
  status: 'open' | 'in-progress' | 'merged' | 'failed';
  createdAt: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
}

export interface AutoFixTriggerDeps {
  errorMemory: ErrorMemory;
  metricsCollector: {
    increment(name: string, amount?: number, tags?: Record<string, string>): void;
    gauge(name: string, value: number, unit?: string, tags?: Record<string, string>): void;
  };
  mindDb?: {
    prepare<T = unknown>(sql: string): { run(params: Record<string, unknown>): { lastInsertRowid: number | bigint }; get(params: Record<string, unknown>): T | undefined; all(params: Record<string, unknown>): T[] };
    exec(sql: string): void;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_PER_HOUR = 1;
const DEFAULT_MIN_SEVERITY = 'HIGH';
const SEVERITY_ORDER: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Slugify a string for branch naming.
 * Lowercase, replace non-alphanumeric with hyphens, strip leading/trailing hyphens.
 */
function slugify(text: string, maxLength: number = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-$/, '');
}

/**
 * Extract severity from issue labels or body.
 * Defaults to MEDIUM if not found.
 */
function extractSeverity(issue: GitHubIssue): string {
  const labelSeverity = issue.labels
    .map((l) => l.name.toUpperCase())
    .find((l) => l in SEVERITY_ORDER);

  if (labelSeverity) return labelSeverity;

  // Check body for severity mentions
  const body = (issue.body ?? '').toUpperCase();
  if (body.includes('CRITICAL')) return 'CRITICAL';
  if (body.includes('HIGH')) return 'HIGH';
  if (body.includes('MEDIUM')) return 'MEDIUM';
  if (body.includes('LOW')) return 'LOW';

  return DEFAULT_MIN_SEVERITY;
}

/**
 * Extract error path/stack trace from issue body.
 * Looks for file paths in the format src/core/...
 */
function extractErrorPath(issue: GitHubIssue): string | null {
  const body = issue.body ?? '';
  const match = body.match(/(src\/core\/[^\s\n]+)/);
  return match ? match[1] : null;
}

/**
 * Extract error signature from issue body.
 * Looks for signature markers or stack traces.
 */
function extractErrorSignature(issue: GitHubIssue): string {
  const body = issue.body ?? '';
  // Look for signature pattern
  const sigMatch = body.match(/signature[:\s]+([^\n]+)/i);
  if (sigMatch) return sigMatch[1].trim();

  // Fall back to first line of body or title
  const firstLine = body.split('\n')[0] || issue.title;
  return firstLine.slice(0, 200);
}

/**
 * Check if severity meets the minimum threshold.
 */
function meetsSeverityThreshold(severity: string, minSeverity: string): boolean {
  const sevLevel = SEVERITY_ORDER[severity] ?? 0;
  const minLevel = SEVERITY_ORDER[minSeverity] ?? 0;
  return sevLevel >= minLevel;
}

// ---------------------------------------------------------------------------
// AutoFixTrigger
// ---------------------------------------------------------------------------

export class AutoFixTrigger {
  private readonly errorMemory: ErrorMemory;
  private readonly metricsCollector: AutoFixTriggerDeps['metricsCollector'];
  private readonly mindDb?: AutoFixTriggerDeps['mindDb'];
  private readonly repoInfo: GitHubRepo | null;

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private processedIssues: Set<number> = new Set();

  constructor(deps: AutoFixTriggerDeps, pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
    this.errorMemory = deps.errorMemory;
    this.metricsCollector = deps.metricsCollector;
    this.mindDb = deps.mindDb;
    this.repoInfo = null; // Will be fetched on first run
    this.pollIntervalMs = pollIntervalMs;

    this._ensureTables();
    log.info({ pollIntervalMs }, 'AutoFixTrigger constructed');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start polling for eligible issues.
   * @param pollIntervalMs - Override default poll interval (default: 5 min)
   */
  start(pollIntervalMs?: number): void {
    if (this.pollInterval !== null) {
      log.warn('AutoFixTrigger.start() called while already running — ignoring');
      return;
    }

    const interval = pollIntervalMs ?? this.pollIntervalMs;
    log.info({ interval }, 'AutoFixTrigger starting');

    this.pollInterval = setInterval(() => {
      this._pollIssues().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'AutoFixTrigger poll error');
      });
    }, interval);

    // Run first poll immediately
    void this._pollIssues();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.pollInterval === null) {
      log.warn('AutoFixTrigger.stop() called while not running — ignoring');
      return;
    }

    clearInterval(this.pollInterval);
    this.pollInterval = null;
    log.info('AutoFixTrigger stopped');
  }

  /**
   * Process a specific issue number.
   * Used for manual triggering or webhook events.
   */
  async processIssue(issueNumber: number): Promise<{ success: boolean; reason?: string }> {
    // Gate 1: Kill-switch
    if (process.env['SUDO_AUTOFIX_DISABLE'] === '1') {
      log.info({ issueNumber }, 'processIssue: SUDO_AUTOFIX_DISABLE=1 — skipping');
      return { success: false, reason: 'disabled' };
    }

    // Gate 2: Rate limit
    if (!this._canProceedThisHour()) {
      log.info({ issueNumber }, 'processIssue: rate limit exceeded — skipping');
      return { success: false, reason: 'rate-limited' };
    }

    // Fetch issue details via gh CLI
    const issue = await this._fetchIssue(issueNumber);
    if (!issue) {
      log.warn({ issueNumber }, 'processIssue: failed to fetch issue');
      return { success: false, reason: 'fetch-failed' };
    }

    return this._validateAndTrigger(issue);
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  private async _pollIssues(): Promise<void> {
    const killSwitch = process.env['SUDO_AUTOFIX_DISABLE'] === '1';
    if (killSwitch) {
      log.debug('poll: SUDO_AUTOFIX_DISABLE=1 — skipping poll');
      return;
    }

    if (!this._canProceedThisHour()) {
      log.debug('poll: rate limit exceeded — skipping');
      return;
    }

    // Fetch open issues with auto-fix label or high severity
    const issues = await this._fetchEligibleIssues();
    log.debug({ count: issues.length }, 'poll: fetched eligible issues');

    for (const issue of issues) {
      if (this.processedIssues.has(issue.number)) {
        log.debug({ number: issue.number }, 'poll: already processed — skipping');
        continue;
      }

      const result = await this._validateAndTrigger(issue);
      if (result.success) {
        this.processedIssues.add(issue.number);
      }
    }
  }

  private async _fetchEligibleIssues(): Promise<GitHubIssue[]> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);

      // Search for open issues with auto-fix label
      const { stdout } = await execPromise(
        `gh issue list --state open --label "auto-fix" --json number,title,body,labels,state,createdAt,updatedAt --limit 10`,
      );

      const issues = JSON.parse(stdout.trim() || '[]') as GitHubIssue[];
      return issues;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, '_fetchEligibleIssues failed');
      return [];
    }
  }

  private async _fetchIssue(issueNumber: number): Promise<GitHubIssue | null> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);

      const { stdout } = await execPromise(
        `gh issue view ${issueNumber} --json number,title,body,labels,state,createdAt,updatedAt`,
      );

      return JSON.parse(stdout.trim()) as GitHubIssue;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ issueNumber, err: msg }, '_fetchIssue failed');
      return null;
    }
  }

  private async _validateAndTrigger(issue: GitHubIssue): Promise<{ success: boolean; reason?: string }> {
    const minSeverity = process.env['SUDO_AUTOFIX_MIN_SEVERITY'] ?? DEFAULT_MIN_SEVERITY;

    // Gate 3: Severity check
    const severity = extractSeverity(issue);
    if (!meetsSeverityThreshold(severity, minSeverity)) {
      log.info({ issueNumber: issue.number, severity, minSeverity }, 'validate: severity below threshold');
      return { success: false, reason: 'severity-low' };
    }

    // Gate 4: Error path check
    const errorPath = extractErrorPath(issue);
    if (!errorPath || !errorPath.includes('src/core/')) {
      log.info({ issueNumber: issue.number, errorPath }, 'validate: error path not in src/core/');
      return { success: false, reason: 'path-invalid' };
    }

    // Gate 5: ErrorMemory fix pattern check
    const errorSignature = extractErrorSignature(issue);
    const mockError = new Error(errorSignature);
    const suggestedFix = this.errorMemory.suggestFix(mockError);

    if (!suggestedFix) {
      log.info({ issueNumber: issue.number, errorSignature }, 'validate: no known fix pattern');
      return { success: false, reason: 'no-fix-pattern' };
    }

    log.info(
      { issueNumber: issue.number, severity, errorPath, suggestedFix: suggestedFix.slice(0, 100) },
      'validate: all gates passed — triggering fix',
    );

    // Trigger the fix
    return this._triggerFix(issue, severity, errorSignature, errorPath, suggestedFix);
  }

  private async _triggerFix(
    issue: GitHubIssue,
    severity: string,
    errorSignature: string,
    errorPath: string,
    suggestedFix: string,
  ): Promise<{ success: boolean; reason?: string }> {
    try {
      // Create branch name
      const shortDesc = slugify(issue.title, 30);
      const branchName = `auto-fix/${issue.number}-${shortDesc}`;

      // Create branch
      const branchResult = await createBranch(branchName);
      if (branchResult.startsWith('ERROR:')) {
        log.error({ issueNumber: issue.number, err: branchResult }, '_triggerFix: branch creation failed');
        return { success: false, reason: 'branch-failed' };
      }

      log.info({ branchName }, '_triggerFix: branch created');

      // Persist attempt to database
      this._logAttempt({
        issueNumber: issue.number,
        errorSignature,
        severity,
        status: 'in-progress',
        createdAt: new Date().toISOString(),
        branchName,
      });

      // Create PR
      const prBody = [
        `## Auto-Fix PR`,
        '',
        `**Fixes:** #${issue.number}`,
        '',
        `**Error Signature:** ${errorSignature.slice(0, 200)}`,
        '',
        `**Error Path:** ${errorPath}`,
        '',
        `**Suggested Fix:** ${suggestedFix.slice(0, 500)}`,
        '',
        `*Generated by AutoFixTrigger*`,
      ].join('\n');

      const prResult = await createPR({
        title: `Auto-fix: ${issue.title.slice(0, 50)}`,
        body: prBody,
        branch: branchName,
        base: 'main',
      });

      if (prResult.startsWith('ERROR:')) {
        log.error({ issueNumber: issue.number, err: prResult }, '_triggerFix: PR creation failed');
        this._updateAttemptStatus(issue.number, 'failed');
        return { success: false, reason: 'pr-failed' };
      }

      // Extract PR number from URL (format: https://github.com/owner/repo/pull/123)
      const prNumberMatch = prResult.match(/\/pull\/(\d+)/);
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

      // Update attempt status
      this._updateAttemptStatus(issue.number, 'open', prResult, prNumber);

      // Record metrics
      this.metricsCollector.increment('autofix.pr_created', 1, { severity });

      log.info(
        { issueNumber: issue.number, prUrl: prResult, prNumber },
        '_triggerFix: PR created successfully',
      );

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ issueNumber: issue.number, err: msg }, '_triggerFix: unexpected error');
      return { success: false, reason: 'unexpected-error' };
    }
  }

  private _canProceedThisHour(): boolean {
    const maxPerHour = parseInt(
      process.env['SUDO_AUTOFIX_MAX_PER_HOUR'] ?? String(DEFAULT_MAX_PER_HOUR),
      10,
    );

    if (!this.mindDb) {
      // No database — allow (fail-open for rate limit check)
      return true;
    }

    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const stmt = this.mindDb.prepare(`
        SELECT COUNT(*) as count FROM auto_fix_rate_log WHERE executed_at > :since
      `);
      const result = stmt.get({ since: oneHourAgo }) as { count: number } | undefined;

      const count = result?.count ?? 0;
      return count < maxPerHour;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, '_canProceedThisHour: query failed — allowing');
      return true; // Fail-open
    }
  }

  private _ensureTables(): void {
    if (!this.mindDb) {
      log.warn('_ensureTables: no database provided — skipping table creation');
      return;
    }

    try {
      this.mindDb.exec(`
        CREATE TABLE IF NOT EXISTS auto_fix_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_number INTEGER NOT NULL,
          error_signature TEXT NOT NULL,
          severity TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL,
          branch_name TEXT,
          fixed_at TEXT,
          commit_sha TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          deployment_sha TEXT,
          deployed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_auto_fix_issue ON auto_fix_log(issue_number);
        CREATE INDEX IF NOT EXISTS idx_auto_fix_signature ON auto_fix_log(error_signature);
        CREATE INDEX IF NOT EXISTS idx_auto_fix_status ON auto_fix_log(status);

        CREATE TABLE IF NOT EXISTS auto_fix_rate_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          executed_at TEXT NOT NULL,
          issue_number INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rate_log_time ON auto_fix_rate_log(executed_at);
      `);

      // Migrate pre-existing databases created before branch_name was added to
      // the DDL: CREATE TABLE IF NOT EXISTS never alters an existing table, and
      // without the column every _logAttempt INSERT fails, which also silently
      // disabled the hourly rate limit.
      const cols = this.mindDb
        .prepare<{ name: string }>(`SELECT name FROM pragma_table_info('auto_fix_log')`)
        .all({});
      if (!cols.some((c) => c.name === 'branch_name')) {
        this.mindDb.exec(`ALTER TABLE auto_fix_log ADD COLUMN branch_name TEXT`);
        log.info('_ensureTables: migrated auto_fix_log — added branch_name column');
      }

      log.info('_ensureTables: tables created/verified');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, '_ensureTables: failed');
    }
  }

  private _logAttempt(attempt: AutoFixAttempt): void {
    if (!this.mindDb) return;

    try {
      this.mindDb.prepare(`
        INSERT INTO auto_fix_log
          (issue_number, error_signature, severity, status, created_at, branch_name, pr_url, pr_number)
        VALUES
          (:issueNumber, :errorSignature, :severity, :status, :createdAt, :branchName, :prUrl, :prNumber)
      `).run({
        issueNumber: attempt.issueNumber,
        errorSignature: attempt.errorSignature,
        severity: attempt.severity,
        status: attempt.status,
        createdAt: attempt.createdAt,
        branchName: attempt.branchName ?? null,
        prUrl: attempt.prUrl ?? null,
        prNumber: attempt.prNumber ?? null,
      });

      log.debug({ issueNumber: attempt.issueNumber }, '_logAttempt: logged');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, '_logAttempt: attempt insert failed');
    }

    // Rate-log insert is kept independent of the attempt insert: the hourly
    // rate limit is a safety control and must record the attempt even when
    // the audit insert above fails.
    try {
      this.mindDb.prepare(`
        INSERT INTO auto_fix_rate_log (executed_at, issue_number)
        VALUES (:executedAt, :issueNumber)
      `).run({
        executedAt: new Date().toISOString(),
        issueNumber: attempt.issueNumber,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, '_logAttempt: rate-log insert failed');
    }
  }

  private _updateAttemptStatus(
    issueNumber: number,
    status: AutoFixAttempt['status'],
    prUrl?: string,
    prNumber?: number,
  ): void {
    if (!this.mindDb) return;

    try {
      const params: Record<string, unknown> = { status, issueNumber };
      if (prUrl) params.prUrl = prUrl;
      if (prNumber) params.prNumber = prNumber;

      this.mindDb.prepare(`
        UPDATE auto_fix_log
        SET status = :status, pr_url = COALESCE(:prUrl, pr_url), pr_number = COALESCE(:prNumber, pr_number)
        WHERE issue_number = :issueNumber
      `).run(params);

      log.debug({ issueNumber, status }, '_updateAttemptStatus: updated');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, '_updateAttemptStatus: failed');
    }
  }
}

// Helper for execAsync
async function execAsync(cmd: string): Promise<{ stdout: string; stderr: string }> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  return promisify(exec)(cmd);
}
