/**
 * @file tests/api/sessions-db-utils.test.ts
 * @description tableExists and parseSessionMetas against a real in-memory better-sqlite3 db.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { tableExists, parseSessionMetas } from '../../src/core/api/admin/sessions.db-utils.js';

describe('tableExists', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE chunks (text TEXT)');
  });
  afterAll(() => { db.close(); });

  it('SDB-1: true for an existing table, false otherwise', () => {
    expect(tableExists(db, 'chunks')).toBe(true);
    expect(tableExists(db, 'messages')).toBe(false);
  });

  it('SDB-2: table name is bound as a parameter, not interpolated', () => {
    expect(tableExists(db, "chunks'; DROP TABLE chunks; --")).toBe(false);
    expect(tableExists(db, 'chunks')).toBe(true);
  });
});

describe('parseSessionMetas', () => {
  it('SDB-3: keeps the first (most recent) version per id and skips malformed rows', () => {
    const meta = (id: string, state: string) =>
      JSON.stringify({ id, channel: 'cli', peerId: 'p1', state, createdAt: 't0', updatedAt: 't1' });
    const rows = [
      { text: meta('s1', 'active') },
      { text: 'not json' },
      { text: meta('s1', 'archived') },
      { text: JSON.stringify({ id: 's2' }) },
      { text: meta('s2', 'compacted') },
    ];
    const metas = parseSessionMetas(rows);
    expect(metas.map((m) => [m.id, m.state])).toEqual([['s1', 'active'], ['s2', 'compacted']]);
  });
});
