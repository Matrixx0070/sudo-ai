/**
 * Unit tests for JournalSessionStore.
 *
 * Uses a real temp directory (os.tmpdir()) so we exercise actual filesystem
 * behaviour without touching production data.  Each test gets its own
 * isolated sub-directory via a unique nanoid so tests never share state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { JournalSessionStore } from '../../../src/core/sessions/journal-store.js';
import type { JournalMessage, JournalSessionCreated } from '../../../src/core/sessions/journal-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `journal-test-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStore(dir: string): JournalSessionStore {
  return new JournalSessionStore(dir);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('JournalSessionStore', () => {
  let tempDir: string;
  let store: JournalSessionStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = makeStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates the base directory when it does not exist', () => {
      const newDir = path.join(os.tmpdir(), `journal-new-${nanoid()}`);
      new JournalSessionStore(newDir);
      expect(existsSync(newDir)).toBe(true);
      rmSync(newDir, { recursive: true, force: true });
    });

    it('uses ~/.sudo-ai/sessions when no baseDir is provided', () => {
      // Just verify construction does not throw; we cannot safely write to
      // the real home directory in tests so we only check the object is created.
      expect(() => new JournalSessionStore()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getOrCreate
  // -------------------------------------------------------------------------

  describe('getOrCreate', () => {
    it('creates a new session with the correct channel and peerId', async () => {
      const session = await store.getOrCreate('telegram', 'user-100');
      expect(session.channel).toBe('telegram');
      expect(session.peerId).toBe('user-100');
    });

    it('new session has state = active', async () => {
      const session = await store.getOrCreate('telegram', 'user-101');
      expect(session.state).toBe('active');
    });

    it('new session has an empty messages array', async () => {
      const session = await store.getOrCreate('discord', 'user-empty');
      expect(session.messages).toEqual([]);
    });

    it('new session has a non-empty id', async () => {
      const session = await store.getOrCreate('web', 'peer-xyz');
      expect(typeof session.id).toBe('string');
      expect(session.id.length).toBeGreaterThan(0);
    });

    it('returns the SAME session (by id) on a second call with the same peer', async () => {
      const s1 = await store.getOrCreate('telegram', 'user-same');
      const s2 = await store.getOrCreate('telegram', 'user-same');
      expect(s1.id).toBe(s2.id);
    });

    it('different (channel, peerId) pairs produce different sessions', async () => {
      const s1 = await store.getOrCreate('telegram', 'user-A');
      const s2 = await store.getOrCreate('discord', 'user-A');
      expect(s1.id).not.toBe(s2.id);
    });

    it('throws TypeError when channel is empty', async () => {
      await expect(store.getOrCreate('' as 'telegram', 'peer')).rejects.toThrow(TypeError);
    });

    it('throws TypeError when peerId is empty', async () => {
      await expect(store.getOrCreate('telegram', '')).rejects.toThrow(TypeError);
    });

    it('writes a sessions.json index file on first create', async () => {
      await store.getOrCreate('telegram', 'user-idx');
      expect(existsSync(path.join(tempDir, 'sessions.json'))).toBe(true);
    });

    it('creates a .jsonl file for the new session', async () => {
      const session = await store.getOrCreate('slack', 'user-jsonl');
      // The JSONL file should exist somewhere under tempDir
      const indexPath = path.join(tempDir, 'sessions.json');
      const index = JSON.parse(require('node:fs').readFileSync(indexPath, 'utf8'));
      const entry = index.entries.find((e: { id: string }) => e.id === session.id);
      expect(entry).toBeDefined();
      expect(existsSync(path.join(tempDir, entry.file))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  describe('get', () => {
    it('returns the session by id after creation', async () => {
      const created = await store.getOrCreate('telegram', 'user-get');
      const fetched = await store.get(created.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(created.id);
    });

    it('returns undefined for a non-existent session id', async () => {
      const result = await store.get('definitely-not-there');
      expect(result).toBeUndefined();
    });

    it('throws TypeError when sessionId is empty', async () => {
      await expect(store.get('')).rejects.toThrow(TypeError);
    });

    it('returns undefined gracefully when the .jsonl file is missing', async () => {
      // Create a valid session, then delete its JSONL file
      const session = await store.getOrCreate('telegram', 'user-missing-file');
      const indexRaw = require('node:fs').readFileSync(path.join(tempDir, 'sessions.json'), 'utf8');
      const index = JSON.parse(indexRaw);
      const entry = index.entries.find((e: { id: string }) => e.id === session.id);
      rmSync(path.join(tempDir, entry.file));

      const result = await store.get(session.id);
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // appendEvent
  // -------------------------------------------------------------------------

  describe('appendEvent', () => {
    it('appending a message event makes it readable via get()', async () => {
      const session = await store.getOrCreate('telegram', 'user-append');

      const event: JournalMessage = {
        ts: new Date().toISOString(),
        sessionId: session.id,
        type: 'message',
        role: 'user',
        content: 'Hello journal',
      };
      await store.appendEvent(session.id, event);

      const refreshed = await store.get(session.id);
      expect(refreshed?.messages).toHaveLength(1);
      expect(refreshed?.messages[0]?.content).toBe('Hello journal');
    });

    it('multiple appended messages are all present in order', async () => {
      const session = await store.getOrCreate('telegram', 'user-multi-append');

      for (let i = 0; i < 3; i++) {
        const ev: JournalMessage = {
          ts: new Date().toISOString(),
          sessionId: session.id,
          type: 'message',
          role: 'user',
          content: `Message ${i}`,
        };
        await store.appendEvent(session.id, ev);
      }

      const refreshed = await store.get(session.id);
      expect(refreshed?.messages).toHaveLength(3);
      expect(refreshed?.messages[2]?.content).toBe('Message 2');
    });

    it('non-message event types are appended but not reflected in messages[]', async () => {
      const session = await store.getOrCreate('telegram', 'user-toolresult');

      const toolResult = {
        ts: new Date().toISOString(),
        sessionId: session.id,
        type: 'toolResult' as const,
        toolCallId: 'call-1',
        toolName: 'some.tool',
        success: true,
        output: 'done',
      };
      await store.appendEvent(session.id, toolResult);

      const refreshed = await store.get(session.id);
      // toolResult events don't map to messages
      expect(refreshed?.messages).toHaveLength(0);
    });

    it('does not throw when sessionId is not in index (silently ignores)', async () => {
      await expect(
        store.appendEvent('not-in-index', {
          ts: new Date().toISOString(),
          sessionId: 'not-in-index',
          type: 'message',
          role: 'user',
          content: 'orphan',
        }),
      ).resolves.not.toThrow();
    });

    it('throws TypeError when sessionId is empty', async () => {
      await expect(
        store.appendEvent('', {
          ts: new Date().toISOString(),
          sessionId: '',
          type: 'message',
          role: 'user',
          content: 'empty id',
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------

  describe('save', () => {
    it('save() persists the last message to the JSONL file', async () => {
      const session = await store.getOrCreate('telegram', 'user-save');
      session.messages.push({ role: 'assistant', content: 'Hi from assistant' });
      await store.save(session);

      const refreshed = await store.get(session.id);
      expect(refreshed?.messages).toHaveLength(1);
      expect(refreshed?.messages[0]?.content).toBe('Hi from assistant');
    });

    it('save() with empty messages array does not throw', async () => {
      const session = await store.getOrCreate('telegram', 'user-save-empty');
      // No messages pushed
      await expect(store.save(session)).resolves.not.toThrow();
    });

    it('save() for a non-existent session (not in index) does not throw', async () => {
      const orphan = {
        id: 'orphan-id',
        channel: 'telegram' as const,
        peerId: 'peer-x',
        state: 'active' as const,
        messages: [{ role: 'user' as const, content: 'hello' }],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await expect(store.save(orphan)).resolves.not.toThrow();
    });

    it('save() throws TypeError for session with empty id', async () => {
      const bad = {
        id: '',
        channel: 'telegram' as const,
        peerId: 'peer',
        state: 'active' as const,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await expect(store.save(bad)).rejects.toThrow(TypeError);
    });

    it('save() throws TypeError for session with empty channel', async () => {
      const bad = {
        id: 'some-id',
        channel: '' as 'telegram',
        peerId: 'peer',
        state: 'active' as const,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await expect(store.save(bad)).rejects.toThrow(TypeError);
    });

    it('save() sets session state to archived in index when session.state = archived', async () => {
      const session = await store.getOrCreate('telegram', 'user-save-arch');
      session.state = 'archived';
      await store.save(session);

      const entries = await store.listSessions();
      const entry = entries.find((e) => e.id === session.id);
      expect(entry?.state).toBe('archived');
    });
  });

  // -------------------------------------------------------------------------
  // archive
  // -------------------------------------------------------------------------

  describe('archive', () => {
    it('archive() sets entry state to archived in the index', async () => {
      const session = await store.getOrCreate('telegram', 'user-arch');
      await store.archive(session.id);

      const entries = await store.listSessions();
      const entry = entries.find((e) => e.id === session.id);
      expect(entry?.state).toBe('archived');
    });

    it('archive() for a non-existent session does not throw', async () => {
      await expect(store.archive('ghost-session')).resolves.not.toThrow();
    });

    it('throws TypeError when sessionId is empty', async () => {
      await expect(store.archive('')).rejects.toThrow(TypeError);
    });

    it('archive() updates updatedAt timestamp in the index', async () => {
      const session = await store.getOrCreate('telegram', 'user-arch-time');
      const entries = await store.listSessions();
      const before = entries.find((e) => e.id === session.id)?.updatedAt ?? '';

      await new Promise((r) => setTimeout(r, 5));
      await store.archive(session.id);

      const after = await store.listSessions();
      const entry = after.find((e) => e.id === session.id);
      expect(new Date(entry?.updatedAt ?? '').getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // listSessions
  // -------------------------------------------------------------------------

  describe('listSessions', () => {
    it('returns empty array when no sessions exist', async () => {
      const sessions = await store.listSessions();
      expect(sessions).toEqual([]);
    });

    it('returns all sessions when no agentId filter is provided', async () => {
      await store.getOrCreate('telegram', 'peer-1');
      await store.getOrCreate('telegram', 'peer-2');
      const all = await store.listSessions();
      expect(all.length).toBe(2);
    });

    it('filters sessions by agentId when provided', async () => {
      const s1 = await store.getOrCreate('telegram', 'peer-filter-1');
      await store.getOrCreate('discord', 'peer-filter-other');

      // Compute the agentId for telegram:peer-filter-1
      const { createHash } = await import('node:crypto');
      const agentId = createHash('sha256')
        .update('telegram:peer-filter-1')
        .digest('hex')
        .slice(0, 12);

      const filtered = await store.listSessions(agentId);
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.id).toBe(s1.id);
    });

    it('returns correct session count after archiving', async () => {
      const s1 = await store.getOrCreate('telegram', 'peer-list-a');
      await store.getOrCreate('telegram', 'peer-list-b');
      await store.archive(s1.id);

      const all = await store.listSessions();
      // listSessions returns ALL entries regardless of state
      expect(all.length).toBe(2);
      const archivedEntry = all.find((e) => e.id === s1.id);
      expect(archivedEntry?.state).toBe('archived');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: corrupt index file
  // -------------------------------------------------------------------------

  describe('corrupt index recovery', () => {
    it('returns empty list when sessions.json is corrupt JSON', async () => {
      const indexPath = path.join(tempDir, 'sessions.json');
      writeFileSync(indexPath, 'NOT-VALID-JSON!!!', 'utf8');

      const freshStore = makeStore(tempDir);
      const sessions = await freshStore.listSessions();
      expect(sessions).toEqual([]);
    });

    it('returns empty list when sessions.json has wrong structure', async () => {
      const indexPath = path.join(tempDir, 'sessions.json');
      writeFileSync(indexPath, JSON.stringify({ version: 1, entries: 'not-an-array' }), 'utf8');

      const freshStore = makeStore(tempDir);
      const sessions = await freshStore.listSessions();
      expect(sessions).toEqual([]);
    });

    it('getOrCreate still works after a corrupt index file', async () => {
      const indexPath = path.join(tempDir, 'sessions.json');
      writeFileSync(indexPath, '{"broken":true', 'utf8');

      const freshStore = makeStore(tempDir);
      const session = await freshStore.getOrCreate('telegram', 'user-recover');
      expect(session).toBeDefined();
      expect(session.channel).toBe('telegram');
    });
  });

  // -------------------------------------------------------------------------
  // Malformed JSONL lines — hydration robustness
  // -------------------------------------------------------------------------

  describe('malformed JSONL lines', () => {
    it('skips malformed lines and still returns valid messages', async () => {
      const session = await store.getOrCreate('telegram', 'user-malformed');

      // Append a valid message first
      await store.appendEvent(session.id, {
        ts: new Date().toISOString(),
        sessionId: session.id,
        type: 'message',
        role: 'user',
        content: 'Valid message',
      });

      // Manually inject a malformed line into the JSONL
      const indexRaw = require('node:fs').readFileSync(path.join(tempDir, 'sessions.json'), 'utf8');
      const index = JSON.parse(indexRaw);
      const entry = index.entries.find((e: { id: string }) => e.id === session.id);
      const jsonlPath = path.join(tempDir, entry.file);
      require('node:fs').appendFileSync(jsonlPath, 'THIS IS NOT JSON\n', 'utf8');

      // Should still return the valid message without throwing
      const refreshed = await store.get(session.id);
      expect(refreshed?.messages).toHaveLength(1);
      expect(refreshed?.messages[0]?.content).toBe('Valid message');
    });
  });
});
