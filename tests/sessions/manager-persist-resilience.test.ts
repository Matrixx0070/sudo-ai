/**
 * @file manager-persist-resilience.test.ts
 * @description End-to-end regression at the SessionManager layer for the live
 * "runs tools then goes quiet" bug. A turn whose messages include a tool result
 * with ANSI escape codes (colorized CLI output) followed by the final assistant
 * reply must persist the FINAL REPLY. Previously the ANSI message threw inside
 * _persistToDb's write loop and aborted persistence of everything after it.
 *
 * Two layers are exercised:
 *   1. default (sanitize): the ANSI message is stored sanitized AND the final
 *      reply persists — save() never throws.
 *   2. SUDO_MSG_SCAN_STRICT=1: even if a message cannot be stored, the per-message
 *      try/catch in _persistToDb keeps going so the final reply still persists.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { SessionManager } from '../../src/core/sessions/manager.js';

const ESC = String.fromCharCode(27); // \x1b — built, never embedded raw in source
const ANSI = `${ESC}[32mpm2${ESC}[0m: sudo-ai-v5 ${ESC}[1monline${ESC}[0m`;
const FINAL = 'Live state checked: daemon online, no blockers. Nothing further needed.';

const dirs: string[] = [];
function freshDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'sm-resil-'));
  dirs.push(d);
  return join(d, 'mind.db');
}

afterEach(() => {
  delete process.env['SUDO_MSG_SCAN_STRICT'];
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('SessionManager — a turn with ANSI tool output still persists its final reply', () => {
  it('default (sanitize): final reply persists; save does not throw', async () => {
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('web', 'peer-1');

    s.messages.push({ role: 'user', content: 'are you blocked on anything?' });
    s.messages.push({ role: 'assistant', content: 'Let me check live state first.' });
    s.messages.push({ role: 'tool', content: ANSI, toolName: 'system.exec' });
    s.messages.push({ role: 'assistant', content: FINAL });

    await expect(sm.save(s)).resolves.not.toThrow();
    expect(db.countMessages(s.id)).toBe(4);

    const last = db.getSessionMessages(s.id).at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content).toBe(FINAL); // the actual answer reached the durable log
    (db as unknown as { close?: () => void }).close?.();
  });

  it('strict mode: an un-storable message is skipped but the final reply survives', async () => {
    process.env['SUDO_MSG_SCAN_STRICT'] = '1';
    const db = new MindDB(freshDbPath());
    const sm = new SessionManager(db);
    const s = await sm.getOrCreate('web', 'peer-2');

    s.messages.push({ role: 'user', content: 'check the build' });
    s.messages.push({ role: 'tool', content: ANSI, toolName: 'system.exec' }); // rejected in strict
    s.messages.push({ role: 'assistant', content: FINAL });

    // _persistToDb must NOT propagate the per-message rejection.
    await expect(sm.save(s)).resolves.not.toThrow();
    // user + final reply persist; only the ANSI tool message is dropped.
    expect(db.countMessages(s.id)).toBe(2);
    const contents = db.getSessionMessages(s.id).map((m) => m.content);
    expect(contents).toContain(FINAL);
    (db as unknown as { close?: () => void }).close?.();
  });
});
