/**
 * Unit tests for SqliteSessionStore (Wave 4b)
 *
 * Uses an in-memory better-sqlite3 database for isolation.
 * initializeSchema() is called first to set up the base tables,
 * then SqliteSessionStore constructor runs the Wave 4b migrations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../src/core/memory/schema.js';
import {
  SqliteSessionStore,
  SessionStoreError,
  type SessionRow,
} from '../../../src/core/sessions/sqlite-session-store.js';
import { MemoryInjectionError } from '../../../src/core/memory/injection-scanner.js';
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateJsonlToSqlite } from '../../../src/core/sessions/migrate-jsonl.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

function makeStore(db?: Database.Database): { store: SqliteSessionStore; db: Database.Database } {
  const d = db ?? makeDb();
  return { store: new SqliteSessionStore(d), db: d };
}

function makeSession(overrides: Partial<Omit<SessionRow, 'created_at' | 'updated_at'>> = {}): Omit<SessionRow, 'created_at' | 'updated_at'> {
  return {
    session_id:        randomUUID(),
    source_platform:   'telegram',
    user_id:           'user-123',
    model:             'claude-sonnet-4-6',
    system_prompt:     null,
    parent_session_id: null,
    input_tokens:      0,
    output_tokens:     0,
    cost_usd:          0,
    title:             null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. createSession + getSession round-trip
// ---------------------------------------------------------------------------

describe('SqliteSessionStore', () => {

  describe('createSession + getSession round-trip', () => {
    it('inserts a session row and retrieves it', () => {
      const { store } = makeStore();
      const params = makeSession({ title: 'Test session', source_platform: 'slack' });
      store.createSession(params);
      const row = store.getSession(params.session_id);
      expect(row).toBeDefined();
      expect(row!.session_id).toBe(params.session_id);
      expect(row!.title).toBe('Test session');
      expect(row!.source_platform).toBe('slack');
      expect(row!.model).toBe('claude-sonnet-4-6');
    });

    it('returns undefined for unknown session_id', () => {
      const { store } = makeStore();
      expect(store.getSession('nonexistent-uuid')).toBeUndefined();
    });

    it('returns undefined for empty session_id', () => {
      const { store } = makeStore();
      expect(store.getSession('')).toBeUndefined();
    });

    it('stores null fields correctly', () => {
      const { store } = makeStore();
      const params = makeSession({ system_prompt: null, parent_session_id: null, title: null });
      store.createSession(params);
      const row = store.getSession(params.session_id);
      expect(row!.system_prompt).toBeNull();
      expect(row!.parent_session_id).toBeNull();
      expect(row!.title).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. appendMessage increments message count
  // ---------------------------------------------------------------------------

  describe('appendMessage', () => {
    it('increments message count on each call', () => {
      const { store } = makeStore();
      const params = makeSession();
      store.createSession(params);

      expect(store.getMessageCount(params.session_id)).toBe(0);
      store.appendMessage(params.session_id, 'user', 'Hello');
      expect(store.getMessageCount(params.session_id)).toBe(1);
      store.appendMessage(params.session_id, 'assistant', 'Hi there');
      expect(store.getMessageCount(params.session_id)).toBe(2);
    });

    it('returns incrementing message IDs', () => {
      const { store } = makeStore();
      const params = makeSession();
      store.createSession(params);
      const id1 = store.appendMessage(params.session_id, 'user', 'first');
      const id2 = store.appendMessage(params.session_id, 'assistant', 'second');
      expect(id2).toBeGreaterThan(id1);
    });

    it('throws SessionStoreError for missing sessionId', () => {
      const { store } = makeStore();
      expect(() => store.appendMessage('', 'user', 'content')).toThrow(SessionStoreError);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. getMessages
  // ---------------------------------------------------------------------------

  describe('getMessages', () => {
    it('returns messages in chronological order', () => {
      const { store } = makeStore();
      const params = makeSession();
      store.createSession(params);
      store.appendMessage(params.session_id, 'user', 'first');
      store.appendMessage(params.session_id, 'assistant', 'second');
      store.appendMessage(params.session_id, 'user', 'third');

      const msgs = store.getMessages(params.session_id);
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toBe('first');
      expect(msgs[2].content).toBe('third');
    });

    it('respects the limit parameter', () => {
      const { store } = makeStore();
      const params = makeSession();
      store.createSession(params);
      for (let i = 0; i < 10; i++) {
        store.appendMessage(params.session_id, 'user', `msg ${i}`);
      }
      expect(store.getMessages(params.session_id, 3)).toHaveLength(3);
    });

    it('returns empty array for unknown session', () => {
      const { store } = makeStore();
      expect(store.getMessages('unknown')).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. listSessions pagination via afterId cursor
  // ---------------------------------------------------------------------------

  describe('listSessions pagination via afterId cursor', () => {
    it('paginates correctly using afterId', async () => {
      const { store } = makeStore();
      // Create 5 sessions with slight delay to ensure different created_at
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const p = makeSession({ title: `session-${i}`, user_id: 'paginate-user' });
        store.createSession(p);
        ids.push(p.session_id);
        // Ensure distinct created_at timestamps via SQLite default
        await new Promise((r) => setTimeout(r, 2));
      }

      // Get first 3 (most recent)
      const page1 = store.listSessions({ limit: 3, userId: 'paginate-user' });
      expect(page1).toHaveLength(3);

      // Cursor to next page
      const lastId = page1[page1.length - 1].session_id;
      const page2 = store.listSessions({ limit: 3, afterId: lastId, userId: 'paginate-user' });
      expect(page2.length).toBeGreaterThanOrEqual(1);
      expect(page2.length).toBeLessThanOrEqual(2);

      // No overlap between pages
      const page1Ids = new Set(page1.map((r) => r.session_id));
      for (const row of page2) {
        expect(page1Ids.has(row.session_id)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. listSessions filter combinations
  // ---------------------------------------------------------------------------

  describe('listSessions filters', () => {
    beforeEach(() => {
      // Individual tests use their own store
    });

    it('filters by userId', () => {
      const { store } = makeStore();
      store.createSession(makeSession({ user_id: 'alice', source_platform: 'slack' }));
      store.createSession(makeSession({ user_id: 'alice', source_platform: 'telegram' }));
      store.createSession(makeSession({ user_id: 'bob',   source_platform: 'slack' }));

      const aliceSessions = store.listSessions({ userId: 'alice' });
      expect(aliceSessions).toHaveLength(2);
      expect(aliceSessions.every((s) => s.user_id === 'alice')).toBe(true);
    });

    it('filters by platform', () => {
      const { store } = makeStore();
      store.createSession(makeSession({ user_id: 'alice', source_platform: 'slack' }));
      store.createSession(makeSession({ user_id: 'bob',   source_platform: 'slack' }));
      store.createSession(makeSession({ user_id: 'carol', source_platform: 'email' }));

      const slackSessions = store.listSessions({ platform: 'slack' });
      expect(slackSessions).toHaveLength(2);
      expect(slackSessions.every((s) => s.source_platform === 'slack')).toBe(true);
    });

    it('combines userId and platform filters', () => {
      const { store } = makeStore();
      store.createSession(makeSession({ user_id: 'alice', source_platform: 'slack' }));
      store.createSession(makeSession({ user_id: 'alice', source_platform: 'email' }));
      store.createSession(makeSession({ user_id: 'bob',   source_platform: 'slack' }));

      const results = store.listSessions({ userId: 'alice', platform: 'slack' });
      expect(results).toHaveLength(1);
      expect(results[0].user_id).toBe('alice');
      expect(results[0].source_platform).toBe('slack');
    });

    it('respects limit', () => {
      const { store } = makeStore();
      for (let i = 0; i < 10; i++) {
        store.createSession(makeSession());
      }
      expect(store.listSessions({ limit: 3 })).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. searchSessions FTS5 MATCH
  // ---------------------------------------------------------------------------

  describe('searchSessions', () => {
    it('returns sessions matching FTS5 query', () => {
      const { store } = makeStore();
      const p1 = makeSession({ title: 'python session' });
      const p2 = makeSession({ title: 'javascript session' });
      store.createSession(p1);
      store.createSession(p2);
      store.appendMessage(p1.session_id, 'user', 'I love programming in python');
      store.appendMessage(p2.session_id, 'user', 'I prefer javascript frameworks');

      const results = store.searchSessions('python');
      expect(results.some((r) => r.session_id === p1.session_id)).toBe(true);
      expect(results.some((r) => r.session_id === p2.session_id)).toBe(false);
    });

    it('returns empty array when no matches', () => {
      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);
      store.appendMessage(p.session_id, 'user', 'hello world');

      expect(store.searchSessions('xyznosuchmatch')).toHaveLength(0);
    });

    it('returns empty array for empty query', () => {
      const { store } = makeStore();
      expect(store.searchSessions('')).toHaveLength(0);
      expect(store.searchSessions('   ')).toHaveLength(0);
    });

    it('returns deduplicated sessions when multiple messages match', () => {
      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);
      store.appendMessage(p.session_id, 'user', 'banana smoothie');
      store.appendMessage(p.session_id, 'assistant', 'banana is great');

      const results = store.searchSessions('banana');
      expect(results.filter((r) => r.session_id === p.session_id)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. FTS5 metacharacter safety — does not throw on SQL-like special chars
  // ---------------------------------------------------------------------------

  describe('searchSessions FTS5 metacharacter safety', () => {
    it('throws SessionStoreError on FTS5 special chars that cause syntax errors', () => {
      const { store } = makeStore();
      // FTS5 MATCH only evaluates when there is data to match against.
      // Insert a session+message so the FTS5 index is populated.
      const p = makeSession();
      store.createSession(p);
      store.appendMessage(p.session_id, 'user', 'some content for fts test');

      // FTS5 treats % as a syntax error — confirm it is wrapped as SessionStoreError
      expect(() => store.searchSessions('hello%world')).toThrow(SessionStoreError);
      expect(() => store.searchSessions('under%score')).toThrow(SessionStoreError);
    });

    it('allows underscore without throwing (FTS5 treats _ as a word char)', () => {
      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);
      store.appendMessage(p.session_id, 'user', 'some_content here');
      expect(() => store.searchSessions('under_score')).not.toThrow();
    });

    it('single quotes are handled by parameterized query — no SQL injection', () => {
      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);
      store.appendMessage(p.session_id, 'user', 'some content here');
      // Should either return empty results or throw SessionStoreError,
      // but must NOT crash the process or affect table structure
      try {
        store.searchSessions("Robert'); DROP TABLE sessions; --");
      } catch (err) {
        // If it throws, must be SessionStoreError (not a raw DB crash)
        expect(err).toBeInstanceOf(SessionStoreError);
      }
      // Whether it threw or returned [], the sessions table must still exist
      expect(() => store.listSessions()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 8. linkParent FK
  // ---------------------------------------------------------------------------

  describe('linkParent', () => {
    it('sets parent_session_id FK correctly', () => {
      const { store } = makeStore();
      const parent = makeSession();
      const child = makeSession();
      store.createSession(parent);
      store.createSession(child);

      store.linkParent(child.session_id, parent.session_id);

      const row = store.getSession(child.session_id);
      expect(row!.parent_session_id).toBe(parent.session_id);
    });

    it('throws SessionStoreError when parent does not exist', () => {
      const { store } = makeStore();
      const child = makeSession();
      store.createSession(child);

      expect(() => store.linkParent(child.session_id, 'nonexistent-parent')).toThrow(SessionStoreError);
    });

    it('throws SessionStoreError when sessionId is empty', () => {
      const { store } = makeStore();
      expect(() => store.linkParent('', 'some-parent')).toThrow(SessionStoreError);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. deleteSession cascades to messages
  // ---------------------------------------------------------------------------

  describe('deleteSession', () => {
    it('removes the session row', () => {
      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);
      expect(store.getSession(p.session_id)).toBeDefined();
      store.deleteSession(p.session_id);
      expect(store.getSession(p.session_id)).toBeUndefined();
    });

    it('cascades delete to messages', () => {
      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);
      store.appendMessage(p.session_id, 'user', 'will be deleted');
      store.appendMessage(p.session_id, 'assistant', 'also deleted');

      store.deleteSession(p.session_id);
      expect(store.getMessages(p.session_id)).toHaveLength(0);
    });

    it('returns false for nonexistent session', () => {
      const { store } = makeStore();
      expect(store.deleteSession('nonexistent')).toBe(false);
    });

    it('returns true when a row was deleted', () => {
      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);
      expect(store.deleteSession(p.session_id)).toBe(true);
    });

    it('nullifies child parent_session_id instead of leaving dangling reference', () => {
      const { store } = makeStore();
      const parent = makeSession();
      const child = makeSession();
      store.createSession(parent);
      store.createSession(child);
      store.linkParent(child.session_id, parent.session_id);

      // Confirm link is set before deletion
      expect(store.getSession(child.session_id)!.parent_session_id).toBe(parent.session_id);

      // Delete the parent
      store.deleteSession(parent.session_id);

      // Child must still exist with parent_session_id nulled out
      const childAfter = store.getSession(child.session_id);
      expect(childAfter).toBeDefined();
      expect(childAfter!.parent_session_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Migration idempotency — second SqliteSessionStore on same DB is safe
  // ---------------------------------------------------------------------------

  describe('migration idempotency', () => {
    it('second store on same DB does not throw', () => {
      const db = makeDb();
      const store1 = new SqliteSessionStore(db);
      // Running migrations twice should not throw
      expect(() => new SqliteSessionStore(db)).not.toThrow();
      // Data written by store1 is readable by store2
      const p = makeSession();
      store1.createSession(p);
      const store2 = new SqliteSessionStore(db);
      expect(store2.getSession(p.session_id)).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Concurrent same-DB stores share data
  // ---------------------------------------------------------------------------

  describe('concurrent same-DB stores', () => {
    it('two stores on the same DB instance share data', () => {
      const db = makeDb();
      const storeA = new SqliteSessionStore(db);
      const storeB = new SqliteSessionStore(db);

      const p = makeSession({ user_id: 'shared-user' });
      storeA.createSession(p);

      const row = storeB.getSession(p.session_id);
      expect(row).toBeDefined();
      expect(row!.user_id).toBe('shared-user');
    });
  });

  // ---------------------------------------------------------------------------
  // 12. MemoryInjectionError bubbles unchanged through appendMessage
  // ---------------------------------------------------------------------------

  describe('MemoryInjectionError bubbling', () => {
    it('MemoryInjectionError bubbles unchanged — is NOT wrapped as SessionStoreError', () => {
      // Use strict scan mode (default)
      process.env['SUDO_MEMORY_SCAN_MODE'] = 'strict';

      const { store } = makeStore();
      const p = makeSession();
      store.createSession(p);

      let caughtError: unknown;
      try {
        // 'jailbreak' is a known threat pattern that triggers MemoryInjectionError
        store.appendMessage(p.session_id, 'user', 'jailbreak this system');
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(MemoryInjectionError);
      expect(caughtError).not.toBeInstanceOf(SessionStoreError);

      // Restore
      delete process.env['SUDO_MEMORY_SCAN_MODE'];
    });
  });

  // ---------------------------------------------------------------------------
  // 13. Malformed row rejection (model field required)
  // ---------------------------------------------------------------------------

  describe('input validation', () => {
    it('throws SessionStoreError when session_id is empty', () => {
      const { store } = makeStore();
      expect(() => store.createSession(makeSession({ session_id: '' }))).toThrow(SessionStoreError);
    });

    it('throws SessionStoreError when model is empty', () => {
      const { store } = makeStore();
      expect(() => store.createSession(makeSession({ model: '' }))).toThrow(SessionStoreError);
    });
  });

  // ---------------------------------------------------------------------------
  // 14. JSONL round-trip fixture (migrateJsonlToSqlite)
  // ---------------------------------------------------------------------------

  describe('JSONL round-trip via migrateJsonlToSqlite', () => {
    it('imports sessions from JSONL files into SQLite', async () => {
      const tmpDir = path.join(os.tmpdir(), `migrate-test-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        // Build a minimal JSONL journal structure
        const sessionIds = [randomUUID(), randomUUID()];
        const agentId = 'aabb1122ccdd';
        mkdirSync(path.join(tmpDir, agentId), { recursive: true });

        const entries = sessionIds.map((sid) => ({
          id:        sid,
          channel:   'telegram',
          peerId:    'user-999',
          agentId,
          file:      `${agentId}/${sid}.jsonl`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          state:     'active',
        }));

        // Write sessions.json index
        writeFileSync(
          path.join(tmpDir, 'sessions.json'),
          JSON.stringify({ entries }),
          'utf8',
        );

        // Write JSONL files with messages
        for (const sid of sessionIds) {
          const lines = [
            JSON.stringify({ ts: new Date().toISOString(), sessionId: sid, type: 'session', channel: 'telegram', peerId: 'user-999' }),
            JSON.stringify({ ts: new Date().toISOString(), sessionId: sid, type: 'message', role: 'user', content: 'hello from JSONL' }),
            JSON.stringify({ ts: new Date().toISOString(), sessionId: sid, type: 'message', role: 'assistant', content: 'hi back' }),
          ].join('\n') + '\n';
          writeFileSync(path.join(tmpDir, agentId, `${sid}.jsonl`), lines, 'utf8');
        }

        // Migrate
        const db = makeDb();
        const result = await migrateJsonlToSqlite(tmpDir, db);

        expect(result.imported).toBe(2);
        expect(result.skipped).toBe(0);

        const store = new SqliteSessionStore(db);
        for (const sid of sessionIds) {
          const row = store.getSession(sid);
          expect(row).toBeDefined();
          expect(row!.source_platform).toBe('telegram');
          expect(store.getMessageCount(sid)).toBe(2);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // -------------------------------------------------------------------------
    // 15. migrate skip-on-rerun
    // -------------------------------------------------------------------------

    it('skips already-imported sessions on rerun', async () => {
      const tmpDir = path.join(os.tmpdir(), `migrate-rerun-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        const sid = randomUUID();
        const agentId = 'deadbeef0011';
        mkdirSync(path.join(tmpDir, agentId), { recursive: true });

        const entries = [{ id: sid, channel: 'slack', peerId: 'u1', agentId, file: `${agentId}/${sid}.jsonl`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'active' }];
        writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({ entries }), 'utf8');
        const jsonl = [
          JSON.stringify({ ts: new Date().toISOString(), sessionId: sid, type: 'session', channel: 'slack', peerId: 'u1' }),
          JSON.stringify({ ts: new Date().toISOString(), sessionId: sid, type: 'message', role: 'user', content: 'idempotent test' }),
        ].join('\n') + '\n';
        writeFileSync(path.join(tmpDir, agentId, `${sid}.jsonl`), jsonl, 'utf8');

        const db = makeDb();

        const run1 = await migrateJsonlToSqlite(tmpDir, db);
        expect(run1.imported).toBe(1);
        expect(run1.skipped).toBe(0);

        const run2 = await migrateJsonlToSqlite(tmpDir, db);
        expect(run2.imported).toBe(0);
        expect(run2.skipped).toBe(1);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // -------------------------------------------------------------------------
    // 16. path-traversal rejection in migration
    // -------------------------------------------------------------------------

    it('rejects JSONL file paths that escape journalBaseDir', async () => {
      const tmpDir = path.join(os.tmpdir(), `migrate-traversal-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        const sid = randomUUID();
        // Malicious file path that tries to escape base dir
        const maliciousFile = '../../etc/passwd';
        const entries = [{ id: sid, channel: 'telegram', peerId: 'attacker', agentId: 'aaaa', file: maliciousFile, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'active' }];
        writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({ entries }), 'utf8');

        const db = makeDb();
        const result = await migrateJsonlToSqlite(tmpDir, db);

        // Should be skipped, not imported
        expect(result.imported).toBe(0);
        expect(result.skipped).toBe(1);
        // Session should NOT have been created
        const store = new SqliteSessionStore(db);
        expect(store.getSession(sid)).toBeUndefined();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // -------------------------------------------------------------------------
    // 17. symlink escape in migrate-jsonl is refused (POSIX only)
    // -------------------------------------------------------------------------

    it.skipIf(process.platform === 'win32')(
      'refuses a JSONL symlink that points outside journalBaseDir',
      async () => {
        const tmpDir = path.join(os.tmpdir(), `migrate-symlink-${randomUUID()}`);
        const outsideDir = path.join(os.tmpdir(), `migrate-symlink-outside-${randomUUID()}`);
        mkdirSync(tmpDir, { recursive: true });
        mkdirSync(outsideDir, { recursive: true });

        try {
          const sid = randomUUID();
          const agentId = 'symlink-agent';
          mkdirSync(path.join(tmpDir, agentId), { recursive: true });

          // Create a real file outside the base dir
          const outsideFile = path.join(outsideDir, 'secret.jsonl');
          writeFileSync(outsideFile, JSON.stringify({ ts: new Date().toISOString(), sessionId: sid, type: 'session', channel: 'telegram', peerId: 'u1' }) + '\n', 'utf8');

          // Create a symlink inside tmpDir that points to the outside file
          const symlinkPath = path.join(tmpDir, agentId, `${sid}.jsonl`);
          symlinkSync(outsideFile, symlinkPath);

          const entries = [{
            id: sid,
            channel: 'telegram',
            peerId: 'attacker',
            agentId,
            file: `${agentId}/${sid}.jsonl`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: 'active',
          }];
          writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify({ entries }), 'utf8');

          const db = makeDb();
          const result = await migrateJsonlToSqlite(tmpDir, db);

          // Symlink escapes base — must be refused
          expect(result.imported).toBe(0);
          expect(result.skipped).toBe(1);
          const store = new SqliteSessionStore(db);
          expect(store.getSession(sid)).toBeUndefined();
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
          rmSync(outsideDir, { recursive: true, force: true });
        }
      },
    );
  });

});
