/**
 * @file tests/sessions/crash-safe-reconcile.test.ts
 * @description Crash-safe reconcile (NP.5 / B4.3) — replays the missing JSONL
 * message tail into SQLite, additive-only + idempotent, DRY-RUN by default.
 * Exercised against a TEMP MindDB (real SQLite) + synthetic JSONL journals:
 *  - dry-run reports the correct drift and writes nothing;
 *  - apply inserts exactly the missing tail, leaves existing rows byte-identical;
 *  - a second apply run is a no-op (idempotent);
 *  - a divergent prefix is reported and skipped (never mutated), even in apply.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { MindDB } from '../../src/core/memory/db.js';
import {
  reconcileInterruptedSessions,
  readJournalMessages,
  type CrashSafeJournal,
  type ReconcilePrimary,
} from '../../src/core/sessions/crash-safe.js';

let baseDir: string;
let db: MindDB;

/** Build a CrashSafeJournal stub over a fixed entry list. */
function makeJournal(entries: Array<{ id: string; channel: string; peerId: string; file: string }>): CrashSafeJournal {
  return { listSessions: async () => entries };
}

/** Write a JSONL journal file with a session header + the given messages. */
function writeJournal(relFile: string, msgs: Array<{ role: string; content: string }>): void {
  const abs = join(baseDir, relFile);
  mkdirSync(join(abs, '..'), { recursive: true });
  const lines = [
    '{"type":"session","sessionId":"x","channel":"telegram","peerId":"p","ts":"2026-06-26T00:00:00.000Z"}',
  ];
  msgs.forEach((m, i) => {
    lines.push(JSON.stringify({ type: 'message', sessionId: 'x', role: m.role, content: m.content, ts: `2026-06-26T00:00:${String(i).padStart(2, '0')}.000Z` }));
  });
  writeFileSync(abs, lines.join('\n') + '\n', 'utf8');
}

/** Seed a session row + prefix messages into the temp MindDB. */
function seed(sessionId: string, prefix: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>): void {
  db.storeSession({ id: sessionId, title: null, model: 'test-model', total_tokens: 0, total_cost_usd: 0 });
  for (const m of prefix) db.storeMessage(sessionId, m.role, m.content);
}

beforeEach(() => {
  baseDir = join(tmpdir(), `crash-reconcile-${randomUUID()}`);
  mkdirSync(baseDir, { recursive: true });
  db = new MindDB(join(baseDir, 'mind.db'));
});

afterEach(() => {
  db.close();
  rmSync(baseDir, { recursive: true, force: true });
});

describe('readJournalMessages', () => {
  it('returns ordered message records, excluding non-message events', () => {
    writeJournal('a/s.jsonl', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    const recs = readJournalMessages(baseDir, 'a/s.jsonl');
    expect(recs.map((r) => [r.role, r.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
    ]);
  });

  it('rejects paths that escape the journalDir', () => {
    expect(readJournalMessages(baseDir, '../../etc/passwd')).toEqual([]);
  });
});

describe('reconcileInterruptedSessions', () => {
  const journalEntry = { id: 's1', channel: 'telegram', peerId: 'p', file: 'a/s1.jsonl' };

  it('DRY-RUN: reports the missing tail and writes NOTHING', async () => {
    seed('s1', [{ role: 'user', content: 'm0' }]);
    writeJournal('a/s1.jsonl', [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
    ]);

    const before = db.getSessionMessages('s1', 100);
    const res = await reconcileInterruptedSessions(makeJournal([journalEntry]), db, { journalDir: baseDir });

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      sessionId: 's1', journalMessageCount: 3, primaryMessageCount: 1,
      missingCount: 2, cleanPrefix: true, applied: false, insertedCount: 0, skippedReason: 'dry_run',
    });
    // Nothing written.
    expect(db.countMessages('s1')).toBe(1);
    expect(db.getSessionMessages('s1', 100)).toEqual(before);
    // No backup directory created in dry-run.
    expect(existsSync(join(baseDir, '.reconcile-backups'))).toBe(false);
  });

  it('APPLY: inserts exactly the missing tail, leaves existing rows byte-identical, captures a backup', async () => {
    seed('s1', [{ role: 'user', content: 'm0' }]);
    writeJournal('a/s1.jsonl', [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
    ]);
    const existingBefore = db.getSessionMessages('s1', 100);

    const res = await reconcileInterruptedSessions(makeJournal([journalEntry]), db, { journalDir: baseDir, apply: true });

    expect(res[0]).toMatchObject({ missingCount: 2, cleanPrefix: true, applied: true, insertedCount: 2 });
    expect(db.countMessages('s1')).toBe(3);

    const after = db.getSessionMessages('s1', 100);
    // Existing row unchanged (byte-identical content + role + id).
    expect(after[0]).toEqual(existingBefore[0]);
    // The tail landed in order.
    expect(after.map((m) => [m.role, m.content])).toEqual([
      ['user', 'm0'],
      ['assistant', 'm1'],
      ['user', 'm2'],
    ]);
    // Backup captured.
    const backupDir = join(baseDir, '.reconcile-backups');
    expect(existsSync(backupDir)).toBe(true);
    expect(readdirSync(backupDir).some((f) => f.startsWith('s1.'))).toBe(true);
  });

  it('APPLY is idempotent: a second run inserts nothing', async () => {
    seed('s1', [{ role: 'user', content: 'm0' }]);
    writeJournal('a/s1.jsonl', [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
    ]);

    await reconcileInterruptedSessions(makeJournal([journalEntry]), db, { journalDir: baseDir, apply: true });
    expect(db.countMessages('s1')).toBe(2);

    const res2 = await reconcileInterruptedSessions(makeJournal([journalEntry]), db, { journalDir: baseDir, apply: true });
    // No lag remains → session is not even a candidate.
    expect(res2).toEqual([]);
    expect(db.countMessages('s1')).toBe(2);
  });

  it('skips a divergent prefix (never mutates), even in apply mode', async () => {
    // SQLite prefix DIFFERS from the journal at index 0.
    seed('s1', [{ role: 'user', content: 'DIFFERENT' }]);
    writeJournal('a/s1.jsonl', [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
    ]);

    const res = await reconcileInterruptedSessions(makeJournal([journalEntry]), db, { journalDir: baseDir, apply: true });
    expect(res[0]).toMatchObject({ cleanPrefix: false, applied: false, insertedCount: 0, skippedReason: 'divergent_prefix' });
    // Untouched.
    expect(db.countMessages('s1')).toBe(1);
  });

  it('ignores sessions where SQLite is caught up or ahead (no over-insert)', async () => {
    seed('s1', [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
    ]);
    writeJournal('a/s1.jsonl', [{ role: 'user', content: 'm0' }]); // journal BEHIND

    const res = await reconcileInterruptedSessions(makeJournal([journalEntry]), db, { journalDir: baseDir, apply: true });
    expect(res).toEqual([]);
    expect(db.countMessages('s1')).toBe(2);
  });
});

describe('ReconcilePrimary structural typing', () => {
  it('MindDB satisfies the ReconcilePrimary surface', () => {
    // Compile-time assertion: assigning db to the interface type would fail
    // tsc if MindDB drifted from {countMessages,getSessionMessages,storeMessage}.
    const p: ReconcilePrimary = db;
    expect(typeof p.countMessages).toBe('function');
    expect(typeof p.getSessionMessages).toBe('function');
    expect(typeof p.storeMessage).toBe('function');
  });
});
