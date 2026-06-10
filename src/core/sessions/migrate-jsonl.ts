/**
 * @file migrate-jsonl.ts
 * @description One-shot JSONL → SQLite migrator.
 *
 * Reads the JournalSessionStore index at `{journalBaseDir}/sessions.json`,
 * iterates every JSONL file, reconstructs SessionRow + MessageRow data,
 * then calls SqliteSessionStore.createSession + appendMessage.
 *
 * Safe to run on already-migrated data: INSERT OR IGNORE skips duplicate sessions.
 * Path-traversal guard: every JSONL path is resolved and validated to remain
 * within journalBaseDir before reading.
 *
 * Export: migrateJsonlToSqlite(journalBaseDir, db) → { imported, skipped }
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { initializeSchema } from '../memory/schema.js';
import { SqliteSessionStore } from './sqlite-session-store.js';
import type { SessionRow } from './sqlite-session-store.js';

const log = createLogger('sessions:migrate-jsonl');

// ---------------------------------------------------------------------------
// Minimal journal types needed for migration (subset of journal-types.ts)
// ---------------------------------------------------------------------------

interface JournalSessionCreated {
  ts:        string;
  sessionId: string;
  type:      'session';
  channel:   string;
  peerId:    string;
}

interface JournalMessage {
  ts:        string;
  sessionId: string;
  type:      'message';
  role:      'user' | 'assistant' | 'system' | 'tool';
  content:   string;
}

type JournalEvent = JournalSessionCreated | JournalMessage | { type: string; [k: string]: unknown };

interface SessionIndexEntry {
  id:        string;
  channel:   string;
  peerId:    string;
  agentId:   string;
  file:      string;      // relative path within journalBaseDir
  createdAt: string;
  updatedAt: string;
  state:     string;
}

interface SessionIndex {
  entries: SessionIndexEntry[];
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Migrate JSONL sessions to SQLite.
 *
 * @param journalBaseDir - Absolute path to the JournalSessionStore base dir
 *                         (default: `~/.sudo-ai/sessions`).
 * @param db             - Open better-sqlite3 Database instance.
 * @returns              `{ imported, skipped }` counts.
 */
export async function migrateJsonlToSqlite(
  journalBaseDir: string,
  db: Database,
): Promise<{ imported: number; skipped: number }> {
  const resolvedBase = path.resolve(journalBaseDir);
  const indexPath = path.join(resolvedBase, 'sessions.json');

  if (!existsSync(indexPath)) {
    log.info({ indexPath }, 'migrateJsonlToSqlite: sessions.json not found — nothing to migrate');
    return { imported: 0, skipped: 0 };
  }

  // Ensure schema + session-store columns are present
  initializeSchema(db);
  const store = new SqliteSessionStore(db);

  // Read index
  let index: SessionIndex;
  try {
    const raw = readFileSync(indexPath, 'utf8');
    index = JSON.parse(raw) as SessionIndex;
  } catch (err) {
    log.error({ indexPath, err }, 'migrateJsonlToSqlite: failed to parse sessions.json');
    return { imported: 0, skipped: 0 };
  }

  if (!Array.isArray(index?.entries)) {
    log.warn({ indexPath }, 'migrateJsonlToSqlite: sessions.json has no entries array');
    return { imported: 0, skipped: 0 };
  }

  let imported = 0;
  let skipped = 0;

  for (const entry of index.entries) {
    const result = await _migrateEntry(entry, resolvedBase, store);
    if (result === 'imported') imported++;
    else skipped++;
  }

  log.info({ imported, skipped }, 'migrateJsonlToSqlite: complete');
  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Per-entry migration
// ---------------------------------------------------------------------------

async function _migrateEntry(
  entry: SessionIndexEntry,
  resolvedBase: string,
  store: SqliteSessionStore,
): Promise<'imported' | 'skipped'> {
  const sessionId = entry.id;

  // Skip already-migrated sessions
  if (store.getSession(sessionId)) {
    log.debug({ sessionId }, 'skipping — already in SQLite');
    return 'skipped';
  }

  // Traversal guard: resolve the JSONL file path and verify it stays in base dir
  const resolvedFile = path.resolve(resolvedBase, entry.file);
  if (!resolvedFile.startsWith(resolvedBase + path.sep) && resolvedFile !== resolvedBase) {
    log.error({ sessionId, file: entry.file }, 'path traversal detected — skipping');
    return 'skipped';
  }

  if (!existsSync(resolvedFile)) {
    log.warn({ sessionId, resolvedFile }, 'JSONL file not found — skipping');
    return 'skipped';
  }

  // Resolve symlinks and re-verify the real path stays inside resolvedBase
  let realFile: string;
  try {
    realFile = realpathSync(resolvedFile);
  } catch (err) {
    log.warn({ entry: entry.file, err: String(err) }, 'realpath failed — skipping');
    return 'skipped';
  }
  if (realFile !== resolvedBase && !realFile.startsWith(resolvedBase + path.sep)) {
    log.error({ entry: entry.file, resolvedBase, realFile }, 'symlink escapes base — refusing');
    return 'skipped';
  }

  // Parse JSONL
  let raw: string;
  try {
    raw = readFileSync(realFile, 'utf8');
  } catch (err) {
    log.warn({ sessionId, err }, 'cannot read JSONL file — skipping');
    return 'skipped';
  }

  const events: JournalEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch {
      // malformed line — skip
    }
  }

  // Extract session metadata from first 'session' event
  const createdEvent = events.find((e) => e.type === 'session') as JournalSessionCreated | undefined;

  const sessionParams: Omit<SessionRow, 'created_at' | 'updated_at'> = {
    session_id:        sessionId,
    source_platform:   createdEvent?.channel ?? entry.channel ?? '',
    user_id:           createdEvent?.peerId  ?? entry.peerId  ?? '',
    model:             'unknown',    // JSONL format does not store model
    system_prompt:     null,
    parent_session_id: null,
    input_tokens:      0,
    output_tokens:     0,
    cost_usd:          0,
    title:             null,
    status:            'idle',       // default status for migrated sessions
  };

  try {
    store.createSession(sessionParams);
  } catch (err) {
    log.error({ sessionId, err }, 'createSession failed — skipping');
    return 'skipped';
  }

  // Replay message events
  for (const event of events) {
    if (event.type !== 'message') continue;
    const msg = event as JournalMessage;
    if (!msg.role || !msg.content) continue;
    try {
      store.appendMessage(sessionId, msg.role, msg.content);
    } catch (err) {
      // Log and continue — MemoryInjectionError in legacy data should not abort migration
      log.warn({ sessionId, role: msg.role, err }, 'appendMessage skipped during migration');
    }
  }

  log.info({ sessionId }, 'imported session');
  return 'imported';
}
