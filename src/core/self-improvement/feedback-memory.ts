/**
 * @file feedback-memory.ts
 * @description FeedbackMemory — records both successes and failures per tool invocation.
 *
 * SUDO-AI v4 only tracked failures. v5 tracks both to compute meaningful EMA
 * scores and surface best-performing tools alongside problem areas.
 *
 * Storage: SQLite table `feedback_memory` in the shared mind.db instance.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('self-improvement:feedback-memory');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeedbackType = 'success' | 'failure';

export interface FeedbackRecord {
  id: string;
  type: FeedbackType;
  tool_name: string;
  input_hash: string;
  outcome_summary: string;
  quality_score: number;
  recorded_at: string;
  session_id: string;
}

export interface ToolStats {
  tool: string;
  successes: number;
  failures: number;
  avgScore: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS feedback_memory (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL CHECK (type IN ('success', 'failure')),
    tool_name        TEXT NOT NULL,
    input_hash       TEXT NOT NULL,
    outcome_summary  TEXT NOT NULL DEFAULT '',
    quality_score    REAL NOT NULL DEFAULT 0.5 CHECK (quality_score >= 0 AND quality_score <= 1),
    recorded_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    session_id       TEXT NOT NULL DEFAULT ''
  )
`;

const CREATE_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS feedback_memory_tool ON feedback_memory(tool_name)`,
  `CREATE INDEX IF NOT EXISTS feedback_memory_type ON feedback_memory(type)`,
  `CREATE INDEX IF NOT EXISTS feedback_memory_recorded ON feedback_memory(recorded_at)`,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hashInput(input: unknown): string {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16);
}

function clampScore(score: number): number {
  return Math.min(1, Math.max(0, score));
}

// ---------------------------------------------------------------------------
// FeedbackMemory
// ---------------------------------------------------------------------------

export class FeedbackMemory {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    if (!db) throw new TypeError('db must be a better-sqlite3 Database instance');
    this.db = db;
    this._ensureSchema();
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap
  // -------------------------------------------------------------------------

  private _ensureSchema(): void {
    try {
      this.db.exec(CREATE_TABLE_SQL);
      for (const sql of CREATE_INDEXES_SQL) {
        this.db.exec(sql);
      }
      log.debug('feedback_memory table ensured');
    } catch (err) {
      log.error({ err: String(err) }, 'Failed to create feedback_memory schema');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Write API
  // -------------------------------------------------------------------------

  /**
   * Record a successful tool invocation.
   *
   * @param toolName  - Name of the tool that ran.
   * @param input     - Tool input (will be hashed, not stored raw).
   * @param outcome   - Human-readable outcome summary.
   * @param score     - Quality score in [0, 1] (default: 0.8).
   * @param sessionId - Optional session identifier.
   */
  recordSuccess(
    toolName: string,
    input: unknown,
    outcome: string,
    score = 0.8,
    sessionId = '',
  ): FeedbackRecord {
    return this._insert('success', toolName, input, outcome, score, sessionId);
  }

  /**
   * Record a failed tool invocation.
   *
   * @param toolName  - Name of the tool that failed.
   * @param input     - Tool input (will be hashed, not stored raw).
   * @param error     - Error message or description.
   * @param sessionId - Optional session identifier.
   */
  recordFailure(
    toolName: string,
    input: unknown,
    error: string,
    sessionId = '',
  ): FeedbackRecord {
    return this._insert('failure', toolName, input, error, 0.0, sessionId);
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /**
   * Return recent success records, optionally filtered by tool name.
   *
   * @param toolName - Optional tool name filter.
   * @param limit    - Maximum rows to return (default: 50).
   */
  getSuccessPatterns(toolName?: string, limit = 50): FeedbackRecord[] {
    return this._query('success', toolName, limit);
  }

  /**
   * Return recent failure records, optionally filtered by tool name.
   *
   * @param toolName - Optional tool name filter.
   * @param limit    - Maximum rows to return (default: 50).
   */
  getFailurePatterns(toolName?: string, limit = 50): FeedbackRecord[] {
    return this._query('failure', toolName, limit);
  }

  /**
   * Aggregate per-tool stats: success count, failure count, average quality score.
   *
   * @returns Map keyed by tool name.
   */
  getToolStats(): Map<string, ToolStats> {
    interface StatsRow {
      tool_name: string;
      successes: number;
      failures: number;
      avg_score: number | null;
    }

    let rows: StatsRow[];
    try {
      rows = this.db.prepare(`
        SELECT
          tool_name,
          SUM(CASE WHEN type = 'success' THEN 1 ELSE 0 END) AS successes,
          SUM(CASE WHEN type = 'failure' THEN 1 ELSE 0 END) AS failures,
          AVG(quality_score) AS avg_score
        FROM feedback_memory
        GROUP BY tool_name
      `).all() as StatsRow[];
    } catch (err) {
      log.error({ err: String(err) }, 'getToolStats query failed');
      return new Map();
    }

    const result = new Map<string, ToolStats>();
    for (const row of rows) {
      result.set(row.tool_name, {
        tool: row.tool_name,
        successes: row.successes ?? 0,
        failures: row.failures ?? 0,
        avgScore: row.avg_score ?? 0,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _insert(
    type: FeedbackType,
    toolName: string,
    input: unknown,
    outcomeSummary: string,
    qualityScore: number,
    sessionId: string,
  ): FeedbackRecord {
    if (!toolName?.trim()) throw new Error('toolName must not be empty');

    const record: FeedbackRecord = {
      id: generateId(),
      type,
      tool_name: toolName.trim(),
      input_hash: hashInput(input),
      outcome_summary: (outcomeSummary ?? '').slice(0, 2000),
      quality_score: clampScore(qualityScore),
      recorded_at: new Date().toISOString(),
      session_id: sessionId ?? '',
    };

    try {
      this.db.prepare(`
        INSERT INTO feedback_memory
          (id, type, tool_name, input_hash, outcome_summary, quality_score, recorded_at, session_id)
        VALUES
          (:id, :type, :tool_name, :input_hash, :outcome_summary, :quality_score, :recorded_at, :session_id)
      `).run(record);

      log.debug({ type, tool: toolName, id: record.id }, 'Feedback recorded');
    } catch (err) {
      log.error({ err: String(err), type, tool: toolName }, 'Failed to insert feedback record');
      throw err;
    }

    return record;
  }

  private _query(type: FeedbackType, toolName: string | undefined, limit: number): FeedbackRecord[] {
    if (limit <= 0) return [];

    try {
      if (toolName) {
        return this.db.prepare<{ type: string; tool_name: string; limit: number }>(`
          SELECT * FROM feedback_memory
          WHERE type = :type AND tool_name = :tool_name
          ORDER BY recorded_at DESC
          LIMIT :limit
        `).all({ type, tool_name: toolName, limit }) as FeedbackRecord[];
      } else {
        return this.db.prepare<{ type: string; limit: number }>(`
          SELECT * FROM feedback_memory
          WHERE type = :type
          ORDER BY recorded_at DESC
          LIMIT :limit
        `).all({ type, limit }) as FeedbackRecord[];
      }
    } catch (err) {
      log.error({ err: String(err), type, toolName }, 'Feedback query failed');
      return [];
    }
  }
}
