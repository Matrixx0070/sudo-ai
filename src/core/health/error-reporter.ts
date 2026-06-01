/**
 * @file error-reporter.ts
 * @description ErrorReporter — captures, deduplicates, and reports errors to GitHub Issues.
 *
 * Subscribes to lifecycle hooks for error events, normalizes signatures via ErrorMemory,
 * deduplicates against existing issues, and creates/comments on GitHub issues.
 *
 * Kill-switch: SUDO_GITHUB_ISSUES_DISABLE === '1'
 */

import { createLogger } from '../shared/logger.js';
import { HookManager, HookContext } from '../hooks/index.js';
import { ErrorMemory } from './error-memory.js';
import { GitHubIssuesConnector } from '../channels/github-issues.js';
import { MetricsCollector } from './metrics.js';
import { ErrorSeverity, ErrorContext, CapturedError } from './error-reporter-types.js';
import {
  getCommitSha,
  getVersion,
  buildIssueBody,
  buildOccurrenceComment,
  buildIssueTitle,
} from './error-reporter-helpers.js';

const log = createLogger('health:error-reporter');

// ---------------------------------------------------------------------------
// ErrorReporter
// ---------------------------------------------------------------------------

export class ErrorReporter {
  private readonly errorMemory: ErrorMemory;
  private readonly hookManager: HookManager;
  private readonly github: GitHubIssuesConnector;
  private readonly metrics: MetricsCollector;
  private hookIds: string[] = [];
  private destroyed = false;

  constructor(
    errorMemory: ErrorMemory,
    hookManager: HookManager,
    github: GitHubIssuesConnector,
    metrics: MetricsCollector,
  ) {
    this.errorMemory = errorMemory;
    this.hookManager = hookManager;
    this.github = github;
    this.metrics = metrics;
  }

  /**
   * Initialize error reporter by subscribing to relevant hooks.
   */
  async initialize(): Promise<void> {
    if (process.env['SUDO_GITHUB_ISSUES_DISABLE'] === '1') {
      log.info('ErrorReporter disabled via SUDO_GITHUB_ISSUES_DISABLE');
      return;
    }

    // Subscribe to after:tool-call (on failure)
    const toolHookId = this.hookManager.register(
      'after:tool-call',
      async (ctx) => await this._handleToolCall(ctx),
      'ErrorReporter: capture tool call failures',
    );
    this.hookIds.push(toolHookId);

    // Subscribe to session:end (error summary)
    const sessionHookId = this.hookManager.register(
      'session:end',
      async (ctx) => await this._handleSessionEnd(ctx),
      'ErrorReporter: session error summary',
    );
    this.hookIds.push(sessionHookId);

    log.info({ hookCount: this.hookIds.length }, 'ErrorReporter initialized');
  }

  /**
   * Capture an error with severity classification and context.
   * Deduplicates via ErrorMemory + GitHub search, creates issue or adds comment.
   */
  async capture(
    error: Error,
    severity: ErrorSeverity,
    context: ErrorContext,
  ): Promise<void> {
    if (process.env['SUDO_GITHUB_ISSUES_DISABLE'] === '1') {
      return;
    }

    if (this.destroyed) {
      log.warn('ErrorReporter.capture called after destroy() — ignoring');
      return;
    }

    const signature = this.normalizeSignature(error);
    const timestamp = new Date().toISOString();

    log.debug({ signature, severity, context }, 'Capturing error');

    // Check deduplication in ErrorMemory
    const similar = this.errorMemory.findSimilar(error);
    if (similar) {
      log.debug({ existingId: similar.id }, 'Similar error found in memory');
    }

    // Search GitHub for existing open issue with same signature label
    const existingIssue = await this._findExistingIssue(signature);
    if (existingIssue) {
      await this._addOccurrenceComment(existingIssue.number, error, severity, context, timestamp);
      this.metrics.increment('error_reporter.deduplicated');
      return;
    }

    await this._createIssue(error, severity, context, signature, timestamp);
    this.metrics.increment('error_reporter.issues_created');
  }

  /**
   * Normalize error signature by removing volatile tokens.
   */
  normalizeSignature(error: Error): string {
    let msg = (error.message ?? String(error)).toLowerCase().trim();
    const volatilePatterns: RegExp[] = [
      /0x[0-9a-fA-F]+/g,
      /\b[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\b/gi,
      /\d{4}-\d{2}-\d{2}[Tt][\d:.zZ+-]+/g,
      /\b\d{10,}\b/g,
      /(?:\/[^/\s]+)+/g,
      /\bline\s+\d+\b/gi,
      /\bcol(?:umn)?\s+\d+\b/gi,
      /\b\d+\s*ms\b/gi,
      /\bport\s+\d+\b/gi,
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
      /\b\d+\b/g,
    ];
    for (const pattern of volatilePatterns) {
      msg = msg.replace(pattern, '_');
    }
    return msg.replace(/[_\s]+/g, '_').slice(0, 500);
  }

  /**
   * Classify error severity based on error type and context.
   */
  classifySeverity(error: Error, context: ErrorContext): ErrorSeverity {
    const msg = error.message.toLowerCase();

    if (msg.includes('crash') || msg.includes('unhandled') || msg.includes('fatal')) {
      return 'CRITICAL';
    }
    if (msg.includes('segmentation fault') || msg.includes('abort')) {
      return 'CRITICAL';
    }

    if (context.toolName || msg.includes('tool') || msg.includes('database')) {
      return 'HIGH';
    }
    if (msg.includes('corrupt') || msg.includes('unrecoverable')) {
      return 'HIGH';
    }

    if (context.healthCheck || msg.includes('degraded') || msg.includes('retry')) {
      return 'MEDIUM';
    }

    return 'LOW';
  }

  /**
   * Cleanup: unregister all hooks.
   */
  destroy(): void {
    if (this.destroyed) return;

    for (const hookId of this.hookIds) {
      this.hookManager.unregister(hookId);
    }
    this.hookIds = [];
    this.destroyed = true;

    log.info('ErrorReporter destroyed');
  }

  // -------------------------------------------------------------------------
  // Private handlers
  // -------------------------------------------------------------------------

  private async _handleToolCall(ctx: HookContext): Promise<void> {
    if (process.env['SUDO_GITHUB_ISSUES_DISABLE'] === '1') {
      return;
    }

    const result = ctx.result as { error?: Error | string; ok?: boolean } | undefined;
    if (!result?.error) return;

    const error = result.error instanceof Error
      ? result.error
      : new Error(String(result.error));

    const severity = this.classifySeverity(error, { toolName: ctx.toolName });
    const context: ErrorContext = {
      toolName: ctx.toolName,
      sessionId: ctx.sessionId,
      phase: 'tool-execution',
    };

    await this.capture(error, severity, context);
  }

  private async _handleSessionEnd(ctx: HookContext): Promise<void> {
    if (process.env['SUDO_GITHUB_ISSUES_DISABLE'] === '1') {
      return;
    }

    log.debug({ sessionId: ctx.sessionId }, 'Session ended');
  }

  private async _findExistingIssue(signature: string): Promise<{ number: number } | null> {
    try {
      const searchResult = await this.github.searchIssues({
        labels: ['auto-bug'],
        state: 'open',
      });

      if (!searchResult.success || !searchResult.issues) {
        return null;
      }

      for (const issue of searchResult.issues) {
        const issueSig = this.normalizeSignature(new Error(issue.title + ' ' + (issue.body ?? '')));
        if (issueSig === signature) {
          return { number: issue.number };
        }
      }

      return null;
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to search existing issues');
      return null;
    }
  }

  private async _addOccurrenceComment(
    issueNumber: number,
    error: Error,
    severity: ErrorSeverity,
    context: ErrorContext,
    timestamp: string,
  ): Promise<void> {
    const body = buildOccurrenceComment(error, severity, context, timestamp);
    const result = await this.github.addComment(issueNumber, body);
    if (result.success) {
      log.info({ issue: issueNumber }, 'Added occurrence comment');
    }
  }

  private async _createIssue(
    error: Error,
    severity: ErrorSeverity,
    context: ErrorContext,
    signature: string,
    timestamp: string,
  ): Promise<void> {
    const [commitSha, version] = await Promise.all([getCommitSha(), getVersion()]);
    const nodeVersion = process.version;
    const title = buildIssueTitle(error, severity);
    const body = buildIssueBody(error, severity, context, signature, timestamp, nodeVersion, commitSha, version);

    const result = await this.github.createIssue({
      title,
      body,
      labels: ['auto-bug', severity.toLowerCase()],
    });

    if (result.success && result.issue) {
      log.info({ issue: result.issue.number, title }, 'GitHub issue created');
      this.errorMemory.remember(error, 'code_bug', `GitHub issue #${result.issue.number} created`);
    } else {
      log.warn({ error: result.error }, 'Failed to create GitHub issue');
    }
  }
}

export type { ErrorSeverity, ErrorContext, CapturedError };
