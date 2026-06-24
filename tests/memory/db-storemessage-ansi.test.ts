/**
 * @file db-storemessage-ansi.test.ts
 * @description Regression for the live "SUDO runs tools then goes quiet" bug.
 *
 * MindDB.storeMessage ran guardMemoryWrite in STRICT mode by default. A tool
 * result legitimately containing ANSI escape codes (colorized `pm2`/`rg`/`git`
 * output) matched the `ansi_escape` injection pattern and threw a
 * MemoryInjectionError. That throw propagated out of SessionManager._persistToDb's
 * write loop, so every later message in the turn — including the final assistant
 * reply — was never persisted (proven live by a stack trace ending at
 * db.ts storeMessage -> manager.ts _persistToDb).
 *
 * The fix: storeMessage now SANITIZES the conversation log (strip -> [REDACTED],
 * never throw). The old strict behavior is restorable via SUDO_MSG_SCAN_STRICT=1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MindDB } from '../../src/core/memory/db.js';
import { MemoryInjectionError } from '../../src/core/memory/injection-scanner.js';

// Build the ESC byte programmatically — never embed a raw control char in source.
const ESC = String.fromCharCode(27); // \x1b
const ANSI_TOOL_OUTPUT = `${ESC}[31mBuild failed${ESC}[0m: 3 errors in ${ESC}[1msrc/main.ts${ESC}[0m`;

const dirs: string[] = [];
function freshDb(): MindDB {
  const d = mkdtempSync(join(tmpdir(), 'db-ansi-'));
  dirs.push(d);
  const db = new MindDB(join(d, 'mind.db'));
  db.storeSession({ id: 's1', model: 'test', title: 'web:peer' });
  return db;
}

afterEach(() => {
  delete process.env['SUDO_MSG_SCAN_STRICT'];
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  dirs.length = 0;
});

describe('MindDB.storeMessage — ANSI tool output must not break persistence', () => {
  it('stores a message with ANSI escape codes instead of throwing (default sanitize)', () => {
    const db = freshDb();
    // Before the fix this threw MemoryInjectionError(ansi_escape).
    expect(() => db.storeMessage('s1', 'tool', ANSI_TOOL_OUTPUT, { tool_name: 'system.exec' })).not.toThrow();
    expect(db.countMessages('s1')).toBe(1);

    const [row] = db.getSessionMessages('s1');
    // Visible text survives; the raw escape bytes are stripped to [REDACTED].
    expect(row.content).toContain('Build failed');
    expect(row.content).toContain('[REDACTED]');
    expect(row.content).not.toContain(ESC);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('a later message (the final reply) persists even though an earlier one had ANSI', () => {
    const db = freshDb();
    db.storeMessage('s1', 'user', 'check the build');
    db.storeMessage('s1', 'tool', ANSI_TOOL_OUTPUT, { tool_name: 'system.exec' });
    db.storeMessage('s1', 'assistant', 'The build has 3 errors in src/main.ts. Here is the fix...');
    expect(db.countMessages('s1')).toBe(3);
    const last = db.getSessionMessages('s1').at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.content).toContain('3 errors');
    (db as unknown as { close?: () => void }).close?.();
  });

  it('SUDO_MSG_SCAN_STRICT=1 restores the old throwing behavior', () => {
    process.env['SUDO_MSG_SCAN_STRICT'] = '1';
    const db = freshDb();
    expect(() => db.storeMessage('s1', 'tool', ANSI_TOOL_OUTPUT)).toThrow(MemoryInjectionError);
    (db as unknown as { close?: () => void }).close?.();
  });

  it('clean content is stored verbatim (no false [REDACTED])', () => {
    const db = freshDb();
    db.storeMessage('s1', 'assistant', 'All checks passed. 0 errors.');
    expect(db.getSessionMessages('s1')[0].content).toBe('All checks passed. 0 errors.');
    (db as unknown as { close?: () => void }).close?.();
  });
});
