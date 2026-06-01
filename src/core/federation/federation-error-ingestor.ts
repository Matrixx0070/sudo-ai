/**
 * @file federation-error-ingestor.ts
 * @description FederationErrorIngestor — normalizes, deduplicates, and files GitHub issues for peer error reports.
 *
 * Kill-switch: SUDO_FED_ERROR_INGEST_DISABLE === '1'
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import {
  FederationErrorReport,
  FederationErrorIngestResult,
  FederationErrorQueryOptions,
  FederationErrorReportStored,
} from './federation-error-ingestor-types.js';

const log = createLogger('federation:error-ingestor');

const DB_INIT_SQL = `
  CREATE TABLE IF NOT EXISTS federation_error_reports (
    id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    error_signature TEXT NOT NULL,
    stack_trace TEXT,
    bot_version TEXT NOT NULL,
    severity TEXT NOT NULL,
    tool_name TEXT,
    session_id TEXT,
    phase TEXT,
    meta TEXT,
    github_issue_number INTEGER,
    deduplicated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fed_err_peer ON federation_error_reports(peer_id);
  CREATE INDEX IF NOT EXISTS idx_fed_err_sig ON federation_error_reports(error_signature);
`;

export interface FederationErrorIngestorDeps {
  errorReporter: {
    capture(error: Error, severity: string, context: Record<string, unknown>): Promise<void>;
    normalizeSignature(error: Error): string;
  };
  githubIssues: {
    isConfigured(): boolean;
    searchIssues(opts: { labels?: string[]; state?: string }): Promise<{ success: boolean; issues?: Array<{ number: number; title: string; labels: Array<{ name: string }>; body?: string }> }>;
    createIssue(opts: { title: string; body: string; labels?: string[] }): Promise<{ success: boolean; number?: number }>;
    addComment(issueNumber: number, body: string): Promise<{ success: boolean }>;
  };
  db: {
    prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown | undefined; all(...args: unknown[]): unknown[] };
    exec(sql: string): void;
  };
}

export class FederationErrorIngestor {
  private readonly deps: FederationErrorIngestorDeps;
  private destroyed = false;

  constructor(deps: FederationErrorIngestorDeps) {
    this.deps = deps;
    this._initDb();
  }

  private _initDb(): void {
    try {
      this.deps.db.exec(DB_INIT_SQL);
      log.debug('Database tables initialized');
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to initialize database tables');
    }
  }

  /**
   * Main entry: normalize, dedup, file GitHub issue
   */
  async ingestReport(report: FederationErrorReport): Promise<FederationErrorIngestResult> {
    if (process.env['SUDO_FED_ERROR_INGEST_DISABLE'] === '1') {
      log.debug('FederationErrorIngestor disabled via env var');
      return { reportId: crypto.randomUUID(), deduplicated: false };
    }

    if (this.destroyed) {
      log.warn('ingestReport called after destroy() — ignoring');
      return { reportId: crypto.randomUUID(), deduplicated: false };
    }

    const reportId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Check for deduplication within 24h from same peer
    const existingReport = this._findExistingReport(report.peerId, report.errorSignature);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    if (existingReport && existingReport.created_at > twentyFourHoursAgo) {
      // Same peer, same signature within 24h → deduplicate without GitHub call
      log.debug({ peerId: report.peerId, signature: report.errorSignature }, 'Deduplicating report (same peer, 24h window)');
      return {
        reportId,
        githubIssueNumber: existingReport.github_issue_number ?? undefined,
        deduplicated: true,
      };
    }

    // Store the report
    this._storeReport(reportId, report, now);

    // Check GitHub for existing issue with same signature
    let githubIssueNumber: number | undefined;
    let deduplicated = false;

    if (this.deps.githubIssues.isConfigured()) {
      try {
        const existingIssue = await this._findExistingIssue(report.errorSignature);

        if (existingIssue) {
          // Add comment with peer attribution
          const commentBody = this._buildCommentBody(report, reportId);
          const commentResult = await this.deps.githubIssues.addComment(existingIssue.number, commentBody);

          if (commentResult.success) {
            githubIssueNumber = existingIssue.number;
            deduplicated = true;
            this._updateReportGithubIssue(reportId, existingIssue.number);
            log.info({ issueNumber: existingIssue.number, peerId: report.peerId }, 'Added comment to existing issue');
          }
        } else {
          // Create new issue
          const createResult = await this.deps.githubIssues.createIssue({
            title: `[federation] ${report.errorSignature.slice(0, 80)}`,
            body: this._buildIssueBody(report, reportId),
            labels: ['auto-bug', 'federation', report.severity.toLowerCase()],
          });

          if (createResult.success && createResult.number) {
            githubIssueNumber = createResult.number;
            this._updateReportGithubIssue(reportId, createResult.number);
            log.info({ issueNumber: createResult.number, peerId: report.peerId }, 'GitHub issue created');
          }
        }
      } catch (err) {
        log.warn({ err: String(err) }, 'GitHub operation failed — fail-open, report stored');
      }
    } else {
      log.debug('GitHub not configured — storing report only');
    }

    return {
      reportId,
      githubIssueNumber,
      deduplicated,
    };
  }

  /**
   * Query stored reports
   */
  queryReports(opts: FederationErrorQueryOptions = {}): FederationErrorReportStored[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.peerId) {
      conditions.push('peer_id = ?');
      params.push(opts.peerId);
    }

    if (opts.signature) {
      conditions.push('error_signature = ?');
      params.push(opts.signature);
    }

    const limit = opts.limit ?? 100;
    conditions.push('1=1');

    const whereClause = conditions.join(' AND ');
    const sql = `
      SELECT * FROM federation_error_reports
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(limit);

    try {
      const rows = this.deps.db.prepare(sql).all(...params) as Array<{
        id: string;
        peer_id: string;
        error_signature: string;
        stack_trace: string | null;
        bot_version: string;
        severity: string;
        tool_name: string | null;
        session_id: string | null;
        phase: string | null;
        meta: string | null;
        github_issue_number: number | null;
        deduplicated: number;
        created_at: string;
        updated_at: string;
        resolved_at: string | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        peerId: row.peer_id,
        errorSignature: row.error_signature,
        stackTrace: row.stack_trace ?? undefined,
        botVersion: row.bot_version,
        severity: row.severity as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
        toolName: row.tool_name ?? undefined,
        sessionId: row.session_id ?? undefined,
        phase: row.phase ?? undefined,
        meta: row.meta ? JSON.parse(row.meta) : undefined,
        githubIssueNumber: row.github_issue_number ?? undefined,
        deduplicated: row.deduplicated === 1,
      }));
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to query reports');
      return [];
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    log.info('FederationErrorIngestor destroyed');
  }

  // -------------------------------------------------------------------------
  // Private methods
  // -------------------------------------------------------------------------

  private _findExistingReport(peerId: string, signature: string): {
    id: string;
    github_issue_number: number | null;
    created_at: string;
  } | undefined {
    try {
      const row = this.deps.db.prepare(`
        SELECT id, github_issue_number, created_at
        FROM federation_error_reports
        WHERE peer_id = ? AND error_signature = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(peerId, signature) as { id: string; github_issue_number: number | null; created_at: string } | undefined;

      return row;
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to find existing report');
      return undefined;
    }
  }

  private _storeReport(reportId: string, report: FederationErrorReport, now: string): void {
    try {
      this.deps.db.prepare(`
        INSERT INTO federation_error_reports (
          id, peer_id, error_signature, stack_trace, bot_version,
          severity, tool_name, session_id, phase, meta,
          deduplicated, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        reportId,
        report.peerId,
        report.errorSignature,
        report.stackTrace ?? null,
        report.botVersion,
        report.severity,
        report.toolName ?? null,
        report.sessionId ?? null,
        report.phase ?? null,
        report.meta ? JSON.stringify(report.meta) : null,
        now,
        now,
      );
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to store report');
    }
  }

  private _updateReportGithubIssue(reportId: string, issueNumber: number): void {
    try {
      this.deps.db.prepare(`
        UPDATE federation_error_reports
        SET github_issue_number = ?, updated_at = ?
        WHERE id = ?
      `).run(issueNumber, new Date().toISOString(), reportId);
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to update report with GitHub issue number');
    }
  }

  private async _findExistingIssue(signature: string): Promise<{ number: number; title: string; body?: string } | null> {
    try {
      const searchResult = await this.deps.githubIssues.searchIssues({
        labels: ['auto-bug', 'federation'],
        state: 'open',
      });

      if (!searchResult.success || !searchResult.issues) {
        return null;
      }

      for (const issue of searchResult.issues) {
        const issueTitle = issue.title.toLowerCase();
        const issueBody = issue.body?.toLowerCase() ?? '';
        const searchStr = `${issueTitle} ${issueBody}`;

        if (searchStr.includes(signature.toLowerCase())) {
          return { number: issue.number, title: issue.title, body: issue.body };
        }
      }

      return null;
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to search existing issues');
      return null;
    }
  }

  private _buildIssueBody(report: FederationErrorReport, reportId: string): string {
    const lines: string[] = [
      '## Federation Error Report',
      '',
      `**Peer ID:** ${report.peerId}`,
      `**Severity:** ${report.severity}`,
      `**Bot Version:** ${report.botVersion}`,
      `**Error Signature:** \`${report.errorSignature}\``,
      '',
    ];

    if (report.toolName) {
      lines.push(`**Tool:** ${report.toolName}`);
    }
    if (report.sessionId) {
      lines.push(`**Session ID:** ${report.sessionId}`);
    }
    if (report.phase) {
      lines.push(`**Phase:** ${report.phase}`);
    }

    lines.push('', '## Stack Trace', '```', report.stackTrace ?? 'No stack trace provided', '```', '');

    if (report.meta && Object.keys(report.meta).length > 0) {
      lines.push('## Metadata', '```json', JSON.stringify(report.meta, null, 2), '```', '');
    }

    lines.push('---', `*Report ID: ${reportId}*`, '*Auto-filed by FederationErrorIngestor*');

    return lines.join('\n');
  }

  private _buildCommentBody(report: FederationErrorReport, reportId: string): string {
    const lines: string[] = [
      '## Additional Occurrence',
      '',
      `**Peer ID:** ${report.peerId}`,
      `**Severity:** ${report.severity}`,
      `**Bot Version:** ${report.botVersion}`,
      '',
    ];

    if (report.toolName) {
      lines.push(`**Tool:** ${report.toolName}`);
    }
    if (report.sessionId) {
      lines.push(`**Session ID:** ${report.sessionId}`);
    }

    lines.push('', `*Report ID: ${reportId}*`);

    return lines.join('\n');
  }
}
