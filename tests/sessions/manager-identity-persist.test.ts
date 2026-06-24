/**
 * @file manager-identity-persist.test.ts
 * @description Phase 2a (identity-based message persistence) + Phase 2b (session
 * meta upsert). The legacy positional `slice(persistedMessageCount)` dropped or
 * duplicated messages whenever the in-memory array was mutated (the fork's
 * unshift, trimSessionMessages, windowing) — the deeper cause behind the lost
 * telegram turns. Identity-based persistence marks each persisted message and
 * persists only unmarked ones, surviving any array mutation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { SessionManager } from '../../src/core/sessions/manager.js';

const dirs: string[] = [];
function freshDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'sm-id-'));
  dirs.push(d);
  return join(d, 'mind.db');
}
function metaRowCount(db: MindDB, sessionId: string): number {
  const row = (db as unknown as { db: { prepare(s: string): { get(p: string): { n: number } } } })
    .db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = ? AND source = 'conversation'")
    .get(`session:${sessionId}:meta`);
  return row?.n ?? 0;
}
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('SessionManager — identity-based persistence (Phase 2a)', () => {
  it('append-only: each message persists exactly once', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p1');
    s.messages.push({ role: 'user', content: 'a' });
    s.messages.push({ role: 'assistant', content: 'b' });
    await sm.save(s);
    s.messages.push({ role: 'user', content: 'c' });
    await sm.save(s);
    expect(db.countMessages(s.id)).toBe(3);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('survives an unshift (fork notice at front): no dup, no loss', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p2');
    s.messages.push({ role: 'user', content: 'm1' });
    s.messages.push({ role: 'assistant', content: 'm2' });
    await sm.save(s);
    // Simulate forkSession.unshift + a new turn message appended. The fork
    // notice is _durable (system messages are otherwise ephemeral, not persisted).
    s.messages.unshift({ role: 'system', content: 'FORK-NOTICE', _durable: true });
    s.messages.push({ role: 'user', content: 'm3' });
    await sm.save(s);
    const contents = db.getSessionMessages(s.id, 100).map((m) => m.content).sort();
    expect(contents).toEqual(['FORK-NOTICE', 'm1', 'm2', 'm3']); // each exactly once
    (db as unknown as { close?: () => void }).close?.();
  });

  it('survives a trim (array shrinks below persisted count): the new message is NOT lost', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p3');
    for (const c of ['m1', 'm2', 'm3', 'm4', 'm5']) s.messages.push({ role: 'user', content: c });
    await sm.save(s);
    // trimSessionMessages reassigns to a SHORTER array (keeps the same objects).
    s.messages = s.messages.slice(-2);          // [m4, m5] — both already persisted
    s.messages.push({ role: 'assistant', content: 'm6' }); // genuinely new, post-trim
    await sm.save(s);
    // Positional slice would compute 3 <= 5 → persist nothing → m6 LOST. Identity keeps it.
    expect(db.countMessages(s.id)).toBe(6);
    expect(db.getSessionMessages(s.id, 100).some((m) => m.content === 'm6')).toBe(true);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('cold reload (hydrate) does not re-insert loaded history', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p4');
    s.messages.push({ role: 'user', content: 'x' });
    s.messages.push({ role: 'assistant', content: 'y' });
    await sm.save(s);

    const sm2 = new SessionManager(db); // cold cache → hydrate from DB
    const loaded = await sm2.getOrCreate('telegram', 'p4');
    expect(loaded.id).toBe(s.id);
    loaded.messages.push({ role: 'user', content: 'z' });
    await sm2.save(loaded);
    expect(db.countMessages(s.id)).toBe(3); // x,y,z — loaded x,y NOT duplicated
    (db as unknown as { close?: () => void }).close?.();
  });
});

describe('SessionManager — session-meta upsert (Phase 2b)', () => {
  it('keeps exactly one meta row per session across many saves', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p5');
    expect(metaRowCount(db, s.id)).toBe(1);
    for (let i = 0; i < 5; i++) {
      s.messages.push({ role: 'user', content: `n${i}` });
      await sm.save(s);
    }
    expect(metaRowCount(db, s.id)).toBe(1); // not 6
    await sm.archive(s.id);
    expect(metaRowCount(db, s.id)).toBe(1); // archive replaces, not appends
    (db as unknown as { close?: () => void }).close?.();
  });
});

describe('SessionManager — hydrate message limit (SUDO_HYDRATE_MESSAGE_LIMIT)', () => {
  afterEach(() => { delete process.env['SUDO_HYDRATE_MESSAGE_LIMIT']; });

  async function seed150(db: MindDB, channel: string, peer: string): Promise<string> {
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate(channel as 'web', peer);
    for (let i = 0; i < 150; i++) s.messages.push({ role: 'user', content: `m${i}` });
    await sm.save(s);
    return s.id;
  }

  it('cold reload loads only the default 100 when unset', async () => {
    const db = new MindDB(freshDbPath());
    delete process.env['SUDO_HYDRATE_MESSAGE_LIMIT'];
    await seed150(db, 'web', 'h1');
    const reloaded = await new SessionManager(db).getOrCreate('web', 'h1'); // cold cache → hydrate
    expect(reloaded.messages.length).toBe(100);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('cold reload loads more when SUDO_HYDRATE_MESSAGE_LIMIT is raised', async () => {
    const db = new MindDB(freshDbPath());
    await seed150(db, 'web', 'h2');
    process.env['SUDO_HYDRATE_MESSAGE_LIMIT'] = '300';
    const reloaded = await new SessionManager(db).getOrCreate('web', 'h2'); // constructed AFTER env set
    expect(reloaded.messages.length).toBe(150); // all 150 (limit 300 > 150)
    (db as unknown as { close?: () => void }).close?.();
  });
});
