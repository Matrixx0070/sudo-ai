/**
 * Crash-safe session persistence (gap #17) — fsync helper, journal-message
 * counter, interrupted-session scanner, and the DualSessionManager
 * journal-first save ordering. Tests use a tmpdir for journal files and a
 * pair of duck-typed primary/journal stubs that mirror only the surface the
 * scanner touches; no real SQLite handle is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  fsyncFile,
  countJournalMessages,
  scanInterruptedSessions,
  type CrashSafeJournal,
  type CrashSafePrimary,
} from '../../src/core/sessions/crash-safe.js';
import { DualSessionManager } from '../../src/core/sessions/dual-manager.js';
import type { Session } from '../../src/core/sessions/types.js';
import type { SessionManager } from '../../src/core/sessions/manager.js';
import type { JournalSessionStore } from '../../src/core/sessions/journal-store.js';

let baseDir: string;

beforeEach(() => {
  baseDir = join(tmpdir(), `crash-safe-${randomUUID()}`);
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fsyncFile
// ---------------------------------------------------------------------------

describe('fsyncFile', () => {
  it('returns true for an existing regular file', () => {
    const file = join(baseDir, 'a.txt');
    writeFileSync(file, 'hello', 'utf8');
    expect(fsyncFile(file)).toBe(true);
  });

  it('returns false (no throw) when the file does not exist', () => {
    expect(fsyncFile(join(baseDir, 'missing.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countJournalMessages
// ---------------------------------------------------------------------------

describe('countJournalMessages', () => {
  it('counts only `type: "message"` lines', () => {
    const file = join(baseDir, 'sess', 's1.jsonl');
    mkdirSync(join(baseDir, 'sess'), { recursive: true });
    writeFileSync(
      file,
      [
        '{"type":"session","sessionId":"s1","channel":"telegram","peerId":"p","ts":"2026-06-13T20:00:00Z"}',
        '{"type":"message","sessionId":"s1","role":"user","content":"hi","ts":"2026-06-13T20:00:01Z"}',
        '{"type":"toolResult","sessionId":"s1","toolName":"x","output":"ok","ts":"2026-06-13T20:00:02Z"}',
        '{"type":"message","sessionId":"s1","role":"assistant","content":"hello","ts":"2026-06-13T20:00:03Z"}',
        '',
        '{ broken json',
      ].join('\n'),
      'utf8',
    );
    expect(countJournalMessages(baseDir, 'sess/s1.jsonl')).toBe(2);
  });

  it('returns 0 when the file does not exist', () => {
    expect(countJournalMessages(baseDir, 'sess/nope.jsonl')).toBe(0);
  });

  it('rejects paths that escape the journalDir', () => {
    // Resolving '../../etc/passwd' against baseDir must not be readable.
    expect(countJournalMessages(baseDir, '../../etc/passwd')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scanInterruptedSessions (duck-typed)
// ---------------------------------------------------------------------------

describe('scanInterruptedSessions', () => {
  function writeJsonl(relFile: string, messageCount: number): void {
    const abs = join(baseDir, relFile);
    mkdirSync(join(abs, '..'), { recursive: true });
    const lines = [
      '{"type":"session","sessionId":"x","channel":"telegram","peerId":"p","ts":"2026-06-13T20:00:00Z"}',
    ];
    for (let i = 0; i < messageCount; i++) {
      lines.push(`{"type":"message","sessionId":"x","role":"user","content":"m${i}","ts":"2026-06-13T20:00:${i.toString().padStart(2, '0')}Z"}`);
    }
    writeFileSync(abs, lines.join('\n') + '\n', 'utf8');
  }

  function makeJournal(entries: Array<{ id: string; channel: string; peerId: string; file: string }>): CrashSafeJournal {
    return { listSessions: async () => entries };
  }

  function makePrimary(map: Record<string, number>): CrashSafePrimary {
    return {
      get: async (id: string) => {
        const count = map[id];
        if (count === undefined) return undefined;
        return { messages: new Array(count).fill({ role: 'user', content: '' }) };
      },
    };
  }

  it('returns sessions whose JSONL message count exceeds the SQLite mirror', async () => {
    writeJsonl('a/s1.jsonl', 3);
    const journal = makeJournal([{ id: 's1', channel: 'telegram', peerId: 'p', file: 'a/s1.jsonl' }]);
    const primary = makePrimary({ s1: 1 });

    const interrupted = await scanInterruptedSessions(journal, primary, { journalDir: baseDir });
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({
      sessionId: 's1',
      journalMessageCount: 3,
      primaryMessageCount: 1,
      lagBy: 2,
    });
  });

  it('omits sessions where SQLite is caught up to (or ahead of) the JSONL', async () => {
    writeJsonl('a/s1.jsonl', 2);
    const journal = makeJournal([{ id: 's1', channel: 'telegram', peerId: 'p', file: 'a/s1.jsonl' }]);
    const primary = makePrimary({ s1: 2 });

    const interrupted = await scanInterruptedSessions(journal, primary, { journalDir: baseDir });
    expect(interrupted).toEqual([]);
  });

  it('treats missing primary as zero (a never-mirrored session is interrupted by N)', async () => {
    writeJsonl('a/s1.jsonl', 4);
    const journal = makeJournal([{ id: 's1', channel: 'telegram', peerId: 'p', file: 'a/s1.jsonl' }]);
    const primary = makePrimary({}); // no row for s1

    const interrupted = await scanInterruptedSessions(journal, primary, { journalDir: baseDir });
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ journalMessageCount: 4, primaryMessageCount: 0, lagBy: 4 });
  });

  it('does not throw when primary.get rejects — counts that session as zero', async () => {
    writeJsonl('a/s1.jsonl', 2);
    const journal = makeJournal([{ id: 's1', channel: 'telegram', peerId: 'p', file: 'a/s1.jsonl' }]);
    const primary: CrashSafePrimary = {
      get: async () => { throw new Error('db unavailable'); },
    };

    const interrupted = await scanInterruptedSessions(journal, primary, { journalDir: baseDir });
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.primaryMessageCount).toBe(0);
    expect(interrupted[0]?.lagBy).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DualSessionManager crash-safe save ordering
// ---------------------------------------------------------------------------

describe('DualSessionManager crash-safe save ordering', () => {
  function makeStubs(): {
    primary: SessionManager;
    journal: JournalSessionStore;
    calls: string[];
    primaryShouldThrow: boolean;
    journalShouldThrow: boolean;
  } {
    const calls: string[] = [];
    const state = { primaryShouldThrow: false, journalShouldThrow: false };
    // SessionManager / JournalSessionStore are passed by interface duck-type
    // only; we mock just the methods DualSessionManager touches in save().
    const primary = {
      save: async (s: Session) => {
        calls.push(`primary.save:${s.id}`);
        if (state.primaryShouldThrow) throw new Error('primary boom');
      },
    } as unknown as SessionManager;
    const journal = {
      save: async (s: Session) => {
        calls.push(`journal.save:${s.id}`);
        if (state.journalShouldThrow) throw new Error('journal boom');
      },
      // getFilePath returns undefined → fsync is a no-op
      getFilePath: (_id: string) => undefined,
    } as unknown as JournalSessionStore;
    return {
      primary,
      journal,
      calls,
      get primaryShouldThrow() { return state.primaryShouldThrow; },
      set primaryShouldThrow(v: boolean) { state.primaryShouldThrow = v; },
      get journalShouldThrow() { return state.journalShouldThrow; },
      set journalShouldThrow(v: boolean) { state.journalShouldThrow = v; },
    };
  }

  const dummySession: Session = {
    id: 's-1',
    channel: 'telegram',
    peerId: 'p',
    state: 'active',
    messages: [{ role: 'user', content: 'hi' }],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('default (crashSafe:false): primary first, then journal — byte-identical legacy', async () => {
    const s = makeStubs();
    const dual = new DualSessionManager(s.primary, s.journal);
    await dual.save(dummySession);
    expect(s.calls).toEqual(['primary.save:s-1', 'journal.save:s-1']);
  });

  it('default mode: journal failure is non-fatal (warning only)', async () => {
    const s = makeStubs();
    s.journalShouldThrow = true;
    const dual = new DualSessionManager(s.primary, s.journal);
    await expect(dual.save(dummySession)).resolves.toBeUndefined();
    expect(s.calls).toEqual(['primary.save:s-1', 'journal.save:s-1']);
  });

  it('crash-safe (crashSafe:true): journal first, then primary', async () => {
    const s = makeStubs();
    const dual = new DualSessionManager(s.primary, s.journal, { crashSafe: true });
    await dual.save(dummySession);
    expect(s.calls).toEqual(['journal.save:s-1', 'primary.save:s-1']);
  });

  it('crash-safe: journal failure prevents the primary write (mirror invariant)', async () => {
    const s = makeStubs();
    s.journalShouldThrow = true;
    const dual = new DualSessionManager(s.primary, s.journal, { crashSafe: true });
    await expect(dual.save(dummySession)).rejects.toThrow(/journal boom/);
    expect(s.calls).toEqual(['journal.save:s-1']);
    expect(s.calls).not.toContain('primary.save:s-1');
  });

  it('crash-safe: primary failure surfaces after the journal already committed', async () => {
    const s = makeStubs();
    s.primaryShouldThrow = true;
    const dual = new DualSessionManager(s.primary, s.journal, { crashSafe: true });
    await expect(dual.save(dummySession)).rejects.toThrow(/primary boom/);
    expect(s.calls).toEqual(['journal.save:s-1', 'primary.save:s-1']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real JournalSessionStore + crashSafe DualSessionManager
// exercises the journal→fsync→primary path (verifier HIGH #2 — the stub-
// only tests above never hit fsyncFile with a real file descriptor).
// ---------------------------------------------------------------------------

describe('DualSessionManager crash-safe end-to-end with real journal', () => {
  it('writes the journal first, fsyncs, then mirrors the message into the primary stub', async () => {
    const mod = await import('../../src/core/sessions/journal-store.js');
    const journal = new mod.JournalSessionStore(baseDir);
    const seedSession = await journal.getOrCreate('telegram', 'peer-e2e');
    const filePath = journal.getFilePath(seedSession.id);
    expect(filePath).toBeDefined();

    let primaryCalled = false;
    const primary = {
      save: async () => {
        // Assert: by the time the primary is called, the journal file
        // already has the message line on disk. This is the invariant the
        // crash-safe path exists to enforce.
        const { readFileSync } = await import('fs');
        const content = readFileSync(filePath!, 'utf8');
        expect(content).toContain('"role":"user"');
        expect(content).toContain('"content":"hello e2e"');
        primaryCalled = true;
      },
    } as unknown as SessionManager;

    const dual = new DualSessionManager(primary, journal, { crashSafe: true });
    await dual.save({
      ...seedSession,
      messages: [{ role: 'user', content: 'hello e2e' }],
    });
    expect(primaryCalled).toBe(true);
  });

  it('a journal write failure (escape-baseDir guard fires) refuses the primary mirror', async () => {
    const mod = await import('../../src/core/sessions/journal-store.js');
    const journal = new mod.JournalSessionStore(baseDir);
    const seedSession = await journal.getOrCreate('telegram', 'peer-fail');

    // Force the journal write to throw by replacing the underlying primary's
    // save with a sentinel that should NEVER run if the journal rejects.
    let primaryCalled = false;
    const primary = {
      save: async () => { primaryCalled = true; },
    } as unknown as SessionManager;

    // Corrupt the journal index entry's file path so _writeEvent's path-
    // traversal guard throws.
    const sessFile = join(baseDir, 'sessions.json');
    const { writeFileSync, readFileSync } = await import('fs');
    const idx = JSON.parse(readFileSync(sessFile, 'utf8')) as { entries: Array<{ id: string; file: string }> };
    const entry = idx.entries.find((e) => e.id === seedSession.id)!;
    entry.file = '../../../etc/escape.jsonl';
    writeFileSync(sessFile, JSON.stringify(idx), 'utf8');

    const dual = new DualSessionManager(primary, journal, { crashSafe: true });
    await expect(
      dual.save({
        ...seedSession,
        messages: [{ role: 'user', content: 'should not be mirrored' }],
      }),
    ).rejects.toThrow(/escapes baseDir/);
    expect(primaryCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JournalSessionStore.getFilePath exposes the file path for fsync
// ---------------------------------------------------------------------------

describe('JournalSessionStore.getFilePath', () => {
  it('returns undefined for unknown sessions and an existing path otherwise', async () => {
    const mod = await import('../../src/core/sessions/journal-store.js');
    const journal = new mod.JournalSessionStore(baseDir);
    expect(journal.getFilePath('nope')).toBeUndefined();

    const session = await journal.getOrCreate('telegram', 'peer-1');
    const filePath = journal.getFilePath(session.id);
    expect(filePath).toBeDefined();
    expect(existsSync(filePath!)).toBe(true);
    expect(journal.journalDir).toBe(baseDir);
  });
});
