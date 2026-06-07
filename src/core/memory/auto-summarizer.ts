/**
 * @file auto-summarizer.ts
 * @description AutoSummarizer — condenses session message history into
 * structured summaries stored in a dedicated SQLite table.
 *
 * Reads message rows from mind.db's messages table, extracts:
 *   - Key decisions (assistant lines containing "decided", "will", "plan", etc.)
 *   - Completed tasks  (lines containing "done", "completed", "finished", etc.)
 *   - Errors           (lines containing "error", "failed", "exception", etc.)
 *
 * Summaries are persisted to the provided database (typically mind.db opened
 * in write mode).  All DB access is synchronous via better-sqlite3.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';

const log = createLogger('memory:auto-summarizer');

const MIND_DB = '/root/sudo-ai-v4/data/mind.db';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id:               number;
  session_id:       string;
  summary:          string;
  decisions:        string[];
  tasks_completed:  string[];
  errors:           string[];
  created_at:       string;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface SummaryRow {
  id:              number;
  session_id:      string;
  summary:         string;
  decisions:       string;   // JSON array
  tasks_completed: string;   // JSON array
  errors:          string;   // JSON array
  created_at:      string;
}

interface MessageRow {
  content: string;
  role:    string;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

const DECISION_PATTERNS = [
  /\b(decided?|will|plan(ning)?|going to|choosing|chose|selected?|using)\b/i,
];
const TASK_PATTERNS = [
  /\b(done|completed?|finished?|success(?:fully)?|created?|saved?|wrote|built|deployed)\b/i,
];
const ERROR_PATTERNS = [
  /\b(error|fail(?:ed|ure)?|exception|crash(?:ed)?|cannot|unable|invalid|rejected)\b/i,
];

function extractLines(messages: MessageRow[], patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const msg of messages) {
    const lines = msg.content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 10 || trimmed.length > 300) continue;
      if (patterns.some(p => p.test(trimmed))) {
        hits.push(trimmed);
        if (hits.length >= 10) return hits; // cap at 10 per category
      }
    }
  }
  return hits;
}

function buildSummaryText(sessionId: string, messages: MessageRow[]): string {
  const total      = messages.length;
  const userCount  = messages.filter(m => m.role === 'user').length;
  const asstCount  = messages.filter(m => m.role === 'assistant').length;
  const toolCount  = messages.filter(m => m.role === 'tool').length;
  return (
    `Session ${sessionId}: ${total} message(s) — ` +
    `${userCount} user, ${asstCount} assistant, ${toolCount} tool calls.`
  );
}

// ---------------------------------------------------------------------------
// AutoSummarizer
// ---------------------------------------------------------------------------

export class AutoSummarizer {
  private db: Database.Database;

  /**
   * @param dbPath - Path to the SQLite file that will store session_summaries.
   *                 Defaults to mind.db.  The DB is opened in write mode so
   *                 the summaries table can be created.
   */
  constructor(dbPath = MIND_DB) {
    if (!existsSync(dbPath)) {
      log.warn({ dbPath }, 'Database file not found — AutoSummarizer will create it');
    }

    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ dbPath, err: msg }, 'Failed to open database');
      throw new Error(`AutoSummarizer: cannot open database at ${dbPath}: ${msg}`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT    NOT NULL,
        summary         TEXT    NOT NULL,
        decisions       TEXT    NOT NULL DEFAULT '[]',
        tasks_completed TEXT    NOT NULL DEFAULT '[]',
        errors          TEXT    NOT NULL DEFAULT '[]',
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);

    log.info({ dbPath }, 'AutoSummarizer initialised');
  }

  // -------------------------------------------------------------------------
  // summarizeSession
  // -------------------------------------------------------------------------

  /**
   * Reads all messages for `sessionId` from mind.db, extracts decisions /
   * tasks / errors, and saves a summary row.
   *
   * If a summary already exists for the session it is replaced so repeated
   * calls stay idempotent.
   *
   * @returns The stored SessionSummary.
   */
  summarizeSession(sessionId: string): SessionSummary {
    if (!sessionId?.trim()) {
      throw new TypeError('summarizeSession: sessionId must be a non-empty string');
    }

    log.info({ sessionId }, 'Summarising session');

    // Read messages from the same database this instance was constructed with,
    // so summaries are derived from (and written to) a single consistent DB.
    let messages: MessageRow[] = [];
    try {
      messages = this.db.prepare<{ sid: string }, MessageRow>(
        `SELECT content, role FROM messages WHERE session_id = :sid ORDER BY id ASC`,
      ).all({ sid: sessionId });
    } catch (err) {
      log.warn({ sessionId, err: String(err) }, 'Could not read messages from database');
    }

    const summaryText    = buildSummaryText(sessionId, messages);
    const decisions      = extractLines(messages.filter(m => m.role === 'assistant'), DECISION_PATTERNS);
    const tasksCompleted = extractLines(messages.filter(m => m.role === 'assistant'), TASK_PATTERNS);
    const errors         = extractLines(messages, ERROR_PATTERNS);

    // Upsert: delete existing then insert fresh
    this.db.prepare(`DELETE FROM session_summaries WHERE session_id = :sid`).run({ sid: sessionId });

    const info = this.db.prepare(`
      INSERT INTO session_summaries (session_id, summary, decisions, tasks_completed, errors)
      VALUES (:session_id, :summary, :decisions, :tasks_completed, :errors)
    `).run({
      session_id:      sessionId,
      summary:         summaryText,
      decisions:       JSON.stringify(decisions),
      tasks_completed: JSON.stringify(tasksCompleted),
      errors:          JSON.stringify(errors),
    });

    const row = this.db
      .prepare<{ id: number }, SummaryRow>(`SELECT * FROM session_summaries WHERE id = :id`)
      .get({ id: info.lastInsertRowid as number })!;

    log.info({ sessionId, decisions: decisions.length, tasks: tasksCompleted.length, errors: errors.length }, 'Summary saved');
    return rowToSummary(row);
  }

  // -------------------------------------------------------------------------
  // getSummary
  // -------------------------------------------------------------------------

  /** Retrieves the stored summary for a session, or null if none exists. */
  getSummary(sessionId: string): SessionSummary | null {
    if (!sessionId?.trim()) {
      log.warn('getSummary: empty sessionId');
      return null;
    }
    const row = this.db
      .prepare<{ sid: string }, SummaryRow>(
        `SELECT * FROM session_summaries WHERE session_id = :sid ORDER BY id DESC LIMIT 1`,
      )
      .get({ sid: sessionId });
    return row ? rowToSummary(row) : null;
  }

  // -------------------------------------------------------------------------
  // getRecentSummaries
  // -------------------------------------------------------------------------

  /** Returns the N most recently created summaries. */
  getRecentSummaries(limit = 10): SessionSummary[] {
    if (limit < 1) return [];
    const rows = this.db
      .prepare<{ l: number }, SummaryRow>(
        `SELECT * FROM session_summaries ORDER BY id DESC LIMIT :l`,
      )
      .all({ l: limit });
    return rows.map(rowToSummary);
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  /** Closes the underlying SQLite connection. Call before process exit. */
  close(): void {
    try {
      this.db.close();
      log.info('AutoSummarizer closed');
    } catch (err) {
      log.error({ err: String(err) }, 'close error');
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToSummary(row: SummaryRow): SessionSummary {
  return {
    id:              row.id,
    session_id:      row.session_id,
    summary:         row.summary,
    decisions:       safeParseArray(row.decisions),
    tasks_completed: safeParseArray(row.tasks_completed),
    errors:          safeParseArray(row.errors),
    created_at:      row.created_at,
  };
}

function safeParseArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
