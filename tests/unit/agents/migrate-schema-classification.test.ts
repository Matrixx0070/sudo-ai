/**
 * @file migrate-schema-classification.test.ts
 * @description Tests for migrateSchema error classification (ITEM 4 — security-debt-sweep).
 *
 * Verifies:
 * - Idempotent re-run (column already exists) continues silently.
 * - "no such table" (startup ordering / partial schema) is silenced as benign.
 * - Non-expected error (e.g. disk I/O error) propagates out of migrateSchema.
 * - All 4 columns are added correctly on a fresh database.
 *
 * NOTE: The silence list includes 'no such table' beyond the spec's literal wording.
 * This is intentional — startup ordering can cause migrateSchema to run before a
 * dependent table exists. That is benign, unlike disk-full or SQLITE_BUSY which
 * indicate real I/O failures.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateSchema } from '../../../src/core/agents/config-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      system_text TEXT,
      tools_json TEXT NOT NULL DEFAULT '[]',
      skills_json TEXT NOT NULL DEFAULT '[]',
      mcp_servers_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      archived_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  return db;
}

// ---------------------------------------------------------------------------
// 1. Idempotency — duplicate column is silently ignored
// ---------------------------------------------------------------------------

describe('migrateSchema — duplicate column error silenced', () => {
  it('calling migrateSchema twice does not throw', () => {
    const db = makeBaseDb();
    expect(() => migrateSchema(db)).not.toThrow();
    expect(() => migrateSchema(db)).not.toThrow();
  });

  it('pre-existing "goal" column does not cause an error on migrateSchema', () => {
    const db = makeBaseDb();
    // Manually add the column that migrateSchema will also try to add
    db.exec('ALTER TABLE agents ADD COLUMN goal TEXT');

    // migrateSchema should silently skip the duplicate and apply the remaining columns
    expect(() => migrateSchema(db)).not.toThrow();

    // Other columns should still be present
    db.exec(`INSERT INTO agents (id, name, model) VALUES ('a1', 'Test', 'claude-3')`);
    db.exec(`UPDATE agents SET sandbox_policy_json = '{}' WHERE id = 'a1'`);
    const row = db.prepare('SELECT sandbox_policy_json FROM agents WHERE id = ?').get('a1') as {
      sandbox_policy_json: string;
    };
    expect(row.sandbox_policy_json).toBe('{}');
  });

  it('error message "already has a column named" is silenced', () => {
    const db = makeBaseDb();
    // Simulate what SQLite actually throws for duplicate column in some versions
    const mockExec = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('ADD COLUMN goal')) {
        throw new Error('table agents already has a column named goal');
      }
      // Let other statements through without error
    });
    const originalExec = db.exec.bind(db);
    db.exec = mockExec;

    // The first call may set up columns — restore for the next call
    expect(() => migrateSchema(db)).not.toThrow();
    db.exec = originalExec;
  });

  it('error message "duplicate column name" is silenced', () => {
    const db = makeBaseDb();
    const mockExec = vi.fn().mockImplementation((_sql: string) => {
      throw new Error('duplicate column name: goal');
    });
    db.exec = mockExec;

    expect(() => migrateSchema(db)).not.toThrow();
  });

  it('"no such table" is silenced (startup ordering / partial schema)', () => {
    const db = makeBaseDb();
    const mockExec = vi.fn().mockImplementation((_sql: string) => {
      throw new Error('no such table: sessions');
    });
    db.exec = mockExec;

    // This is benign — table may not have been created yet during migrations
    expect(() => migrateSchema(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Non-expected errors propagate
// ---------------------------------------------------------------------------

describe('migrateSchema — unexpected errors propagate', () => {
  it('disk I/O error propagates out of migrateSchema', () => {
    const db = makeBaseDb();
    const mockExec = vi.fn().mockImplementation((_sql: string) => {
      throw new Error('disk I/O error');
    });
    db.exec = mockExec;

    expect(() => migrateSchema(db)).toThrow('disk I/O error');
  });

  it('SQLITE_BUSY error propagates', () => {
    const db = makeBaseDb();
    const mockExec = vi.fn().mockImplementation((_sql: string) => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    db.exec = mockExec;

    expect(() => migrateSchema(db)).toThrow('SQLITE_BUSY');
  });

  it('read-only filesystem error propagates', () => {
    const db = makeBaseDb();
    const mockExec = vi.fn().mockImplementation((_sql: string) => {
      throw new Error('attempt to write a readonly database');
    });
    db.exec = mockExec;

    expect(() => migrateSchema(db)).toThrow('attempt to write a readonly database');
  });

  it('unexpected error is an instance of Error and propagates correctly', () => {
    const db = makeBaseDb();
    const originalError = new Error('disk I/O error');
    const mockExec = vi.fn().mockImplementation((_sql: string) => {
      throw originalError;
    });
    db.exec = mockExec;

    let caught: unknown;
    try {
      migrateSchema(db);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(originalError);
  });
});

// ---------------------------------------------------------------------------
// 3. Correct columns added on fresh db
// ---------------------------------------------------------------------------

describe('migrateSchema — correct columns added', () => {
  it('adds goal and sandbox_policy_json to agents table', () => {
    const db = makeBaseDb();
    migrateSchema(db);

    db.exec(`INSERT INTO agents (id, name, model) VALUES ('a2', 'Test', 'claude-3')`);
    db.exec(`UPDATE agents SET goal = 'my goal', sandbox_policy_json = '{"enabled":true}' WHERE id = 'a2'`);
    const row = db.prepare('SELECT goal, sandbox_policy_json FROM agents WHERE id = ?').get('a2') as {
      goal: string;
      sandbox_policy_json: string;
    };
    expect(row.goal).toBe('my goal');
    expect(JSON.parse(row.sandbox_policy_json)).toMatchObject({ enabled: true });
  });

  it('adds goal and outcome_json to sessions table', () => {
    const db = makeBaseDb();
    migrateSchema(db);

    db.exec(`INSERT INTO sessions (id) VALUES ('s2')`);
    db.exec(`UPDATE sessions SET goal = 'session goal', outcome_json = '{"outcome":"success"}' WHERE id = 's2'`);
    const row = db.prepare('SELECT goal, outcome_json FROM sessions WHERE id = ?').get('s2') as {
      goal: string;
      outcome_json: string;
    };
    expect(row.goal).toBe('session goal');
    expect(JSON.parse(row.outcome_json)).toMatchObject({ outcome: 'success' });
  });
});
