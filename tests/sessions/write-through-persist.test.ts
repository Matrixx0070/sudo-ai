/**
 * @file write-through-persist.test.ts
 * @description Write-through message persistence — the invariant "what is
 * pushed gets stored" moves into the data structure.
 *
 * The first test DOCUMENTS THE DEFECT CLASS this closes (kill-switched back
 * to scan-only): any message appended after the last save() exists only in
 * memory and dies with the process. That is the #659 class; the live casualty
 * was a guard-revised final answer, delivered to the user and permanently
 * lost to a restart. Patch #659 fixed one call site; write-through closes
 * the class.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { SessionManager } from '../../src/core/sessions/manager.js';
import { persistMessageNow, shouldSkipPersist, attachWriteThrough } from '../../src/core/sessions/write-through.js';

const dirs: string[] = [];
function freshDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'sm-wt-'));
  dirs.push(d);
  return join(d, 'mind.db');
}
const ENV_KEYS = ['SUDO_WRITE_THROUGH_PERSIST', 'SUDO_PERSIST_EPHEMERAL', 'SUDO_IDENTITY_PERSIST'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('the defect class (scan-only, kill-switched)', () => {
  it('a message appended after the last save() is LOST on restart', async () => {
    process.env['SUDO_WRITE_THROUGH_PERSIST'] = '0'; // pre-redesign behavior
    const dbPath = freshDbPath();
    const db = new MindDB(dbPath);
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p1');
    s.messages.push({ role: 'user', content: 'question' });
    await sm.save(s);
    // The #659 shape: a post-save append (verify retry, guard revision, …).
    s.messages.push({ role: 'assistant', content: 'revised final answer' });
    // Process dies here — no further save. Simulate restart:
    (db as unknown as { close?: () => void }).close?.();
    const db2 = new MindDB(dbPath);
    const sm2 = new SessionManager(db2);
    const reloaded = await sm2.getOrCreate('telegram', 'p1');
    const contents = reloaded.messages.map((m) => m.content);
    expect(contents).toContain('question');
    expect(contents).not.toContain('revised final answer'); // the documented loss
    (db2 as unknown as { close?: () => void }).close?.();
  });
});

describe('write-through (default ON)', () => {
  it('the same post-save append SURVIVES a restart with zero save() calls after it', async () => {
    const dbPath = freshDbPath();
    const db = new MindDB(dbPath);
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p1');
    s.messages.push({ role: 'user', content: 'question' });
    await sm.save(s);
    s.messages.push({ role: 'assistant', content: 'revised final answer' });
    (db as unknown as { close?: () => void }).close?.();
    const db2 = new MindDB(dbPath);
    const sm2 = new SessionManager(db2);
    const reloaded = await sm2.getOrCreate('telegram', 'p1');
    expect(reloaded.messages.map((m) => m.content)).toContain('revised final answer');
    (db2 as unknown as { close?: () => void }).close?.();
  });

  it('even with NO save() at all, appends are durable', async () => {
    const dbPath = freshDbPath();
    const db = new MindDB(dbPath);
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p2');
    s.messages.push({ role: 'user', content: 'u1' });
    s.messages.push({ role: 'assistant', content: 'a1' });
    expect(db.countMessages(s.id)).toBe(2);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('no duplicates: save() after write-through inserts nothing new', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p3');
    s.messages.push({ role: 'user', content: 'u1' });
    s.messages.push({ role: 'assistant', content: 'a1' });
    await sm.save(s);
    await sm.save(s);
    expect(db.countMessages(s.id)).toBe(2);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('ephemeral rules hold: plain system skipped, _durable system persisted', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p4');
    s.messages.push({ role: 'system', content: 'turn scaffolding' });
    s.messages.push({ role: 'system', content: 'fork handoff', _durable: true } as never);
    s.messages.push({ role: 'user', content: 'u', _ephemeral: true } as never);
    expect(db.countMessages(s.id)).toBe(1);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('hydrated sessions do not re-persist history, and stay write-through', async () => {
    const dbPath = freshDbPath();
    const db = new MindDB(dbPath);
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p5');
    s.messages.push({ role: 'user', content: 'old' });
    await sm.save(s);
    (db as unknown as { close?: () => void }).close?.();
    const db2 = new MindDB(dbPath);
    const sm2 = new SessionManager(db2);
    const reloaded = await sm2.getOrCreate('telegram', 'p5');
    expect(db2.countMessages(reloaded.id)).toBe(1);
    reloaded.messages.push({ role: 'user', content: 'new' }); // no save
    expect(db2.countMessages(reloaded.id)).toBe(2);
    (db2 as unknown as { close?: () => void }).close?.();
  });

  it('reassignment safety net: fresh arrays fall back to the scan, save() re-attaches', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p6');
    s.messages.push({ role: 'user', content: 'u1' });
    // Compaction-style reassignment sheds the wrapper.
    s.messages = [...s.messages];
    s.messages.push({ role: 'assistant', content: 'a1' });
    expect(db.countMessages(s.id)).toBe(1); // a1 not yet persisted (scan-only gap)
    await sm.save(s); // scan catches a1 AND re-attaches
    expect(db.countMessages(s.id)).toBe(2);
    s.messages.push({ role: 'user', content: 'u2' }); // write-through again
    expect(db.countMessages(s.id)).toBe(3);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('failure policy: a failed immediate write stays unmarked and the scan retries once', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'p7');
    const real = db.storeMessage.bind(db);
    let failOnce = true;
    (db as { storeMessage: typeof db.storeMessage }).storeMessage = ((...args: Parameters<typeof real>) => {
      if (failOnce) { failOnce = false; throw new Error('disk hiccup'); }
      return real(...args);
    }) as typeof db.storeMessage;
    s.messages.push({ role: 'user', content: 'flaky' });
    expect(db.countMessages(s.id)).toBe(0); // immediate write failed, unmarked
    await sm.save(s); // scan retries (second and final attempt)
    expect(db.countMessages(s.id)).toBe(1);
    (db as unknown as { close?: () => void }).close?.();
  });
});

describe('unit: shouldSkipPersist / persistMessageNow', () => {
  it('skip rules mirror the scan policy', () => {
    expect(shouldSkipPersist({ role: 'system' })).toBe(true);
    expect(shouldSkipPersist({ role: 'system', _durable: true })).toBe(false);
    expect(shouldSkipPersist({ role: 'user', _ephemeral: true })).toBe(true);
    expect(shouldSkipPersist({ role: 'user' })).toBe(false);
    process.env['SUDO_PERSIST_EPHEMERAL'] = '1';
    expect(shouldSkipPersist({ role: 'system' })).toBe(false);
  });

  it('persistMessageNow outcomes: already / skipped / persisted', () => {
    const rows: unknown[] = [];
    const sink = { storeMessage: (...a: unknown[]) => { rows.push(a); return 1; } };
    expect(persistMessageNow(sink, 's', { role: 'user', content: 'x', _persisted: true })).toBe('already');
    expect(persistMessageNow(sink, 's', { role: 'system', content: 'x' })).toBe('skipped');
    const msg = { role: 'user', content: 'x' };
    expect(persistMessageNow(sink, 's', msg)).toBe('persisted');
    expect((msg as { _persisted?: boolean })._persisted).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('attach is idempotent and disabled by the kill-switch', () => {
    const sink = { storeMessage: () => 1 };
    const session = { id: 's', messages: [] as never[] };
    attachWriteThrough(session, sink);
    const wrapped = session.messages.push;
    attachWriteThrough(session, sink);
    expect(session.messages.push).toBe(wrapped);
    process.env['SUDO_WRITE_THROUGH_PERSIST'] = '0';
    const session2 = { id: 's2', messages: [] as never[] };
    attachWriteThrough(session2, sink);
    expect(session2.messages.push).toBe(Array.prototype.push);
  });
});
