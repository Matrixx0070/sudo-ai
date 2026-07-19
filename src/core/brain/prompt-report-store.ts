/**
 * @file prompt-report-store.ts
 * @description BO1 / scorecard-S9 — durable persistence + stable-prefix-churn
 * detection for per-turn prompt reports.
 *
 * Persists {@link PromptReport}s to a dedicated SQLite file
 * (`data/prompt-reports.db`), reusing the better-sqlite3 idioms from
 * `src/llm/logging.ts` (WAL + NORMAL sync + idempotent DDL + fail-open writes).
 *
 * INVARIANT — NO RAW PROMPT TEXT: only char counts + sha256 hashes are written.
 * The `sections_json` column holds the {name, chars, sha256, region} array,
 * never any prompt content.
 *
 * STABLE-PREFIX CHURN ALERT: the cacheable stable prefix must be byte-stable
 * turn-over-turn for provider cache hits. On each record, the store compares
 * the new stable-prefix hash to the previous one for the same session key; an
 * unexpected change is flagged (`prefix_churned = 1`) and a telemetry warning
 * is emitted. BO2 consumes this to hunt cache-busters.
 *
 * Everything here is flag-gated behind SUDO_PROMPT_REPORT (default OFF) and
 * fail-open: a persistence failure never blocks or alters an LLM call.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';
import { buildPromptReport, detectPrefixChurn, type PromptReport } from './prompt-report.js';

const log = createLogger('brain:prompt-report');

/**
 * Flag gate. Default OFF so prod is byte-for-byte unaffected until explicitly
 * enabled. Enabled only when SUDO_PROMPT_REPORT is '1' (or 'true').
 */
export function isPromptReportEnabled(): boolean {
  const v = process.env['SUDO_PROMPT_REPORT'];
  return v === '1' || v === 'true';
}

/** Optional per-call metadata attached to a persisted report row. */
export interface PromptReportMeta {
  /** Session/route key used for churn comparison. Falls back to 'default'. */
  sessionKey?: string;
  /** Caller tag (BrainRequest.source), e.g. 'chat' | 'cron' | 'heartbeat'. */
  source?: string;
  /** Requested/resolved model route. */
  route?: string;
  /** Whether this was a heartbeat (slim) prompt. */
  heartbeat?: boolean;
}

/** Result of a record() call. */
export interface RecordResult {
  /** Rowid of the inserted report, or null on failure. */
  id: number | null;
  /** Whether the stable prefix churned vs the previous turn for this session key. */
  churned: boolean;
  /** Previous stable-prefix hash for this session key, if any. */
  previousStableSha256: string | null;
}

const DDL_TABLE = `
  CREATE TABLE IF NOT EXISTS prompt_reports (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT    NOT NULL,
    session_key         TEXT    NOT NULL,
    source              TEXT,
    route               TEXT,
    heartbeat           INTEGER NOT NULL DEFAULT 0,
    total_chars         INTEGER NOT NULL,
    full_sha256         TEXT    NOT NULL,
    stable_chars        INTEGER NOT NULL,
    stable_sha256       TEXT    NOT NULL,
    dynamic_chars       INTEGER NOT NULL,
    dynamic_sha256      TEXT    NOT NULL,
    has_boundary        INTEGER NOT NULL DEFAULT 0,
    cache_enabled       INTEGER NOT NULL DEFAULT 0,
    section_count       INTEGER NOT NULL DEFAULT 0,
    sections_json       TEXT,
    prefix_churned      INTEGER NOT NULL DEFAULT 0
  )
`;

const DDL_IDX_TS      = `CREATE INDEX IF NOT EXISTS idx_prompt_reports_ts      ON prompt_reports(ts)`;
const DDL_IDX_SESSION = `CREATE INDEX IF NOT EXISTS idx_prompt_reports_session ON prompt_reports(session_key)`;

/**
 * Durable prompt-report store. Singleton via {@link getPromptReportStore}.
 */
export class PromptReportStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = path.join(DATA_DIR, 'prompt-reports.db')) {
    if (!dbPath?.trim()) throw new TypeError('PromptReportStore: dbPath must be a non-empty string');

    const dir = path.dirname(dbPath);
    // ':memory:' has no directory to create.
    if (dbPath !== ':memory:' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this._applyDdl();
    log.info({ dbPath }, 'PromptReportStore initialised');
  }

  private _applyDdl(): void {
    for (const stmt of [DDL_TABLE, DDL_IDX_TS, DDL_IDX_SESSION]) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists') && !msg.includes('duplicate column')) {
          log.warn({ stmt: stmt.slice(0, 80), err: msg }, 'DDL warning');
        }
      }
    }
  }

  /** Most recent stable-prefix hash for a session key, or null if none. */
  lastStableSha256(sessionKey: string): string | null {
    try {
      const row = this.db
        .prepare(
          `SELECT stable_sha256 FROM prompt_reports
             WHERE session_key = :k ORDER BY id DESC LIMIT 1`,
        )
        .get({ k: sessionKey }) as { stable_sha256?: string } | undefined;
      return row?.stable_sha256 ?? null;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'lastStableSha256 failed');
      return null;
    }
  }

  /**
   * Persist a report and return churn status. Fail-open: any error yields
   * `{ id: null, churned: false, previousStableSha256: null }` and is logged.
   */
  record(report: PromptReport, meta: PromptReportMeta = {}): RecordResult {
    const sessionKey = (meta.sessionKey && meta.sessionKey.trim()) || 'default';
    try {
      const prev = this.lastStableSha256(sessionKey);
      const churned = detectPrefixChurn(prev, report.stablePrefixSha256);

      if (churned) {
        // Stable-prefix-churn telemetry — the diagnostic BO2 fixes cache-busters with.
        log.warn(
          {
            sessionKey,
            route: meta.route,
            source: meta.source,
            previousStableSha256: prev,
            stableSha256: report.stablePrefixSha256,
            stableChars: report.stablePrefixChars,
          },
          'stable-prefix churn: cacheable prefix hash changed turn-over-turn (cache-buster suspected)',
        );
      }

      const info = this.db
        .prepare(`
          INSERT INTO prompt_reports
            (ts, session_key, source, route, heartbeat, total_chars, full_sha256,
             stable_chars, stable_sha256, dynamic_chars, dynamic_sha256,
             has_boundary, cache_enabled, section_count, sections_json, prefix_churned)
          VALUES
            (:ts, :session_key, :source, :route, :heartbeat, :total_chars, :full_sha256,
             :stable_chars, :stable_sha256, :dynamic_chars, :dynamic_sha256,
             :has_boundary, :cache_enabled, :section_count, :sections_json, :prefix_churned)
        `)
        .run({
          ts: report.ts,
          session_key: sessionKey,
          source: meta.source ?? null,
          route: meta.route ?? null,
          heartbeat: meta.heartbeat ? 1 : 0,
          total_chars: report.totalChars,
          full_sha256: report.fullSha256,
          stable_chars: report.stablePrefixChars,
          stable_sha256: report.stablePrefixSha256,
          dynamic_chars: report.dynamicSuffixChars,
          dynamic_sha256: report.dynamicSuffixSha256,
          has_boundary: report.hasBoundary ? 1 : 0,
          cache_enabled: report.cacheEnabled ? 1 : 0,
          section_count: report.sections.length,
          sections_json: JSON.stringify(report.sections),
          prefix_churned: churned ? 1 : 0,
        });

      return { id: Number(info.lastInsertRowid), churned, previousStableSha256: prev };
    } catch (err) {
      log.warn(
        { sessionKey, err: err instanceof Error ? err.message : String(err) },
        'PromptReportStore.record failed',
      );
      return { id: null, churned: false, previousStableSha256: null };
    }
  }

  /** Count of persisted reports (tests / diagnostics). */
  count(): number {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM prompt_reports`).get() as { n: number };
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton + convenience entry point wired from brain.call()
// ---------------------------------------------------------------------------

let _instance: PromptReportStore | null = null;

/** Process-wide singleton store. */
export function getPromptReportStore(dbPath?: string): PromptReportStore {
  if (!_instance) _instance = new PromptReportStore(dbPath);
  return _instance;
}

/** Test hook: drop the singleton so the next getPromptReportStore() re-creates it. */
export function __resetPromptReportStore(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

/**
 * Build + persist a report for one assembled prompt. Fully fail-open — this is
 * observability and must NEVER break or alter an LLM call. Callers gate on
 * {@link isPromptReportEnabled} first (cheap env check), but this also no-ops
 * safely if the flag is off.
 */
export function recordPromptReport(prompt: string, meta: PromptReportMeta = {}): RecordResult {
  const NOOP: RecordResult = { id: null, churned: false, previousStableSha256: null };
  try {
    if (!isPromptReportEnabled()) return NOOP;
    const report = buildPromptReport(prompt);
    return getPromptReportStore().record(report, meta);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'recordPromptReport failed');
    return NOOP;
  }
}
