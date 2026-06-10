/**
 * @file cognition/commitment-auditor.ts
 * @description CommitmentAuditor — scans the audit_log for commitment rows that
 * are nearing or past their TTL, emitting structured log warnings/errors and
 * returning a report. Pure module; no REST wiring (deferred).
 *
 * Commitments are stored by AuditTrail.recordTriple() as rows with
 * action='commitment', metadata_json containing {mistake, learned, commitment, ttl_days}.
 * The timestamp column is ISO-8601 and serves as created_at.
 */

import type { Database, Statement } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:commitment-auditor');

const DEFAULT_WINDOW_DAYS = 3;
const MS_PER_DAY = 86_400_000;
const LOG_TRUNCATE_LEN = 120;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommitmentRow {
  id: string;
  commitment: string;
  learned: string;
  createdAt: number;       // ms since epoch
  ttlDays: number;
  expiresAt: number;       // ms since epoch
  daysUntilExpiry: number; // negative when already expired
}

export interface CommitmentAuditReport {
  checkedAt: string;       // ISO-8601
  windowDays: number;
  total: number;
  expiringSoon: CommitmentRow[];
  alreadyExpired: CommitmentRow[];
}

// ---------------------------------------------------------------------------
// Internal raw DB row shape
// ---------------------------------------------------------------------------

interface RawCommitmentRow {
  id: string;
  timestamp: string;
  metadata_json: string | null;
}

interface CommitmentMeta {
  commitment?: unknown;
  learned?: unknown;
  ttl_days?: unknown;
}

// ---------------------------------------------------------------------------
// CommitmentAuditor
// ---------------------------------------------------------------------------

export class CommitmentAuditor {
  // Cached prepared statement — re-used across all method calls.
  private readonly _stmtFetch: Statement<[], RawCommitmentRow>;

  constructor(private readonly db: Database) {
    this._stmtFetch = this.db.prepare<[], RawCommitmentRow>(
      `SELECT id, timestamp, metadata_json
       FROM audit_log
       WHERE action = 'commitment'
         AND metadata_json IS NOT NULL`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch all commitment rows from the DB and parse them into CommitmentRow
   * objects. Rows without valid `commitment`, `learned`, or numeric `ttl_days`
   * are silently excluded — they cannot have a meaningful TTL.
   */
  private _fetchAll(): CommitmentRow[] {
    const raw = this._stmtFetch.all();
    const result: CommitmentRow[] = [];

    for (const row of raw) {
      let meta: CommitmentMeta;
      try {
        meta = JSON.parse(row.metadata_json ?? '{}') as CommitmentMeta;
      } catch {
        log.warn({ id: row.id }, 'commitment-auditor: failed to parse metadata_json, skipping row');
        continue;
      }

      if (
        typeof meta.commitment !== 'string' ||
        typeof meta.learned !== 'string' ||
        typeof meta.ttl_days !== 'number' ||
        !Number.isFinite(meta.ttl_days)
      ) {
        // Row lacks required commitment fields — excluded per spec.
        continue;
      }

      const createdAt = Date.parse(row.timestamp);
      if (!Number.isFinite(createdAt)) {
        log.warn({ id: row.id, timestamp: row.timestamp }, 'commitment-auditor: unparseable timestamp, skipping row');
        continue;
      }

      const ttlDays = meta.ttl_days;
      const expiresAt = createdAt + ttlDays * MS_PER_DAY;
      const now = Date.now();
      const daysUntilExpiry = (expiresAt - now) / MS_PER_DAY;

      result.push({
        id: row.id,
        commitment: meta.commitment,
        learned: meta.learned,
        createdAt,
        ttlDays,
        expiresAt,
        daysUntilExpiry,
      });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Return commitment rows whose TTL expires within the next `windowDays` days
   * (i.e. not yet expired, but expiring soon).
   *
   * @param windowDays - Look-ahead window in days. Must be a positive finite number.
   */
  getExpiringCommitments(windowDays: number): CommitmentRow[] {
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      throw new RangeError(`commitment-auditor: windowDays must be a positive number, got ${windowDays}`);
    }

    const now = Date.now();
    const windowEnd = now + windowDays * MS_PER_DAY;

    return this._fetchAll().filter(
      row => row.expiresAt >= now && row.expiresAt <= windowEnd,
    );
  }

  /**
   * Return commitment rows whose TTL has already elapsed.
   */
  getExpiredCommitments(): CommitmentRow[] {
    const now = Date.now();
    return this._fetchAll().filter(row => row.expiresAt < now);
  }

  /**
   * Collect expiring and expired commitments, emit structured log entries,
   * and return a summary report. Fails open: if the DB query throws, logs
   * the error and returns a zero-count report.
   *
   * @param windowDays - Warning window in days (default 3).
   */
  checkAndWarn(windowDays: number = DEFAULT_WINDOW_DAYS): CommitmentAuditReport {
    const checkedAt = new Date().toISOString();

    let expiringSoon: CommitmentRow[] = [];
    let alreadyExpired: CommitmentRow[] = [];

    try {
      expiringSoon = this.getExpiringCommitments(windowDays);
      alreadyExpired = this.getExpiredCommitments();
    } catch (err: unknown) {
      log.error(
        { err, event: 'commitment.audit.error' },
        'commitment-auditor: DB query failed; returning empty report (fail-open)',
      );
      return {
        checkedAt,
        windowDays,
        total: 0,
        expiringSoon: [],
        alreadyExpired: [],
      };
    }

    for (const row of expiringSoon) {
      log.warn({
        event: 'commitment.expiry',
        id: row.id,
        commitment: row.commitment.slice(0, LOG_TRUNCATE_LEN),
        daysUntilExpiry: row.daysUntilExpiry,
      }, 'Commitment expiring soon');
    }

    for (const row of alreadyExpired) {
      log.error({
        event: 'commitment.expired',
        id: row.id,
        commitment: row.commitment.slice(0, LOG_TRUNCATE_LEN),
        expiresAt: new Date(row.expiresAt).toISOString(),
      }, 'Commitment has expired');
    }

    return {
      checkedAt,
      windowDays,
      total: expiringSoon.length + alreadyExpired.length,
      expiringSoon,
      alreadyExpired,
    };
  }
}
