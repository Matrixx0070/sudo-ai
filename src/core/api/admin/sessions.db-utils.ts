/**
 * @file sessions.db-utils.ts
 * @description DB open helper and session-meta parsing for the sessions admin handler.
 *
 * Operates directly on data/mind.db via better-sqlite3 to avoid circular
 * dependency with SessionManager / MindDB.
 */

import path from 'node:path';
import type BetterSqlite3T from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { DATA_DIR } from '../../shared/paths.js';

const log = createLogger('api:admin:sessions:db');

export const MIND_DB_PATH = path.join(DATA_DIR, 'mind.db');

// ---------------------------------------------------------------------------
// Types (mirrors SessionManager internals — no direct import)
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  channel: string;
  peerId: string;
  state: 'active' | 'compacted' | 'archived';
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  session_id: string;
  role: string;
  content: string;
  tool_name?: string | null;
  created_at?: string | null;
}

export interface BetterSqliteRow {
  text: string;
}

// ---------------------------------------------------------------------------
// DB open helper
// ---------------------------------------------------------------------------

/**
 * Open mind.db with the given options.
 * Returns null if the file does not exist or fails to open — callers handle gracefully.
 */
export async function openMindDb(
  opts: { readonly?: boolean } = { readonly: true },
): Promise<BetterSqlite3T.Database | null> {
  try {
    const mod = await import('better-sqlite3');
    // ESM dynamic import wraps CJS default export in { default: ... }
    const Database = (mod.default ?? mod) as typeof BetterSqlite3T;
    return new Database(MIND_DB_PATH, opts);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug({ path: MIND_DB_PATH }, 'mind.db not found — returning null');
    } else {
      log.error({ err, path: MIND_DB_PATH }, 'Failed to open mind.db');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session meta parsing
// ---------------------------------------------------------------------------

/**
 * Parse and deduplicate session meta records from rows returned by the chunks table.
 * Returns the most-recent version of each session (rows must be ordered DESC by rowid).
 */
export function parseSessionMetas(rows: BetterSqliteRow[]): SessionMeta[] {
  const seen = new Map<string, SessionMeta>();

  for (const row of rows) {
    try {
      const meta = JSON.parse(row.text) as Partial<SessionMeta>;
      if (
        typeof meta.id === 'string' &&
        typeof meta.channel === 'string' &&
        typeof meta.peerId === 'string' &&
        typeof meta.state === 'string' &&
        !seen.has(meta.id)
      ) {
        seen.set(meta.id, meta as SessionMeta);
      }
    } catch {
      // malformed chunk — skip
    }
  }

  return [...seen.values()];
}

/**
 * Check whether a SQLite table exists in the given db.
 */
export function tableExists(db: BetterSqlite3T.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(tableName);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// BO9 / S8 — read helpers for the inline dashboard sessions table.
//
// Every SQL statement lives inside this module (the sanctioned admin "session
// API"); the handler calls named helpers, never raw SQL. All reads are
// SELECT-only. Mutations (reversible archive, additive fork) go through the real
// MindDB memory API in the handler — never a hand-rolled INSERT that would skip
// the content-hash / message-scan invariants.
// ---------------------------------------------------------------------------

/** A message copied verbatim on fork. */
export interface StoredMessage {
  role: string;
  content: string;
  tool_name?: string | null;
}

/** Per-session character + message-count usage, keyed by session id. */
export interface SessionUsageAgg {
  chars: number;
  messageCount: number;
}

/**
 * Aggregate total content chars + message count per session from the messages
 * table. Returns an empty map when the table is absent. SELECT-only.
 */
export function loadSessionUsage(db: BetterSqlite3T.Database): Map<string, SessionUsageAgg> {
  const out = new Map<string, SessionUsageAgg>();
  if (!tableExists(db, 'messages')) return out;
  const rows = db
    .prepare(
      `SELECT session_id AS id,
              COUNT(*)                          AS messageCount,
              COALESCE(SUM(LENGTH(content)), 0) AS chars
         FROM messages
        GROUP BY session_id`,
    )
    .all() as Array<{ id: string; messageCount: number; chars: number }>;
  for (const r of rows) {
    out.set(r.id, { chars: Number(r.chars) || 0, messageCount: Number(r.messageCount) || 0 });
  }
  return out;
}

/** Load the newest meta blob for every session. SELECT-only. */
export function loadAllSessionMetas(db: BetterSqlite3T.Database): SessionMeta[] {
  if (!tableExists(db, 'chunks')) return [];
  const rows = db
    .prepare(
      `SELECT text FROM chunks
        WHERE path LIKE 'session:%:meta' AND source = 'conversation'
        ORDER BY rowid DESC`,
    )
    .all() as BetterSqliteRow[];
  return parseSessionMetas(rows);
}

/** Load one session's newest meta blob, or null. SELECT-only. */
export function loadSessionMeta(db: BetterSqlite3T.Database, id: string): SessionMeta | null {
  const row = db
    .prepare(
      `SELECT text FROM chunks
        WHERE path = :path AND source = 'conversation'
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get({ path: `session:${id}:meta` }) as BetterSqliteRow | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.text) as SessionMeta;
  } catch {
    return null;
  }
}

/** Load one session's messages in insertion order. SELECT-only. */
export function loadSessionMessages(db: BetterSqlite3T.Database, id: string): StoredMessage[] {
  if (!tableExists(db, 'messages')) return [];
  return db
    .prepare(
      `SELECT role, content, tool_name
         FROM messages
        WHERE session_id = :id
        ORDER BY rowid ASC`,
    )
    .all({ id }) as StoredMessage[];
}

/**
 * Reversible archive: flip a session's meta state in place. NEVER deletes
 * messages or the session row — archive is a mark, fully reversible by writing
 * the state back. Mirrors the in-place meta update the existing DELETE handler
 * already uses. Returns the updated meta. Requires a writable db handle.
 */
export function updateSessionState(
  db: BetterSqlite3T.Database,
  id: string,
  meta: SessionMeta,
  nextState: SessionMeta['state'],
): SessionMeta {
  const updated: SessionMeta = { ...meta, state: nextState, updatedAt: new Date().toISOString() };
  db
    .prepare(`UPDATE chunks SET text = :text WHERE path = :path AND source = 'conversation'`)
    .run({ text: JSON.stringify(updated), path: `session:${id}:meta` });
  return updated;
}
