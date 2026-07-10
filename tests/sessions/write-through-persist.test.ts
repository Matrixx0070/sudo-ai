/**
 * @file write-through-persist.test.ts
 * @description Write-through message persistence — proof pair for the mandate.
 *
 * THE DEFECT CLASS (scan-only persistence): any message appended after the
 * last save() exists only in memory and dies with the process. #659 patched
 * one call site (the guard's revised answer); the class stayed open. The
 * first test DEMONSTRATES the loss deterministically with write-through
 * disabled; the second proves the same sequence survives with it enabled.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { SessionManager } from '../../src/core/sessions/manager.js';
import {
  attachWriteThrough,
  persistMessageNow,
  shouldSkipPersist,
  isWriteThroughEnabled,
} from '../../src/core/sessions/write-through.js';

const dirs: string[] = [];
function freshDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'sm-wt-'));
  dirs.push(d);
  return join(d, 'mind.db');
}
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['SUDO_WRITE_THROUGH_PERSIST', 'SUDO_PERSIST_EPHEMERAL'];

beforeEach(() => { for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('THE DEFECT CLASS — scan-only loses post-save appends on restart', () => {
  it('demonstrates the loss with write-through disabled', async () => {
    process.env['SUDO_WRITE_THROUGH_PERSIST'] = '0';
    const dbPath = freshDbPath();
    const db = new MindDB(dbPath);
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p1');
    s.messages.push({ role: 'user', content: 'A' });
    await sm.save(s);
    // The #659 shape: appended after the last save, then the process dies.
    s.messages.push({ role: 'assistant', content: 'B — delivered to the user' });
    (db as unknown as { close?: () => void }).close?.();

    const db2 = new MindDB(dbPath);
    const sm2 = new SessionManager(db2);
    const reloaded = await sm2.getOrCreate('telegram', 'p1');
    const contents = reloaded.messages.map((m) => m.content);
    expect(contents).toContain('A');
    expect(contents).not.toContain('B — delivered to the user'); // silently lost
    (db2 as unknown as { close?: () => void }).close?.();
  });

  it('write-through (default ON) survives the identical sequence', async () => {
    const dbPath = freshDbPath();
    const db = new MindDB(dbPath);
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p1');
    s.messages.push({ role: 'user', content: 'A' });
    await sm.save(s);
    s.messages.push({ role: 'assistant', content: 'B — delivered to the user' });
    (db as unknown as { close?: () => void }).close?.(); // no save; process "dies"

    const db2 = new MindDB(dbPath);
    const sm2 = new SessionManager(db2);
    const reloaded = await sm2.getOrCreate('telegram', 'p1');
    expect(reloaded.messages.map((m) => m.content)).toContain('B — delivered to the user');
    (db2 as unknown as { close?: () => void }).close?.();
  });
});

describe('write-through mechanics', () => {
  it('no duplicates: immediate write + save() scan insert each message once', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p2');
    s.messages.push({ role: 'user', content: 'u1' });
    s.messages.push({ role: 'assistant', content: 'a1' });
    await sm.save(s);
    await sm.save(s);
    expect(db.countMessages(s.id)).toBe(2);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('ephemeral/system skip rules match the scan', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p3');
    s.messages.push({ role: 'system', content: 'scaffolding' });
    s.messages.push({ role: 'system', content: 'handoff', _durable: true } as never);
    s.messages.push({ role: 'user', content: 'u', _ephemeral: true } as never);
    expect(db.countMessages(s.id)).toBe(1); // only the durable system row

    (db as unknown as { close?: () => void }).close?.();
  });

  it('hydrated sessions never re-persist their history', async () => {
    const dbPath = freshDbPath();
    const db = new MindDB(dbPath);
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p4');
    s.messages.push({ role: 'user', content: 'x' });
    (db as unknown as { close?: () => void }).close?.();
    const db2 = new MindDB(dbPath);
    const sm2 = new SessionManager(db2);
    const reloaded = await sm2.getOrCreate('telegram', 'p4');
    await sm2.save(reloaded);
    expect(db2.countMessages(reloaded.id)).toBe(1);
    (db2 as unknown as { close?: () => void }).close?.();
  });

  it('reassigned arrays: scan safety net catches, save() re-attaches', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p5');
    s.messages.push({ role: 'user', content: 'kept' });
    // Windowing-style reassignment sheds the wrapper.
    s.messages = [...s.messages];
    s.messages.push({ role: 'assistant', content: 'gap message' });
    expect(db.countMessages(s.id)).toBe(1); // gap message not yet persisted
    await sm.save(s); // scan catches it, wrapper re-attached
    expect(db.countMessages(s.id)).toBe(2);
    s.messages.push({ role: 'user', content: 'post-reattach' });
    expect(db.countMessages(s.id)).toBe(3); // write-through active again
    (db as unknown as { close?: () => void }).close?.();
  });

  it('failed immediate write leaves message unmarked; scan retries once', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p6');
    const real = db.storeMessage.bind(db);
    let failOnce = true;
    (db as unknown as { storeMessage: typeof db.storeMessage }).storeMessage = ((...args: Parameters<typeof db.storeMessage>) => {
      if (failOnce) { failOnce = false; throw new Error('disk hiccup'); }
      return real(...args);
    }) as typeof db.storeMessage;
    s.messages.push({ role: 'user', content: 'retry me' });
    expect(db.countMessages(s.id)).toBe(0);
    await sm.save(s);
    expect(db.countMessages(s.id)).toBe(1);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('unit: shouldSkipPersist and enable-gate behave per policy', () => {
    expect(shouldSkipPersist({ role: 'system' })).toBe(true);
    expect(shouldSkipPersist({ role: 'system', _durable: true })).toBe(false);
    expect(shouldSkipPersist({ role: 'user' })).toBe(false);
    expect(shouldSkipPersist({ role: 'user', _ephemeral: true })).toBe(true);
    process.env['SUDO_WRITE_THROUGH_PERSIST'] = '0';
    expect(isWriteThroughEnabled()).toBe(false);
    delete process.env['SUDO_WRITE_THROUGH_PERSIST'];
    expect(isWriteThroughEnabled()).toBe(true);
  });

  it('unit: persistMessageNow outcomes', () => {
    const rows: string[] = [];
    const sink = { storeMessage: (_id: string, role: string, c: string) => { rows.push(`${role}:${c}`); } };
    const msg = { role: 'user', content: 'x' };
    expect(persistMessageNow(sink, 's', msg)).toBe('persisted');
    expect(persistMessageNow(sink, 's', msg)).toBe('already');
    expect(rows).toEqual(['user:x']);
    expect(persistMessageNow(sink, 's', { role: 'system', content: 'scaffold' })).toBe('skipped');
    const boom = { storeMessage: () => { throw new Error('nope'); } };
    const failing = { role: 'user', content: 'y' };
    expect(persistMessageNow(boom, 's', failing)).toBe('failed');
    expect(failing._persisted).toBeUndefined();
  });

  it('attachWriteThrough is idempotent and inert when arrays are shared', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p7');
    attachWriteThrough(s, db);
    attachWriteThrough(s, db);
    s.messages.push({ role: 'user', content: 'once' });
    expect(db.countMessages(s.id)).toBe(1);
    (db as unknown as { close?: () => void }).close?.();
  });
});
