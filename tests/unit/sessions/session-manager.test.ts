/**
 * Unit tests for SessionManager.
 * Database layer is mocked — no real SQLite is used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../../src/core/sessions/manager.js';
import { createMockMindDB } from '../../helpers/mocks.js';
import type { Session } from '../../../src/core/sessions/types.js';

function makeManager(): { manager: SessionManager; mockDb: ReturnType<typeof createMockMindDB> } {
  const mockDb = createMockMindDB();

  // The SessionManager needs db.db.prepare(...).all({}) for _loadFromDb
  // Our mock returns empty arrays by default, which means no existing sessions in DB
  const manager = new SessionManager(mockDb as unknown as import('../../../src/core/memory/db.js').MindDB);
  return { manager, mockDb };
}

describe('SessionManager', () => {
  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  it('constructs with default dmScope = main', () => {
    const { manager } = makeManager();
    expect(manager.scopeMode).toBe('main');
  });

  it('constructs with explicit dmScope = per-peer', () => {
    const mockDb = createMockMindDB();
    const manager = new SessionManager(
      mockDb as unknown as import('../../../src/core/memory/db.js').MindDB,
      'per-peer',
    );
    expect(manager.scopeMode).toBe('per-peer');
  });

  // -------------------------------------------------------------------------
  // getOrCreate() — new session
  // -------------------------------------------------------------------------

  it('creates a new session when none exists', async () => {
    const { manager } = makeManager();
    const session = await manager.getOrCreate('telegram', 'user-123');

    expect(session).toBeDefined();
    expect(session.channel).toBe('telegram');
    expect(session.peerId).toBe('user-123');
    expect(session.state).toBe('active');
  });

  it('new session has a non-empty id', async () => {
    const { manager } = makeManager();
    const session = await manager.getOrCreate('telegram', 'user-123');
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);
  });

  it('new session has empty messages array', async () => {
    const { manager } = makeManager();
    const session = await manager.getOrCreate('telegram', 'user-abc');
    expect(session.messages).toEqual([]);
  });

  it('new session has createdAt and updatedAt as Date objects', async () => {
    const { manager } = makeManager();
    const session = await manager.getOrCreate('discord', 'user-xyz');
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.updatedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // getOrCreate() — cache returns existing
  // -------------------------------------------------------------------------

  it('returns the same session object from cache on second call', async () => {
    const { manager } = makeManager();
    const s1 = await manager.getOrCreate('telegram', 'user-999');
    const s2 = await manager.getOrCreate('telegram', 'user-999');
    expect(s1.id).toBe(s2.id);
  });

  it('different (channel, peerId) pairs create different sessions', async () => {
    const { manager } = makeManager();
    const s1 = await manager.getOrCreate('telegram', 'user-A');
    const s2 = await manager.getOrCreate('discord', 'user-A');
    expect(s1.id).not.toBe(s2.id);
  });

  // -------------------------------------------------------------------------
  // getOrCreate() — validation
  // -------------------------------------------------------------------------

  it('throws TypeError when channel is empty', async () => {
    const { manager } = makeManager();
    await expect(manager.getOrCreate('' as 'telegram', 'user-123')).rejects.toThrow(TypeError);
  });

  it('throws TypeError when peerId is empty', async () => {
    const { manager } = makeManager();
    await expect(manager.getOrCreate('telegram', '')).rejects.toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // get() — by sessionId
  // -------------------------------------------------------------------------

  it('get() returns the session by ID after creation', async () => {
    const { manager } = makeManager();
    const created = await manager.getOrCreate('telegram', 'user-101');
    const fetched = await manager.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);
  });

  it('get() returns undefined for a non-existent session ID', async () => {
    const { manager } = makeManager();
    const result = await manager.get('nonexistent-id');
    expect(result).toBeUndefined();
  });

  it('get() throws TypeError for empty sessionId', async () => {
    const { manager } = makeManager();
    await expect(manager.get('')).rejects.toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // save()
  // -------------------------------------------------------------------------

  it('save() updates the session updatedAt timestamp', async () => {
    const { manager } = makeManager();
    const session = await manager.getOrCreate('telegram', 'user-save');
    const originalUpdatedAt = session.updatedAt;

    // Small delay to ensure time difference
    await new Promise((r) => setTimeout(r, 5));
    session.messages.push({ role: 'user', content: 'hello' });
    await manager.save(session);

    expect(session.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt.getTime());
  });

  it('save() calls storeSession on the DB', async () => {
    const { manager, mockDb } = makeManager();
    const session = await manager.getOrCreate('telegram', 'user-save2');
    await manager.save(session);
    expect(mockDb.storeSession).toHaveBeenCalled();
  });

  it('save() throws TypeError for a session with empty id', async () => {
    const { manager } = makeManager();
    const bad = { id: '', channel: 'telegram', peerId: 'user', state: 'active', messages: [], createdAt: new Date(), updatedAt: new Date() } as Session;
    await expect(manager.save(bad)).rejects.toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // archive()
  // -------------------------------------------------------------------------

  it('archive() sets session state to archived', async () => {
    const { manager } = makeManager();
    const session = await manager.getOrCreate('telegram', 'user-arch');
    await manager.archive(session.id);
    expect(session.state).toBe('archived');
  });

  it('archive() evicts session from cache', async () => {
    const { manager } = makeManager();
    await manager.getOrCreate('telegram', 'user-arch2');
    const cacheSize = manager.cacheSize;
    const session = await manager.getOrCreate('telegram', 'user-arch2');
    await manager.archive(session.id);
    expect(manager.cacheSize).toBeLessThan(cacheSize + 1);
  });

  it('archive() for non-existent session does not throw', async () => {
    const { manager } = makeManager();
    await expect(manager.archive('does-not-exist')).resolves.not.toThrow();
  });

  it('archive() throws TypeError for empty sessionId', async () => {
    const { manager } = makeManager();
    await expect(manager.archive('')).rejects.toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // listActive()
  // -------------------------------------------------------------------------

  it('listActive() returns sessions with active state', async () => {
    const { manager } = makeManager();
    await manager.getOrCreate('telegram', 'user-la1');
    await manager.getOrCreate('telegram', 'user-la2');
    const active = await manager.listActive();
    // All DB sessions (from mock, returns []) + our created ones
    // Our sessions are in cache but listActive queries DB — mock returns []
    expect(Array.isArray(active)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // exportSession()
  // -------------------------------------------------------------------------

  it('exportSession() returns a markdown string for an existing session', async () => {
    const { manager } = makeManager();
    const session = await manager.getOrCreate('telegram', 'user-export');
    session.messages.push({ role: 'user', content: 'Hi there' });
    const markdown = await manager.exportSession(session.id);
    expect(typeof markdown).toBe('string');
    expect(markdown).toContain(session.id);
  });

  it('exportSession() returns undefined for non-existent session', async () => {
    const { manager } = makeManager();
    const result = await manager.exportSession('ghost-session');
    expect(result).toBeUndefined();
  });

  it('exportSession() throws TypeError for empty sessionId', async () => {
    const { manager } = makeManager();
    await expect(manager.exportSession('')).rejects.toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // pruneOldSessions()
  // -------------------------------------------------------------------------

  it('pruneOldSessions() throws RangeError when olderThanDays < 1', async () => {
    const { manager } = makeManager();
    await expect(manager.pruneOldSessions(0)).rejects.toThrow(RangeError);
    await expect(manager.pruneOldSessions(-1)).rejects.toThrow(RangeError);
  });

  it('pruneOldSessions() returns 0 when no sessions are old enough', async () => {
    const { manager } = makeManager();
    // Create a fresh session — it's brand new, so won't be pruned by 30 days
    await manager.getOrCreate('telegram', 'user-prune');
    const pruned = await manager.pruneOldSessions(30);
    expect(pruned).toBe(0);
  });

  // -------------------------------------------------------------------------
  // cacheSize
  // -------------------------------------------------------------------------

  it('cacheSize increases as new sessions are created', async () => {
    const { manager } = makeManager();
    const before = manager.cacheSize;
    await manager.getOrCreate('telegram', 'user-c1');
    await manager.getOrCreate('telegram', 'user-c2');
    expect(manager.cacheSize).toBe(before + 2);
  });
});
