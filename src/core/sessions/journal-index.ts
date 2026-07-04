/**
 * @file journal-index.ts
 * @description Low-level helpers for reading and writing the sessions.json
 * index file used by JournalSessionStore.
 *
 * Kept in a separate module so journal-store.ts stays under 300 lines.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import type { SessionIndex, SessionIndexEntry } from './journal-types.js';

const log = createLogger('sessions:journal-index');

/**
 * Preserve a corrupt sessions.json by renaming it to a timestamped backup BEFORE
 * readIndex returns an empty index. Without this the next writeIndex would
 * overwrite the corrupt file with `{entries:[]}`, permanently losing every
 * session entry (and any chance of manual recovery).
 */
function backupCorruptIndex(indexPath: string): void {
  try {
    if (existsSync(indexPath)) {
      const backup = `${indexPath}.corrupt.${Date.now()}`;
      renameSync(indexPath, backup);
      log.warn({ indexPath, backup }, 'sessions.json preserved as backup before reset');
    }
  } catch (err) {
    log.error({ indexPath, err: String(err) }, 'failed to back up corrupt sessions.json');
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load sessions.json from disk.
 * Returns an empty index if the file is absent, unreadable, or corrupt.
 */
export function readIndex(indexPath: string): SessionIndex {
  try {
    if (!existsSync(indexPath)) {
      return { version: 1, entries: [] };
    }
    const raw = readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as SessionIndex;
    if (!Array.isArray(parsed.entries)) {
      log.warn({ indexPath }, 'sessions.json corrupt (entries not an array) — resetting to empty index');
      backupCorruptIndex(indexPath);
      return { version: 1, entries: [] };
    }
    return parsed;
  } catch (err) {
    log.error({ indexPath, err }, 'readIndex: failed to parse sessions.json');
    backupCorruptIndex(indexPath);
    return { version: 1, entries: [] };
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Overwrite sessions.json (last-write-wins).
 * Errors are logged and silently swallowed so callers never throw.
 */
export function writeIndex(indexPath: string, index: SessionIndex): void {
  try {
    // Atomic write: serialise to a temp file then rename over the target. rename
    // is atomic on POSIX, so a crash / disk-full mid-write leaves either the old
    // complete index or the temp file — NEVER a truncated sessions.json that the
    // next readIndex would treat as corrupt and reset to empty.
    const tmp = `${indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    renameSync(tmp, indexPath);
  } catch (err) {
    log.error({ indexPath, err }, 'writeIndex: failed to write sessions.json');
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find a single entry by sessionId within an already-loaded index.
 * Matches against entry.id and entry.aliases (drift between SQLite primary
 * and the journal-store is reconciled by recording the foreign id under
 * aliases — see DualSessionManager.getOrCreate).
 *
 * When the same id-or-alias resolves to multiple entries (e.g. a session
 * fork archives the old entry under the primary id while a fresh active
 * entry carries the primary id as alias), state='active' wins. Without
 * this preference, post-fork appendEvent/save calls land on the archived
 * JSONL file because it appears first in the array, leaving the active
 * entry's file stranded at its session-created event.
 */
export function findEntry(
  index: SessionIndex,
  sessionId: string,
): SessionIndexEntry | undefined {
  const matches = index.entries.filter(
    (e) => e.id === sessionId || (e.aliases?.includes(sessionId) ?? false),
  );
  if (matches.length === 0) return undefined;
  return matches.find((e) => e.state === 'active') ?? matches[0];
}

/**
 * Find the first active entry for a given (channel, peerId) pair.
 */
export function findActiveEntry(
  index: SessionIndex,
  channel: string,
  peerId: string,
): SessionIndexEntry | undefined {
  return index.entries.find(
    (e) => e.channel === channel && e.peerId === peerId && e.state === 'active',
  );
}
