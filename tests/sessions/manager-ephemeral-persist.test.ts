/**
 * @file manager-ephemeral-persist.test.ts
 * @description Ephemeral per-turn system blocks (intelligence brief, deep
 * insights, drive prompt, tier adjustment, commitments, injection warning) are
 * re-generated from live state every turn. The agent loop pushes them into
 * `session.messages` flagged `_ephemeral: true`. They must NOT be written to the
 * DB — otherwise the conversation table fills with stale duplicates and the
 * (now raised, #449) hydrate reload window is diluted with non-conversation noise.
 *
 * The fork handoff notice is ALSO role:'system' but is NOT ephemeral — it is the
 * one system block that must survive a cold reload — so it must still persist.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { SessionManager } from '../../src/core/sessions/manager.js';

const dirs: string[] = [];
function freshDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'sm-eph-'));
  dirs.push(d);
  return join(d, 'mind.db');
}
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
  delete process.env['SUDO_PERSIST_EPHEMERAL'];
});

describe('SessionManager — ephemeral system blocks are not persisted', () => {
  it('skips _ephemeral system blocks but persists real conversation', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'e1');
    s.messages.push({ role: 'user', content: 'real question' });
    // turn-start ephemeral injections (what loop.ts pushes every turn):
    s.messages.push({ role: 'system', content: 'INTELLIGENCE BRIEF ...', _ephemeral: true });
    s.messages.push({ role: 'system', content: 'DEEP INSIGHTS ...', _ephemeral: true });
    s.messages.push({ role: 'assistant', content: 'real answer' });
    await sm.save(s);

    const contents = db.getSessionMessages(s.id, 100).map((m) => m.content).sort();
    expect(contents).toEqual(['real answer', 'real question']); // both ephemerals dropped
    expect(db.countMessages(s.id)).toBe(2);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('persists a _durable system block (the fork handoff notice) but drops a plain one', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'e2');
    // fork notice: durable → must survive
    s.messages.push({ role: 'system', content: '[SESSION FORK — handoff brief]', _durable: true });
    // an UNtagged system block (e.g. AUTO-ROUTING) — system is ephemeral by
    // default in this architecture, so it must NOT be persisted.
    s.messages.push({ role: 'system', content: 'AUTO-ROUTING [INTENT: single-tool]' });
    s.messages.push({ role: 'user', content: 'next turn' });
    await sm.save(s);

    const contents = db.getSessionMessages(s.id, 100).map((m) => m.content).sort();
    expect(contents).toEqual(['[SESSION FORK — handoff brief]', 'next turn']);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('drops every untagged system block (the real live offenders) regardless of content', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'e5');
    s.messages.push({ role: 'user', content: 'do the thing' });
    for (const c of [
      '## Intelligence Brief',
      'AUTO-ROUTING [INTENT: multi-tool]',
      'CRITICAL: You have been idle',
      '[LoopGuard] Model returned tool calls',
      '# HEADS UP (anticipatory, advisory)',
      '# PLAN FOR THIS TASK',
      '## Today\n<!-- 2026-06-24 -->',
    ]) s.messages.push({ role: 'system', content: c }); // none tagged — all ephemeral by default
    s.messages.push({ role: 'assistant', content: 'did the thing' });
    await sm.save(s);

    const contents = db.getSessionMessages(s.id, 100).map((m) => m.content).sort();
    expect(contents).toEqual(['did the thing', 'do the thing']); // only real conversation
    (db as unknown as { close?: () => void }).close?.();
  });

  it('kill-switch SUDO_PERSIST_EPHEMERAL=1 restores legacy write-all', async () => {
    const db = new MindDB(freshDbPath());
    process.env['SUDO_PERSIST_EPHEMERAL'] = '1';
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'e3');
    s.messages.push({ role: 'user', content: 'q' });
    s.messages.push({ role: 'system', content: 'EPHEMERAL', _ephemeral: true });
    await sm.save(s);
    expect(db.countMessages(s.id)).toBe(2); // ephemeral written when kill-switch set
    (db as unknown as { close?: () => void }).close?.();
  });

  it('an ephemeral block is skipped exactly once (no retry churn across saves)', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('telegram', 'e4');
    const eph = { role: 'system' as const, content: 'EPH', _ephemeral: true };
    s.messages.push({ role: 'user', content: 'u1' });
    s.messages.push(eph);
    await sm.save(s);
    // same array saved again (e.g. a later turn) — ephemeral already marked persisted
    s.messages.push({ role: 'assistant', content: 'a1' });
    await sm.save(s);
    expect(db.countMessages(s.id)).toBe(2); // u1 + a1 only
    expect((eph as { _persisted?: boolean })._persisted).toBe(true);
    (db as unknown as { close?: () => void }).close?.();
  });
});
