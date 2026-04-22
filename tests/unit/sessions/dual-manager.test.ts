/**
 * Unit tests for DualSessionManager.
 *
 * Primary (SQLite) and Journal (JSONL) stores are mocked so no real I/O occurs.
 * Focus: dual-write semantics, non-fatal journal failure, delegated getters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DualSessionManager } from '../../../src/core/sessions/dual-manager.js';
import type { Session } from '../../../src/core/sessions/types.js';

// ---------------------------------------------------------------------------
// Helpers — minimal mock factories
// ---------------------------------------------------------------------------

function makeSession(id = 'sess-001', channel = 'telegram', peerId = 'user-1'): Session {
  return {
    id,
    channel: channel as Session['channel'],
    peerId,
    state: 'active',
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makePrimaryMock() {
  return {
    get: vi.fn(async (id: string): Promise<Session | undefined> => (id === 'sess-001' ? makeSession() : undefined)),
    save: vi.fn(async (_s: Session) => {}),
    archive: vi.fn(async (_id: string) => {}),
    getOrCreate: vi.fn(async (channel: string, peerId: string): Promise<Session> => makeSession('sess-001', channel, peerId)),
    peerQueue: { enqueue: vi.fn(async (_k: string, fn: () => Promise<unknown>) => fn()) },
    scopeMode: 'main' as const,
    cacheSize: 3,
  };
}

function makeJournalMock() {
  return {
    get: vi.fn(async (_id: string): Promise<Session | undefined> => undefined),
    save: vi.fn(async (_s: Session) => {}),
    archive: vi.fn(async (_id: string) => {}),
    getOrCreate: vi.fn(async (channel: string, peerId: string): Promise<Session> => makeSession('j-001', channel, peerId)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DualSessionManager', () => {
  let primary: ReturnType<typeof makePrimaryMock>;
  let journal: ReturnType<typeof makeJournalMock>;
  let dual: DualSessionManager;

  beforeEach(() => {
    primary = makePrimaryMock();
    journal = makeJournalMock();
    dual = new DualSessionManager(
      primary as unknown as import('../../../src/core/sessions/manager.js').SessionManager,
      journal as unknown as import('../../../src/core/sessions/journal-store.js').JournalSessionStore,
    );
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('throws TypeError when primary is null', () => {
      expect(() => new DualSessionManager(
        null as never,
        journal as never,
      )).toThrow(TypeError);
    });

    it('throws TypeError when journal is null', () => {
      expect(() => new DualSessionManager(
        primary as never,
        null as never,
      )).toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // get — reads from primary only
  // -------------------------------------------------------------------------

  describe('get()', () => {
    it('calls primary.get() and returns its result', async () => {
      const result = await dual.get('sess-001');
      expect(primary.get).toHaveBeenCalledWith('sess-001');
      expect(result).toBeDefined();
      expect(result?.id).toBe('sess-001');
    });

    it('does NOT call journal.get()', async () => {
      await dual.get('sess-001');
      expect(journal.get).not.toHaveBeenCalled();
    });

    it('returns undefined for unknown session id', async () => {
      const result = await dual.get('non-existent');
      expect(result).toBeUndefined();
    });

    it('throws TypeError when sessionId is empty', async () => {
      await expect(dual.get('')).rejects.toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // save — dual write: primary + journal
  // -------------------------------------------------------------------------

  describe('save()', () => {
    it('calls primary.save() first', async () => {
      const session = makeSession();
      await dual.save(session);
      expect(primary.save).toHaveBeenCalledWith(session);
    });

    it('calls journal.save() after primary succeeds', async () => {
      const session = makeSession();
      await dual.save(session);
      expect(journal.save).toHaveBeenCalledWith(session);
    });

    it('propagates primary save failure (throws)', async () => {
      primary.save.mockRejectedValueOnce(new Error('primary DB down'));
      const session = makeSession();
      await expect(dual.save(session)).rejects.toThrow('primary DB down');
    });

    it('does NOT throw when journal save fails (non-fatal)', async () => {
      journal.save.mockRejectedValueOnce(new Error('journal disk full'));
      const session = makeSession();
      await expect(dual.save(session)).resolves.not.toThrow();
    });

    it('still calls primary.save() even after journal previously errored', async () => {
      journal.save.mockRejectedValueOnce(new Error('journal error'));
      const s1 = makeSession('sess-001');
      await dual.save(s1);

      const s2 = makeSession('sess-002');
      await dual.save(s2);
      expect(primary.save).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // archive — dual write: primary + journal
  // -------------------------------------------------------------------------

  describe('archive()', () => {
    it('calls primary.archive() first', async () => {
      await dual.archive('sess-001');
      expect(primary.archive).toHaveBeenCalledWith('sess-001');
    });

    it('calls journal.archive() after primary succeeds', async () => {
      await dual.archive('sess-001');
      expect(journal.archive).toHaveBeenCalledWith('sess-001');
    });

    it('propagates primary archive failure', async () => {
      primary.archive.mockRejectedValueOnce(new Error('primary error'));
      await expect(dual.archive('sess-001')).rejects.toThrow('primary error');
    });

    it('does NOT throw when journal archive fails (non-fatal)', async () => {
      journal.archive.mockRejectedValueOnce(new Error('journal error'));
      await expect(dual.archive('sess-001')).resolves.not.toThrow();
    });

    it('throws TypeError when sessionId is empty', async () => {
      await expect(dual.archive('')).rejects.toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // getOrCreate — primary is authoritative, journal mirrors
  // -------------------------------------------------------------------------

  describe('getOrCreate()', () => {
    it('returns the session from primary (not from journal)', async () => {
      const result = await dual.getOrCreate('telegram', 'user-gc');
      expect(result.id).toBe('sess-001'); // primary mock returns 'sess-001'
    });

    it('calls primary.getOrCreate()', async () => {
      await dual.getOrCreate('telegram', 'user-gc');
      expect(primary.getOrCreate).toHaveBeenCalledWith('telegram', 'user-gc');
    });

    it('also calls journal.getOrCreate() to mirror', async () => {
      await dual.getOrCreate('telegram', 'user-gc');
      expect(journal.getOrCreate).toHaveBeenCalledWith('telegram', 'user-gc');
    });

    it('does NOT throw when journal getOrCreate fails (non-fatal)', async () => {
      journal.getOrCreate.mockRejectedValueOnce(new Error('journal error'));
      await expect(dual.getOrCreate('telegram', 'user-gc')).resolves.not.toThrow();
    });

    it('propagates primary getOrCreate failure', async () => {
      primary.getOrCreate.mockRejectedValueOnce(new Error('primary failed'));
      await expect(dual.getOrCreate('telegram', 'user-gc')).rejects.toThrow('primary failed');
    });

    it('throws TypeError when channel is empty', async () => {
      await expect(dual.getOrCreate('' as 'telegram', 'user-x')).rejects.toThrow(TypeError);
    });

    it('throws TypeError when peerId is empty', async () => {
      await expect(dual.getOrCreate('telegram', '')).rejects.toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // Delegated getters — primary only
  // -------------------------------------------------------------------------

  describe('delegated getters', () => {
    it('peerQueue returns primary.peerQueue', () => {
      expect(dual.peerQueue).toBe(primary.peerQueue);
    });

    it('scopeMode returns primary.scopeMode', () => {
      expect(dual.scopeMode).toBe('main');
    });

    it('cacheSize returns primary.cacheSize', () => {
      expect(dual.cacheSize).toBe(3);
    });
  });
});
