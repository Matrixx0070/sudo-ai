/**
 * @file outcome-adapters.test.ts
 * @description Unit tests for buildOutcomeAdapters (Wave DemoPrep).
 *
 * Uses a real in-memory better-sqlite3 Database seeded via SqliteSessionStore,
 * matching the setup pattern established in state-machine.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { SqliteSessionStore } from '../../src/core/sessions/sqlite-session-store.js';
import { buildOutcomeAdapters } from '../../src/core/sessions/outcome-adapters.js';

// ---------------------------------------------------------------------------
// In-memory DB helpers (mirrors state-machine.test.ts pattern exactly)
// ---------------------------------------------------------------------------

function makeDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      title           TEXT,
      model           TEXT NOT NULL,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      total_cost_usd  REAL    NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role          TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
      content       TEXT    NOT NULL,
      tool_name     TEXT,
      tool_input    TEXT,
      tool_output   TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  return db;
}

function makeStore(db: DB): SqliteSessionStore {
  return new SqliteSessionStore(db);
}

function insertSession(
  store: SqliteSessionStore,
  id: string,
  overrides: Partial<{ title: string | null; system_prompt: string | null }> = {},
): void {
  store.createSession({
    session_id: id,
    model: 'test-model',
    user_id: 'user1',
    source_platform: 'test',
    title: overrides.title ?? null,
    system_prompt: overrides.system_prompt ?? null,
    parent_session_id: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    status: 'idle',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildOutcomeAdapters', () => {
  let db: DB;
  let store: SqliteSessionStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
  });

  // ---- getSessionGoal -------------------------------------------------------

  it('getSessionGoal returns title when title is non-null', () => {
    insertSession(store, 'sess-1', { title: 'My Goal', system_prompt: 'System' });
    const adapters = buildOutcomeAdapters(store);
    expect(adapters.getSessionGoal('sess-1')).toBe('My Goal');
  });

  it('getSessionGoal falls back to system_prompt when title is null', () => {
    insertSession(store, 'sess-2', { title: null, system_prompt: 'Fallback system prompt' });
    const adapters = buildOutcomeAdapters(store);
    expect(adapters.getSessionGoal('sess-2')).toBe('Fallback system prompt');
  });

  it('getSessionGoal returns null when session not found', () => {
    const adapters = buildOutcomeAdapters(store);
    expect(adapters.getSessionGoal('nonexistent-id')).toBeNull();
  });

  // ---- getRecentMessages ----------------------------------------------------

  it('getRecentMessages maps rows to {role, content}', () => {
    insertSession(store, 'sess-3');
    store.appendMessage('sess-3', 'user', 'Hello');
    store.appendMessage('sess-3', 'assistant', 'Hi there');
    const adapters = buildOutcomeAdapters(store);
    const msgs = adapters.getRecentMessages('sess-3', 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'Hi there' });
  });

  it('getRecentMessages returns [] when sessionId not found', () => {
    const adapters = buildOutcomeAdapters(store);
    expect(adapters.getRecentMessages('no-such-session', 10)).toEqual([]);
  });

  // ---- getToolStats ---------------------------------------------------------

  it('getToolStats counts only role=tool rows', () => {
    insertSession(store, 'sess-4');
    store.appendMessage('sess-4', 'user', 'run tool');
    store.appendMessage('sess-4', 'tool', 'tool output 1');
    store.appendMessage('sess-4', 'assistant', 'done');
    store.appendMessage('sess-4', 'tool', 'tool output 2');
    const adapters = buildOutcomeAdapters(store);
    const stats = adapters.getToolStats('sess-4');
    expect(stats).toEqual({ successCount: 2, failureCount: 0 });
  });

  it('getToolStats returns {0,0} when session has no messages', () => {
    insertSession(store, 'sess-5');
    const adapters = buildOutcomeAdapters(store);
    expect(adapters.getToolStats('sess-5')).toEqual({ successCount: 0, failureCount: 0 });
  });

  it('getToolStats returns {0,0} when store.getMessages throws', () => {
    // Wrap the store in a proxy that throws from getMessages.
    const brokenStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'getMessages') {
          return () => {
            throw new Error('simulated DB failure');
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (target as any)[prop];
      },
    }) as SqliteSessionStore;

    const adapters = buildOutcomeAdapters(brokenStore);
    expect(adapters.getToolStats('any-session')).toEqual({ successCount: 0, failureCount: 0 });
  });
});
