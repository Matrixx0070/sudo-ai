/**
 * @file cognition/reanchor-monitor.ts
 * @description ReAnchorMonitor — pure read-only scanner over `audit_chain` that
 * identifies identity re-anchor events by textual markers in the `learned` and
 * `mistake` columns. Surfaces aggregated stats and recent event details.
 *
 * Pure module — no REST wiring. A later change will add explicit re-anchor logging to
 * the identity loader; this module surfaces historical occurrences via text
 * pattern matching until then.
 *
 * Storage: reads `audit_chain` table (same table used by CrossSignalDiagnostics).
 * Schema relevant columns: id TEXT, learned TEXT, mistake TEXT, ts INTEGER (epoch ms).
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:reanchor-monitor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MIN_LIMIT = 1;
const MS_PER_DAY = 86_400_000;
const SNIPPET_LEN = 120;

// ---------------------------------------------------------------------------
// Duck-typed database interface (mirrors pattern from mistake-pattern-recognizer)
// ---------------------------------------------------------------------------

interface StatementLike<TResult> {
  all(...params: unknown[]): TResult[];
}

export interface DatabaseLike {
  prepare<TResult = unknown>(sql: string): StatementLike<TResult>;
  /** Executes one or more SQL statements. Optional to keep mocks that only implement prepare. */
  exec?(sql: string): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReAnchorEvent {
  id: string;       // audit_chain row id
  ts: number;       // epoch ms
  trigger: string;  // matched marker category: 'explicit'|'post-dispatch'|'post-veto'|'post-discordance'|'unknown'
  snippet: string;  // <=120 chars redacted context
}

export interface ReAnchorStats {
  total: number;
  byTrigger: Record<string, number>;
  windowDays: number;
  computedAt: string;
  lastReAnchorAt?: number;
}

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface RawAnchorRow {
  id: string;
  ts: number;
  learned: string | null;
  mistake: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify a re-anchor event's trigger type from its row content.
 *
 * Priority order (first match wins, most-specific first):
 *   0. 'startup'          — contains "startup" (system boot re-anchor)
 *   1. 'explicit'         — contains "explicit re-anchor" or "manual re-anchor"
 *   2. 'post-veto'        — contains "veto"
 *   3. 'post-discordance' — contains "discordance"
 *   4. 'post-dispatch'    — contains "dispatch"
 *   5. 'unknown'          — no known marker
 */
function classifyTrigger(row: RawAnchorRow): string {
  const combined = `${row.learned ?? ''} ${row.mistake ?? ''}`.toLowerCase();

  if (combined.includes('startup')) {
    return 'startup';
  }
  if (combined.includes('explicit re-anchor') || combined.includes('manual re-anchor')) {
    return 'explicit';
  }
  if (combined.includes('veto')) {
    return 'post-veto';
  }
  if (combined.includes('discordance')) {
    return 'post-discordance';
  }
  if (combined.includes('dispatch')) {
    return 'post-dispatch';
  }
  return 'unknown';
}

/**
 * Build the snippet from the most relevant field.
 * Prefer `learned` when it contains an anchor marker; fall back to `mistake`.
 * Takes the LAST 120 chars, strips newlines, and redacts numeric sequences >=8 digits.
 */
function buildSnippet(row: RawAnchorRow): string {
  const learnedLower = (row.learned ?? '').toLowerCase();
  const hasAnchorInLearned =
    learnedLower.includes('re-anchor') ||
    learnedLower.includes('reanchor') ||
    learnedLower.includes('identity-anchor');

  const raw = hasAnchorInLearned
    ? (row.learned ?? '')
    : (row.mistake ?? row.learned ?? '');

  const tail = raw.slice(-SNIPPET_LEN);
  const stripped = tail.replace(/[\n\r]/g, ' ');
  return stripped.replace(/\d{8,}/g, '[REDACTED]');
}

/**
 * Build empty stats (used as fail-open result and for empty DB).
 */
function emptyStats(windowDays: number): ReAnchorStats {
  return {
    total: 0,
    byTrigger: {},
    windowDays,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// SQL — WHERE clause shared between both statements
// ---------------------------------------------------------------------------

const WHERE_ANCHOR =
  `(LOWER(learned) LIKE '%re-anchor%'
    OR LOWER(learned) LIKE '%reanchor%'
    OR LOWER(learned) LIKE '%identity-anchor%'
    OR LOWER(mistake) LIKE '%identity drift%')`;

// ---------------------------------------------------------------------------
// ReAnchorMonitor
// ---------------------------------------------------------------------------

export class ReAnchorMonitor {
  /** Fetch all matching rows in the window (no LIMIT) — used by getStats. */
  private readonly _stmtList: StatementLike<RawAnchorRow>;

  /** Fetch matching rows ordered DESC with LIMIT — used by getRecent. */
  private readonly _stmtListRecent: StatementLike<RawAnchorRow>;

  constructor(private readonly db: DatabaseLike) {
    // Lazy schema seed — creates audit_chain if it does not yet exist.
    // Uses IF NOT EXISTS so this is safe to call on every startup.
    if (this.db.exec) {
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS audit_chain (
            id         TEXT NOT NULL PRIMARY KEY,
            ts         INTEGER NOT NULL,
            learned    TEXT,
            mistake    TEXT,
            commitment TEXT,
            ttl_days   REAL
          );
          CREATE INDEX IF NOT EXISTS idx_audit_chain_ts ON audit_chain(ts);
        `);
      } catch (err: unknown) {
        log.warn({ err }, 'reanchor-monitor: audit_chain schema seed failed (non-fatal)');
      }
    }

    this._stmtList = this.db.prepare<RawAnchorRow>(
      `SELECT id, ts, learned, mistake
       FROM audit_chain
       WHERE ts >= ?
         AND ${WHERE_ANCHOR}`,
    );

    this._stmtListRecent = this.db.prepare<RawAnchorRow>(
      `SELECT id, ts, learned, mistake
       FROM audit_chain
       WHERE ts >= ?
         AND ${WHERE_ANCHOR}
       ORDER BY ts DESC
       LIMIT ?`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Return aggregate statistics for re-anchor events within the rolling window.
   * Fails open: DB throw → empty stats object.
   *
   * @param opts.windowDays - Rolling window in days (default 30).
   */
  getStats(opts?: { windowDays?: number }): ReAnchorStats {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const cutoffMs = Date.now() - windowDays * MS_PER_DAY;
    const computedAt = new Date().toISOString();

    let rows: RawAnchorRow[];
    try {
      rows = this._stmtList.all(cutoffMs);
    } catch (err: unknown) {
      log.error(
        { err, event: 'reanchor.stats.error' },
        'reanchor-monitor: DB query failed; returning empty stats (fail-open)',
      );
      return { ...emptyStats(windowDays), computedAt };
    }

    const byTrigger: Record<string, number> = {};
    let lastReAnchorAt: number | undefined;

    for (const row of rows) {
      const trigger = classifyTrigger(row);
      byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;
      if (lastReAnchorAt === undefined || row.ts > lastReAnchorAt) {
        lastReAnchorAt = row.ts;
      }
    }

    log.debug(
      { event: 'reanchor.stats.done', total: rows.length, windowDays },
      'reanchor-monitor: stats computed',
    );

    const result: ReAnchorStats = {
      total: rows.length,
      byTrigger,
      windowDays,
      computedAt,
    };
    if (lastReAnchorAt !== undefined) {
      result.lastReAnchorAt = lastReAnchorAt;
    }
    return result;
  }

  /**
   * Return recent re-anchor events within the rolling window, ordered newest first.
   * Fails open: DB throw → empty array.
   *
   * @param opts.windowDays - Rolling window in days (default 30).
   * @param opts.limit      - Maximum rows to return; clamped to [1, 500] (default 50).
   */
  getRecent(opts?: { windowDays?: number; limit?: number }): ReAnchorEvent[] {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const rawLimit = opts?.limit ?? DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, rawLimit));
    const cutoffMs = Date.now() - windowDays * MS_PER_DAY;

    let rows: RawAnchorRow[];
    try {
      rows = this._stmtListRecent.all(cutoffMs, limit);
    } catch (err: unknown) {
      log.error(
        { err, event: 'reanchor.recent.error' },
        'reanchor-monitor: DB query failed; returning [] (fail-open)',
      );
      return [];
    }

    const events: ReAnchorEvent[] = rows.map(row => ({
      id: row.id,
      ts: row.ts,
      trigger: classifyTrigger(row),
      snippet: buildSnippet(row),
    }));

    log.debug(
      { event: 'reanchor.recent.done', count: events.length, windowDays, limit },
      'reanchor-monitor: getRecent complete',
    );

    return events;
  }
}
