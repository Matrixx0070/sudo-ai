/**
 * @file rewind-conversation.test.ts
 * @description Conversation half of rewind. Files alone were a HALF-undo: the
 * code reverted but the transcript still said the agent had done it, so the
 * model kept "remembering" work that no longer existed.
 *
 * The safety property that matters: rewinding is itself undoable — removed
 * messages are archived before deletion, or "undo" becomes the most destructive
 * button in the product.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { __resetRewindStore } from '../../src/core/rewind/store.js';
import { snapshotBeforeTool, restoreConversation, currentMessageBoundary } from '../../src/core/rewind/index.js';

let tmp: string;
let mindDb: string;

/** Build a minimal mind.db with the `messages` shape the real store uses. */
function seedMessages(dbPath: string, sessionId: string, n: number): void {
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
    tool_name TEXT, tool_input TEXT, tool_output TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, created_at TEXT)`);
  const ins = d.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)');
  for (let i = 0; i < n; i++) ins.run(sessionId, i % 2 ? 'assistant' : 'user', `m${i}`);
  d.close();
}

function countMessages(dbPath: string, sessionId: string): number {
  const d = new Database(dbPath, { readonly: true });
  const c = (d.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionId) as { c: number }).c;
  d.close();
  return c;
}

beforeEach(() => {
  tmp = mkdtempSync(join(os.tmpdir(), 'rewind-conv-'));
  mindDb = join(tmp, 'mind.db');
  // Paths are injected rather than read from SUDO_AI_HOME: dataPath() resolves
  // that env var at MODULE LOAD, so a test can never retro-set it.
  __resetRewindStore(join(tmp, 'store'));
});

afterEach(() => {
  __resetRewindStore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('conversation rewind', () => {
  it('captures a boundary and drops only messages recorded AFTER it', () => {
    seedMessages(mindDb, 'sess-1', 5);
    expect(currentMessageBoundary('sess-1', mindDb)).toBe(5);

    const f = join(tmp, 'x.txt');
    writeFileSync(f, 'before');
    const id = snapshotBeforeTool('coder.write-file', { path: f }, 'sess-1', mindDb);
    expect(id).not.toBeNull();

    seedMessages(mindDb, 'sess-1', 3); // 3 more messages "after" the checkpoint
    expect(countMessages(mindDb, 'sess-1')).toBe(8);

    const r = restoreConversation(id!, mindDb);
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(3);
    expect(countMessages(mindDb, 'sess-1')).toBe(5); // back to the boundary
  });

  it('archives removed messages so the rewind is itself undoable', () => {
    seedMessages(mindDb, 'sess-2', 2);
    const f = join(tmp, 'y.txt');
    writeFileSync(f, 'v1');
    const id = snapshotBeforeTool('coder.write-file', { path: f }, 'sess-2', mindDb)!;
    seedMessages(mindDb, 'sess-2', 4);

    const r = restoreConversation(id, mindDb);
    expect(r.archivedTo).toBeDefined();
    expect(existsSync(r.archivedTo!)).toBe(true);
    const archived = JSON.parse(readFileSync(r.archivedTo!, 'utf8')) as unknown[];
    expect(archived).toHaveLength(4); // every dropped message is recoverable
  });

  it('is a no-op when nothing was said after the checkpoint', () => {
    seedMessages(mindDb, 'sess-3', 3);
    const f = join(tmp, 'z.txt');
    writeFileSync(f, 'v1');
    const id = snapshotBeforeTool('coder.write-file', { path: f }, 'sess-3', mindDb)!;
    const r = restoreConversation(id, mindDb);
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(0);
    expect(countMessages(mindDb, 'sess-3')).toBe(3);
  });

  it('refuses cleanly when the checkpoint has no conversation boundary', () => {
    const r = restoreConversation(999999, mindDb);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no checkpoint/);
  });

  it('never touches another session\'s messages', () => {
    seedMessages(mindDb, 'mine', 2);
    seedMessages(mindDb, 'theirs', 5);
    const f = join(tmp, 'w.txt');
    writeFileSync(f, 'v1');
    const id = snapshotBeforeTool('coder.write-file', { path: f }, 'mine', mindDb)!;
    seedMessages(mindDb, 'mine', 3);
    seedMessages(mindDb, 'theirs', 3);

    restoreConversation(id, mindDb);
    expect(countMessages(mindDb, 'mine')).toBe(2);
    expect(countMessages(mindDb, 'theirs')).toBe(8); // untouched
  });
});
