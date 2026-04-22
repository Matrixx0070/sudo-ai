/**
 * @file sessions.db-utils.ts
 * @description DB open helper and session-meta parsing for the sessions admin handler.
 *
 * Operates directly on data/mind.db via better-sqlite3 to avoid circular
 * dependency with SessionManager / MindDB.
 */

import path from 'node:path';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin:sessions:db');

export const MIND_DB_PATH = path.resolve(process.cwd(), 'data', 'mind.db');

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('better-sqlite3')) as any;
    const Database = mod.default ?? mod;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tableExists(db: any, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`)
    .get({});
  return Boolean(row);
}
