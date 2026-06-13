/**
 * @file crash-safe.ts
 * @description Crash-safe session-persistence invariants (gap #17).
 *
 * Two guarantees this module owns:
 *
 *   1. **SQLite never leads JSONL.** Today DualSessionManager.save() writes
 *      the SQLite primary first and the JSONL secondary second. If the
 *      process dies between the two, SQLite has data the journal doesn't —
 *      which means we cannot reconstruct what actually happened from the
 *      authoritative log. The crash-safe path inverts the order (journal
 *      first, with fsync, then SQLite) so a partial write always leaves the
 *      journal as the more-complete store.
 *
 *   2. **Interrupted-turn detection at boot.** When the loop sends a
 *      message-write through DualSessionManager.save() and the process dies
 *      AFTER the journal append but BEFORE the SQLite mirror, on next boot
 *      the journal has more messages than SQLite. `scanInterruptedSessions`
 *      finds these and lets the operator either replay or accept the
 *      divergence — Codex study point #9 "SQLite never leads JSONL".
 *
 * Both guarantees are opt-in via SUDO_CRASH_SAFE=1 in cli.ts — the existing
 * SQLite-first ordering stays the default to keep behaviour byte-identical
 * for callers that have not asked for the invariant.
 */

import { closeSync, fsyncSync, openSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sessions:crash-safe');

// ---------------------------------------------------------------------------
// fsync helper — durable file flush
// ---------------------------------------------------------------------------

/**
 * Best-effort fsync of a file path. Returns true when the fsync succeeded,
 * false on any failure (file missing, fsync not supported on the volume,
 * race with file rotation). Errors are intentionally swallowed because the
 * caller's higher-level write has already succeeded and the fsync is a
 * durability guarantee, not a correctness one.
 */
export function fsyncFile(filePath: string): boolean {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r+');
    fsyncSync(fd);
    return true;
  } catch (err) {
    log.debug({ filePath, err: String(err) }, 'fsyncFile: best-effort fsync failed');
    return false;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Interrupted-session detection
// ---------------------------------------------------------------------------

export interface InterruptedSession {
  sessionId: string;
  /** Channel from the journal index (telegram, discord, …). */
  channel: string;
  /** Peer id from the journal index. */
  peerId: string;
  /** How many `type: 'message'` events are in the journal file. */
  journalMessageCount: number;
  /** How many messages the SQLite mirror has. */
  primaryMessageCount: number;
  /** Always > 0 when this session is listed; the lag-by-N count. */
  lagBy: number;
}

/**
 * Duck-typed view of `JournalSessionStore` so the scanner can be unit-
 * tested without instantiating the real store. Mirrors the bits used.
 */
export interface CrashSafeJournal {
  listSessions(agentId?: string): Promise<Array<{
    id: string;
    channel: string;
    peerId: string;
    file: string;
  }>>;
}

/**
 * Duck-typed view of `SessionManager` so the scanner can be unit-tested
 * without a real SQLite handle.
 */
export interface CrashSafePrimary {
  get(sessionId: string): Promise<{ messages: unknown[] } | undefined>;
}

/**
 * Count `type: 'message'` events inside a JSONL file. Malformed lines
 * are skipped, missing files yield 0 — both are recoverable conditions
 * that should not turn the boot-time scan into a fatal.
 */
export function countJournalMessages(journalDir: string, relFile: string): number {
  const absFile = path.resolve(journalDir, relFile);
  if (!absFile.startsWith(path.resolve(journalDir) + path.sep)) {
    log.warn({ relFile }, 'countJournalMessages: file escapes journalDir — skipping');
    return 0;
  }
  if (!existsSync(absFile)) return 0;
  let raw: string;
  try {
    raw = readFileSync(absFile, 'utf8');
  } catch (err) {
    log.warn({ absFile, err: String(err) }, 'countJournalMessages: read failed');
    return 0;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { type?: string };
      if (obj.type === 'message') count++;
    } catch { /* skip malformed line */ }
  }
  return count;
}

export interface ScanOptions {
  /** Absolute path to the journal baseDir, used to resolve session files. */
  journalDir: string;
}

/**
 * Scan every indexed journal session and report those whose JSONL has more
 * message events than the SQLite mirror. The returned list captures the
 * crash window — events that were appended to the durable log but lost
 * before the queryable mirror saw them.
 *
 * Side-effect-free: returns the list, never replays or mutates either
 * store. Replay is a follow-up slice (the right action depends on the
 * caller — auto-replay vs. operator-prompted vs. quarantine).
 */
export async function scanInterruptedSessions(
  journal: CrashSafeJournal,
  primary: CrashSafePrimary,
  opts: ScanOptions,
): Promise<InterruptedSession[]> {
  const result: InterruptedSession[] = [];
  const entries = await journal.listSessions();
  for (const entry of entries) {
    const journalMessageCount = countJournalMessages(opts.journalDir, entry.file);
    let primaryMessageCount = 0;
    try {
      const session = await primary.get(entry.id);
      primaryMessageCount = session?.messages.length ?? 0;
    } catch (err) {
      log.warn({ sessionId: entry.id, err: String(err) }, 'scan: primary.get failed — treating as zero');
    }
    if (journalMessageCount > primaryMessageCount) {
      result.push({
        sessionId: entry.id,
        channel: entry.channel,
        peerId: entry.peerId,
        journalMessageCount,
        primaryMessageCount,
        lagBy: journalMessageCount - primaryMessageCount,
      });
    }
  }
  return result;
}
