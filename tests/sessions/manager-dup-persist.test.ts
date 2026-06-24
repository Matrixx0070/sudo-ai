/**
 * @file manager-dup-persist.test.ts
 * @description Regression for the duplicate-message-persist bug. The session
 * cache is size-limited and evicts entries; SessionManager.save() re-registered
 * an evicted session with persistedMessageCount=0, so _persistToDb re-inserted
 * the ENTIRE message history on every post-eviction save — observed in prod as
 * up to 60 identical copies of one assistant reply (901 excess rows total). The
 * fix seeds the count from the DB (countMessages) on a cache miss instead of 0.
 *
 * A fresh SessionManager over the same DB models the evicted/cold-cache state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { SessionManager } from '../../src/core/sessions/manager.js';

const dirs: string[] = [];
function freshDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'sm-dup-'));
  dirs.push(d);
  return join(d, 'mind.db');
}

afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('SessionManager — duplicate-persist on cache miss', () => {
  it('re-saving a session whose cache entry is gone does NOT re-insert its history', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);

    const session = await sm.getOrCreate('telegram', 'peer-1');
    session.messages.push({ role: 'user', content: 'hi' });
    session.messages.push({ role: 'assistant', content: 'hello there' });
    await sm.save(session);
    expect(db.countMessages(session.id)).toBe(2);

    // Fresh manager over the SAME db = empty cache = the evicted/cold state that
    // triggered the bug. Old code re-registered at 0 → re-inserted all → 4.
    const sm2 = new SessionManager(db);
    await sm2.save(session);
    expect(db.countMessages(session.id)).toBe(2);

    // A genuinely-new message still persists exactly once (no over-correction).
    session.messages.push({ role: 'assistant', content: 'bye' });
    await sm2.save(session);
    expect(db.countMessages(session.id)).toBe(3);

    (db as unknown as { close?: () => void }).close?.();
  });

  it('countMessages reflects the persisted count', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('web', 'peer-2');
    expect(db.countMessages(s.id)).toBe(0);
    s.messages.push({ role: 'user', content: 'x' });
    await sm.save(s);
    expect(db.countMessages(s.id)).toBe(1);
    expect(db.countMessages('no-such-session')).toBe(0);
    (db as unknown as { close?: () => void }).close?.();
  });
});
