/**
 * @file manager-archived-reload.test.ts
 * @description Regression for the no-op session-fork loop that silently dropped
 * every post-archive turn (lost telegram chats).
 *
 * Session meta is persisted append-only (storeChunk writes a new chunk row each
 * save). _loadFromDb scanned newest-first and returned the FIRST 'active' meta
 * it found — so after a session was archived, an older 'active' meta row for the
 * SAME id re-loaded it as active. getOrCreate then handed the just-archived
 * session back to forkSession, the fork never rotated, and the turn's messages
 * vanished. The fix decides each id by its NEWEST meta only.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { SessionManager } from '../../src/core/sessions/manager.js';

const dirs: string[] = [];
function freshDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'sm-arch-'));
  dirs.push(d);
  return join(d, 'mind.db');
}
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('SessionManager — archived session must not be re-loaded as active', () => {
  it('getOrCreate returns a FRESH session after archive, despite stale active meta rows', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);

    const original = await sm.getOrCreate('telegram', '8087386717');
    // Multiple saves → multiple appended 'active' meta rows (the real condition).
    original.messages.push({ role: 'user', content: 'one' });
    await sm.save(original);
    original.messages.push({ role: 'assistant', content: 'two' });
    await sm.save(original);

    await sm.archive(original.id); // writes an 'archived' meta row (newest)

    // Fresh manager = cold cache = the forkSession code path (archive → getOrCreate).
    const sm2 = new SessionManager(db);
    const next = await sm2.getOrCreate('telegram', '8087386717');

    // The bug: `next.id === original.id` (the archived session resurrected).
    expect(next.id).not.toBe(original.id);
    expect(next.messages.length).toBe(0); // genuinely fresh, no carried history

    (db as unknown as { close?: () => void }).close?.();
  });

  it('a normal active session is still returned (no over-correction)', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('web', 'peer-x');
    s.messages.push({ role: 'user', content: 'hi' });
    await sm.save(s);

    const sm2 = new SessionManager(db); // cold cache → load from DB
    const again = await sm2.getOrCreate('web', 'peer-x');
    expect(again.id).toBe(s.id); // active session round-trips
    (db as unknown as { close?: () => void }).close?.();
  });
});
