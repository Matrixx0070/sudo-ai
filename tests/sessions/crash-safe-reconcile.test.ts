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
  isEphemeralPeer,
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

describe('B5.1 reconcile scope fix — ephemeral exclusion + canonical resolution', () => {
  /** Resolver backed by the temp MindDB title convention `<channel>:<peerId>`. */
  const canonicalResolver = (channel: string, peerId: string): number | null => {
    const n = db.countMessagesByTitle(`${channel}:${peerId}`);
    return n > 0 ? n : null;
  };

  it('isEphemeralPeer flags machine-generated one-shots, not real peers', () => {
    for (const p of [
      'cron:isolated:abc', 'subagent:xyz', 'goal:goal-x', '127.0.0.1',
      'web-probe', 'web-e2e-open', 'web-merge-smoke', 'web-listprs', 'web-guardb-verify',
      'web-drill-17', 'drill-3', 'reverify-stable', 'verify458', 'stt-probe-1', 'claude-nudge',
      'web-0291f5ce-a281-40fb-a482-1ac7994050f1', 'web-1776212538066-t1qzg',
    ]) {
      expect(isEphemeralPeer('web', p)).toBe(true);
    }
    for (const p of ['8087386717', 'cli-user-real', 'someuser']) {
      expect(isEphemeralPeer('telegram', p)).toBe(false);
    }
  });

  it('(i) excludes ephemeral peers from candidate selection (default-ON)', async () => {
    // Ephemeral journal session with a genuine tail lead — must be skipped.
    writeJournal('e/cron.jsonl', [
      { role: 'user', content: 'c0' },
      { role: 'assistant', content: 'c1' },
    ]);
    const entry = { id: 'cron-sess', channel: 'web', peerId: 'cron:isolated:zzz', file: 'e/cron.jsonl' };

    const filtered = await reconcileInterruptedSessions(makeJournal([entry]), db, { journalDir: baseDir });
    expect(filtered).toEqual([]); // excluded entirely

    // With the kill-switch, it IS a candidate again (reported as drift).
    const unfiltered = await reconcileInterruptedSessions(makeJournal([entry]), db, {
      journalDir: baseDir, filterEphemeral: false,
    });
    expect(unfiltered).toHaveLength(1);
    expect(unfiltered[0]).toMatchObject({ sessionId: 'cron-sess', missingCount: 2, skippedReason: 'dry_run' });
  });

  it('(ii) telegram journal whose msgs already live under the canonical title → 0 drift', async () => {
    // Canonical mirror: 689 msgs spread over forked rows all titled telegram:<peer>.
    db.storeSession({ id: 'canon-a', title: 'telegram:8087386717', model: 'm', total_tokens: 0, total_cost_usd: 0 });
    db.storeSession({ id: 'canon-b', title: 'telegram:8087386717', model: 'm', total_tokens: 0, total_cost_usd: 0 });
    for (let i = 0; i < 5; i++) db.storeMessage('canon-a', 'user', `a${i}`);
    for (let i = 0; i < 5; i++) db.storeMessage('canon-b', 'assistant', `b${i}`);
    expect(db.countMessagesByTitle('telegram:8087386717')).toBe(10);

    // Journal fork uses a NON-canonical id with its own 4-msg file; per-id mirror = 0.
    writeJournal('t/fork.jsonl', [
      { role: 'user', content: 'f0' }, { role: 'assistant', content: 'f1' },
      { role: 'user', content: 'f2' }, { role: 'assistant', content: 'f3' },
    ]);
    const entry = { id: 'fork-id', channel: 'telegram', peerId: '8087386717', file: 't/fork.jsonl' };

    const res = await reconcileInterruptedSessions(makeJournal([entry]), db, {
      journalDir: baseDir, resolveCanonicalCount: canonicalResolver,
    });
    // 10 canonical ≥ 4 journal → no loss → skipped silently (not reported as drift).
    expect(res).toEqual([]);
  });

  it('(iii) a genuinely-missing telegram tail → drift = true missing count, never applied', async () => {
    // Canonical holds only 3 msgs but the journal fork has 5 → 2 genuinely missing.
    db.storeSession({ id: 'canon-a', title: 'telegram:8087386717', model: 'm', total_tokens: 0, total_cost_usd: 0 });
    for (let i = 0; i < 3; i++) db.storeMessage('canon-a', 'user', `a${i}`);

    writeJournal('t/fork.jsonl', [
      { role: 'user', content: 'f0' }, { role: 'assistant', content: 'f1' },
      { role: 'user', content: 'f2' }, { role: 'assistant', content: 'f3' },
      { role: 'user', content: 'f4' },
    ]);
    const entry = { id: 'fork-id', channel: 'telegram', peerId: '8087386717', file: 't/fork.jsonl' };
    const beforeCanon = db.countMessages('canon-a');

    // Even APPLY mode must NOT write — ambiguous target across the namespace.
    const res = await reconcileInterruptedSessions(makeJournal([entry]), db, {
      journalDir: baseDir, apply: true, resolveCanonicalCount: canonicalResolver,
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      sessionId: 'fork-id', journalMessageCount: 5, primaryMessageCount: 3,
      missingCount: 2, cleanPrefix: true, applied: false, insertedCount: 0,
      skippedReason: 'canonical_ambiguous',
    });
    // No write to the canonical session or the fork id.
    expect(db.countMessages('canon-a')).toBe(beforeCanon);
    expect(db.countMessages('fork-id')).toBe(0);
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
