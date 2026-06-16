/**
 * @file sqlite-session-store.ts
 * @description SQLite-backed session store layered on top of the
 * existing MindDB / better-sqlite3 stack.
 *
 * Accepts the raw `Database` instance exposed by `MindDB.db`.
 * Prepared statements are compiled once in the constructor and reused.
 *
 * Security:
 *  - guardMemoryWrite called on every content write.
 *  - MemoryInjectionError is NOT caught — it bubbles unchanged.
 *  - FTS5 MATCH uses parameterized binding only — never string interpolation.
 *
 * Error hierarchy:
 *  - SessionStoreError (extends SudoError, code 'session_*') for store-level errors.
 *  - MemoryInjectionError bubbles from appendMessage unchanged.
 */

import type { Database, Statement } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { SudoError } from '../shared/errors.js';
import { guardMemoryWrite, type MessageRole } from '../memory/injection-scanner.js';

const log = createLogger('sessions:sqlite-session-store');

// ---------------------------------------------------------------------------
// SessionStoreError
// ---------------------------------------------------------------------------

export class SessionStoreError extends SudoError {
  constructor(message: string, code: `session_${string}`, details?: Record<string, unknown>) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
    (this as unknown as { name: string }).name = 'SessionStoreError';
  }
}

// ---------------------------------------------------------------------------
// Row shapes (public interface — uses session_id field name)
// ---------------------------------------------------------------------------

export interface SessionRow {
  session_id:        string;        // maps to sessions.id column
  source_platform:   string;        // ChannelType value
  user_id:           string;        // peerId from UnifiedMessage
  model:             string;
  system_prompt:     string | null;
  parent_session_id: string | null; // compression chain FK
  input_tokens:      number;
  output_tokens:     number;
  cost_usd:          number;
  title:             string | null;
  status:            string;        // idle | running | rescheduling | terminated | archived
  created_at:        string;        // ISO-8601
  updated_at:        string;
}

export interface MessageRow {
  id:         number;   // AUTOINCREMENT PK
  session_id: string;
  role:       'user' | 'assistant' | 'system' | 'tool';
  content:    string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface ListSessionsOptions {
  limit?:    number;   // default 50
  afterId?:  string;   // cursor-based pagination (session_id)
  userId?:   string;   // filter by user_id column
  platform?: string;   // filter by source_platform column
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

/** Aliased SELECT result — id column aliased to session_id */
interface AliasedSessionRow {
  session_id:        string;
  source_platform:   string;
  user_id:           string;
  model:             string;
  system_prompt:     string | null;
  parent_session_id: string | null;
  input_tokens:      number;
  output_tokens:     number;
  cost_usd:          number;
  title:             string | null;
  status:            string;
  created_at:        string;
  updated_at:        string;
}

/** Raw session row for cursor lookup (id not aliased) */
interface RawCursorRow {
  created_at: string;
}

interface CountRow {
  cnt: number;
}

// ---------------------------------------------------------------------------
// Prepared-statement bind shapes (named params → object literals)
// ---------------------------------------------------------------------------

interface InsertSessionBind {
  id: string;
  source_platform: string;
  user_id: string;
  model: string;
  system_prompt: string | null;
  parent_session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  title: string | null;
  status: string;
}

interface InsertMessageBind {
  session_id: string;
  role: MessageRow['role'];
  content: string;
}

interface LinkParentBind {
  id: string;
  parent_session_id: string;
}

// ---------------------------------------------------------------------------
// Column definitions for migration runner
// ---------------------------------------------------------------------------

const NEW_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ['sessions', 'source_platform',   "TEXT NOT NULL DEFAULT ''"],
  ['sessions', 'user_id',           "TEXT NOT NULL DEFAULT ''"],
  ['sessions', 'system_prompt',     'TEXT'],
  ['sessions', 'parent_session_id', 'TEXT'],
  ['sessions', 'input_tokens',      'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'output_tokens',     'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'cost_usd',          'REAL NOT NULL DEFAULT 0'],
  // Session state machine status column
  ['sessions', 'status',            "TEXT NOT NULL DEFAULT 'idle'"],
] as const;

// ---------------------------------------------------------------------------
// SqliteSessionStore
// ---------------------------------------------------------------------------

export class SqliteSessionStore {
  private readonly db: Database;

  // Prepared statements — compiled once in constructor, reused on every call.
  // Typed via better-sqlite3's `Statement<BindParameters, Result>` so the
  // bind shapes and row shapes flow through, eliminating the explicit-any
  // suppressions the file used to need on each declaration.
  private readonly stmtInsertSession: Statement<[InsertSessionBind]>;
  private readonly stmtGetSession: Statement<[string], AliasedSessionRow>;
  private readonly stmtInsertMessage: Statement<[InsertMessageBind]>;
  private readonly stmtGetMessages: Statement<[string, number], MessageRow>;
  private readonly stmtCountMessages: Statement<[string], CountRow>;
  private readonly stmtLinkParent: Statement<[LinkParentBind]>;
  private readonly stmtDeleteSession: Statement<[string]>;
  private readonly stmtGetCursorAt: Statement<[string], RawCursorRow>;
  private readonly stmtSearchSessions: Statement<[string], AliasedSessionRow>;

  constructor(db: Database) {
    this.db = db;
    // Ensure FK cascade is on (idempotent pragma)
    this.db.pragma('foreign_keys = ON');
    this._runMigrations();

    // Compile all statements once after migrations complete
    this.stmtInsertSession = this.db.prepare(`
      INSERT INTO sessions
        (id, source_platform, user_id, model, system_prompt,
         parent_session_id, input_tokens, output_tokens, cost_usd, title, status)
      VALUES
        (:id, :source_platform, :user_id, :model, :system_prompt,
         :parent_session_id, :input_tokens, :output_tokens, :cost_usd, :title, :status)
    `);

    this.stmtGetSession = this.db.prepare(`
      SELECT
        id              AS session_id,
        source_platform, user_id, model, system_prompt,
        parent_session_id, input_tokens, output_tokens, cost_usd,
        title, status, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `);

    this.stmtInsertMessage = this.db.prepare(`
      INSERT INTO messages (session_id, role, content)
      VALUES (:session_id, :role, :content)
    `);

    this.stmtGetMessages = this.db.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ?
    `);

    this.stmtCountMessages = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?`,
    );

    this.stmtLinkParent = this.db.prepare(
      `UPDATE sessions SET parent_session_id = :parent_session_id WHERE id = :id`,
    );

    this.stmtDeleteSession = this.db.prepare(
      `DELETE FROM sessions WHERE id = ?`,
    );

    this.stmtGetCursorAt = this.db.prepare(
      `SELECT created_at FROM sessions WHERE id = ?`,
    );

    this.stmtSearchSessions = this.db.prepare(`
      SELECT DISTINCT
        s.id              AS session_id,
        s.source_platform, s.user_id, s.model, s.system_prompt,
        s.parent_session_id, s.input_tokens, s.output_tokens, s.cost_usd,
        s.title, s.status, s.created_at, s.updated_at
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      JOIN session_messages_fts fts ON fts.rowid = m.id
      WHERE session_messages_fts MATCH ?
      ORDER BY s.created_at DESC
    `);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Insert a new session row.
   * Params: all SessionRow fields except created_at / updated_at (DB-generated).
   */
  createSession(params: Omit<SessionRow, 'created_at' | 'updated_at'>): void {
    if (!params.session_id) {
      throw new SessionStoreError('session_id is required', 'session_invalid_params');
    }
    if (!params.model) {
      throw new SessionStoreError('model is required', 'session_invalid_params');
    }
    log.debug({ sessionId: params.session_id }, 'createSession');
    this.stmtInsertSession.run({
      id:                params.session_id,
      source_platform:   params.source_platform ?? '',
      user_id:           params.user_id ?? '',
      model:             params.model,
      system_prompt:     params.system_prompt ?? null,
      parent_session_id: params.parent_session_id ?? null,
      input_tokens:      params.input_tokens ?? 0,
      output_tokens:     params.output_tokens ?? 0,
      cost_usd:          params.cost_usd ?? 0,
      title:             params.title ?? null,
      status:            params.status ?? 'idle',
    });
  }

  /**
   * Retrieve a session by ID. Returns undefined if not found.
   */
  getSession(sessionId: string): SessionRow | undefined {
    if (!sessionId) return undefined;
    const row = this.stmtGetSession.get(sessionId);
    return row ? this._mapSession(row) : undefined;
  }

  /**
   * Append a message to a session.
   * Calls guardMemoryWrite — MemoryInjectionError bubbles unchanged (not caught).
   * Returns the auto-assigned message ID.
   */
  appendMessage(sessionId: string, role: MessageRow['role'], content: string): number {
    if (!sessionId) throw new SessionStoreError('sessionId is required', 'session_invalid_params');
    // IMPORTANT: guardMemoryWrite may throw MemoryInjectionError — must NOT be caught
    const safeContent = guardMemoryWrite(content, `SqliteSessionStore.appendMessage[${role}]`, role as MessageRole);
    const info = this.stmtInsertMessage.run({ session_id: sessionId, role, content: safeContent });
    log.debug({ sessionId, role, msgId: info.lastInsertRowid }, 'appendMessage');
    return info.lastInsertRowid as number;
  }

  /**
   * Return messages for a session in chronological order.
   * @param limit - Max rows to return (default: 100)
   */
  getMessages(sessionId: string, limit = 100): MessageRow[] {
    if (!sessionId) return [];
    return this.stmtGetMessages.all(sessionId, limit);
  }

  /**
   * List sessions with optional cursor pagination and filters.
   * Ordered by created_at DESC, then id DESC.
   */
  listSessions(opts: ListSessionsOptions = {}): SessionRow[] {
    const limit = Math.min(opts.limit ?? 50, 500);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit };

    if (opts.userId) {
      clauses.push('user_id = :user_id');
      params['user_id'] = opts.userId;
    }
    if (opts.platform) {
      clauses.push('source_platform = :platform');
      params['platform'] = opts.platform;
    }

    // Cursor pagination via afterId — look up the cursor row's created_at
    if (opts.afterId) {
      const cursor = this.stmtGetCursorAt.get(opts.afterId);
      if (cursor) {
        clauses.push(
          '(created_at < :cursor_at OR (created_at = :cursor_at AND id < :cursor_id))',
        );
        params['cursor_at'] = cursor.created_at;
        params['cursor_id'] = opts.afterId;
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.db.prepare<Record<string, unknown>, AliasedSessionRow>(`
      SELECT
        id              AS session_id,
        source_platform, user_id, model, system_prompt,
        parent_session_id, input_tokens, output_tokens, cost_usd,
        title, status, created_at, updated_at
      FROM sessions
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT :limit
    `).all(params);

    return rows.map((r) => this._mapSession(r));
  }

  /**
   * Search sessions by message content using FTS5 BM25.
   * Returns deduplicated sessions ordered by created_at DESC.
   * @throws SessionStoreError on FTS5 MATCH syntax error.
   */
  searchSessions(query: string): SessionRow[] {
    if (!query?.trim()) return [];
    try {
      const rows = this.stmtSearchSessions.all(query);
      return rows.map((r) => this._mapSession(r));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ query: query.slice(0, 80), err: msg }, 'searchSessions: FTS5 error');
      // Sanitize error details to prevent query text leakage in HTTP responses
      throw new SessionStoreError(
        'FTS5 search failed: invalid query syntax',
        'session_search_syntax',
      );
    }
  }

  /**
   * Set the parent_session_id for session compression chains.
   * @throws SessionStoreError if the parent session doesn't exist.
   */
  linkParent(sessionId: string, parentId: string): void {
    if (!sessionId || !parentId) {
      throw new SessionStoreError('sessionId and parentId are required', 'session_invalid_params');
    }
    if (!this.getSession(parentId)) {
      throw new SessionStoreError(
        `Parent session not found: ${parentId}`,
        'session_not_found',
        { parentId },
      );
    }
    this.stmtLinkParent.run({ id: sessionId, parent_session_id: parentId });
    log.debug({ sessionId, parentId }, 'linkParent');
  }

  /**
   * Delete a session and all its messages (CASCADE via FK).
   * Returns true if a row was deleted.
   */
  deleteSession(sessionId: string): boolean {
    if (!sessionId) return false;
    // Null out child sessions' parent references before deleting to avoid dangling FK references
    this.db.prepare(
      `UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?`
    ).run(sessionId);
    const info = this.stmtDeleteSession.run(sessionId);
    log.debug({ sessionId, deleted: info.changes > 0 }, 'deleteSession');
    return info.changes > 0;
  }

  /**
   * Return message count for a session (utility; used in tests).
   */
  getMessageCount(sessionId: string): number {
    const row = this.stmtCountMessages.get(sessionId);
    return row?.cnt ?? 0;
  }

  /**
   * Update the title of a session.
   * Used by REST routes PATCH/update endpoint.
   * No-ops if the session does not exist.
   */
  updateTitle(sessionId: string, title: string): void {
    if (!sessionId) return;
    this.db.prepare(
      `UPDATE sessions SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    ).run(title, sessionId);
    log.debug({ sessionId, title: title.slice(0, 50) }, 'updateTitle');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Run ALTER TABLE migrations + FTS5 setup. Safe to call multiple times. */
  private _runMigrations(): void {
    // 1. ALTER TABLE — each wrapped in try/catch (no IF NOT EXISTS for columns in SQLite)
    for (const [table, col, def] of NEW_COLUMNS) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
          throw err;
        }
        // Column already exists — safe to ignore
      }
    }

    // 2. Indexes for new columns (IF NOT EXISTS — idempotent)
    const idxStatements = [
      `CREATE INDEX IF NOT EXISTS idx_sessions_source_platform   ON sessions(source_platform)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user_id           ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_status            ON sessions(status)`,
    ];
    for (const stmt of idxStatements) {
      this.db.exec(stmt);
    }

    // 3. FTS5 virtual table (IF NOT EXISTS)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        content,
        content       = 'messages',
        content_rowid = 'id',
        tokenize      = 'porter unicode61'
      )
    `);

    // 4. FTS5 sync triggers (IF NOT EXISTS)
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS smfts_ai
        AFTER INSERT ON messages
        BEGIN
          INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
        END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS smfts_ad
        AFTER DELETE ON messages
        BEGIN
          INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS smfts_au
        AFTER UPDATE ON messages
        BEGIN
          INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
          INSERT INTO session_messages_fts(rowid, content) VALUES (new.id, new.content);
        END
    `);

    log.debug('_runMigrations: complete');
  }

  /** Map aliased DB row to public SessionRow interface. */
  private _mapSession(row: AliasedSessionRow): SessionRow {
    return {
      session_id:        row.session_id,
      source_platform:   row.source_platform ?? '',
      user_id:           row.user_id ?? '',
      model:             row.model,
      system_prompt:     row.system_prompt ?? null,
      parent_session_id: row.parent_session_id ?? null,
      input_tokens:      row.input_tokens ?? 0,
      output_tokens:     row.output_tokens ?? 0,
      cost_usd:          row.cost_usd ?? 0,
      title:             row.title ?? null,
      status:            row.status ?? 'idle',
      created_at:        row.created_at,
      updated_at:        row.updated_at,
    };
  }
}
