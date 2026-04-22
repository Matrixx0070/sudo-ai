/**
 * @file state-machine.test.ts
 * @description Tests for SessionStateMachine (Wave 5).
 *
 * Uses in-memory better-sqlite3 with the base sessions schema.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { SessionStateMachine, SessionStateError } from '../../src/core/sessions/state-machine.js';
import { SqliteSessionStore } from '../../src/core/sessions/sqlite-session-store.js';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function makeDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Base sessions table (from src/core/memory/schema.ts)
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

  // Base messages table
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

function makeStateMachine(db: DB): SessionStateMachine {
  return new SessionStateMachine(db);
}

function insertSession(store: SqliteSessionStore, id: string): void {
  store.createSession({
    session_id: id,
    model: 'test-model',
    user_id: 'user1',
    source_platform: 'test',
    title: null,
    system_prompt: null,
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

describe('SessionStateMachine', () => {
  let db: DB;
  let store: SqliteSessionStore;
  let sm: SessionStateMachine;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
    sm = makeStateMachine(db);
  });

  // ---- getState ----

  it('getState returns idle for a newly created session', () => {
    insertSession(store, 'sess-1');
    expect(sm.getState('sess-1')).toBe('idle');
  });

  it('getState throws SessionStateError for unknown session', () => {
    expect(() => sm.getState('nonexistent')).toThrow(SessionStateError);
  });

  it('getState throws with code session_state_not_found for unknown session', () => {
    try {
      sm.getState('nonexistent');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionStateError);
      expect((err as SessionStateError).code).toBe('session_state_not_found');
    }
  });

  // ---- Valid transitions ----

  it('idle → running is valid', () => {
    insertSession(store, 'sess-2');
    expect(() => sm.transition('sess-2', 'running')).not.toThrow();
    expect(sm.getState('sess-2')).toBe('running');
  });

  it('running → idle is valid (loop)', () => {
    insertSession(store, 'sess-3');
    sm.transition('sess-3', 'running');
    sm.transition('sess-3', 'idle');
    expect(sm.getState('sess-3')).toBe('idle');
  });

  it('idle → rescheduling is valid', () => {
    insertSession(store, 'sess-4');
    sm.transition('sess-4', 'rescheduling');
    expect(sm.getState('sess-4')).toBe('rescheduling');
  });

  it('rescheduling → idle is valid', () => {
    insertSession(store, 'sess-5');
    sm.transition('sess-5', 'rescheduling');
    sm.transition('sess-5', 'idle');
    expect(sm.getState('sess-5')).toBe('idle');
  });

  it('any state → terminated is valid', () => {
    insertSession(store, 'sess-6');
    sm.transition('sess-6', 'running');
    sm.transition('sess-6', 'terminated');
    expect(sm.getState('sess-6')).toBe('terminated');
  });

  it('any state → archived is valid', () => {
    insertSession(store, 'sess-7');
    sm.transition('sess-7', 'archived');
    expect(sm.getState('sess-7')).toBe('archived');
  });

  // ---- Terminal states ----

  it('terminated is a terminal state — no further transitions', () => {
    insertSession(store, 'sess-8');
    sm.transition('sess-8', 'terminated');
    expect(() => sm.transition('sess-8', 'idle')).toThrow(SessionStateError);
  });

  it('archived is a terminal state — no further transitions', () => {
    insertSession(store, 'sess-9');
    sm.transition('sess-9', 'archived');
    expect(() => sm.transition('sess-9', 'running')).toThrow(SessionStateError);
  });

  it('terminated → archived throws with code session_state_invalid_transition', () => {
    insertSession(store, 'sess-10');
    sm.transition('sess-10', 'terminated');
    try {
      sm.transition('sess-10', 'archived');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionStateError);
      expect((err as SessionStateError).code).toBe('session_state_invalid_transition');
    }
  });

  // ---- Invalid transitions ----

  it('running → rescheduling throws (invalid)', () => {
    insertSession(store, 'sess-11');
    sm.transition('sess-11', 'running');
    expect(() => sm.transition('sess-11', 'rescheduling')).toThrow(SessionStateError);
  });

  // ---- No-op same-state ----

  it('transitioning to same state is a no-op (no throw)', () => {
    insertSession(store, 'sess-12');
    expect(() => sm.transition('sess-12', 'idle')).not.toThrow();
    expect(sm.getState('sess-12')).toBe('idle');
  });

  // ---- Events ----

  it('emits session:status:<state> hook after transition', () => {
    insertSession(store, 'sess-13');
    const received: unknown[] = [];
    sm.on('session:status:running', (payload) => received.push(payload));
    sm.transition('sess-13', 'running');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sessionId: 'sess-13', from: 'idle', to: 'running' });
  });

  it('isTerminal returns true for terminated and archived', () => {
    expect(sm.isTerminal('terminated')).toBe(true);
    expect(sm.isTerminal('archived')).toBe(true);
  });

  it('isTerminal returns false for idle, running, rescheduling', () => {
    expect(sm.isTerminal('idle')).toBe(false);
    expect(sm.isTerminal('running')).toBe(false);
    expect(sm.isTerminal('rescheduling')).toBe(false);
  });

  // ---- SessionStateError HTTP status ----

  it('SessionStateError has httpStatus 409', () => {
    insertSession(store, 'sess-14');
    sm.transition('sess-14', 'terminated');
    try {
      sm.transition('sess-14', 'idle');
    } catch (err) {
      expect((err as SessionStateError).httpStatus).toBe(409);
    }
  });
});
