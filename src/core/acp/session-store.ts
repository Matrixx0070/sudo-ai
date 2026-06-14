/**
 * @file acp/session-store.ts
 * @description Per-session JSON persistence for the ACP backend (gap #26
 * slice 4).
 *
 * Each session id maps to one JSON file under the configured directory:
 *
 *   <baseDir>/<sessionId>.json
 *
 * The file holds the running chat history plus the schema version. Writes are
 * atomic (tmp + rename) so a torn read can't corrupt the file. Reads return
 * `null` honestly on ENOENT or schema mismatch — the backend treats that as
 * "session not known to this agent."
 *
 * Path confinement: the sessionId is regex-restricted to `[A-Za-z0-9_-]+` to
 * block path traversal (`..`, `/`, etc.). The default acp-main wiring further
 * constrains baseDir to DATA_DIR.
 *
 * Schema is kept tiny so JSON parsing is cheap on a 100-turn history; if a
 * future slice needs richer state (tool results, attachments, etc.) the
 * `version` field bumps and old files are read with a migration shim.
 */

import { mkdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Per-message role, narrow superset of slice 1's runtime shape. */
export type StoredMessageRole = 'user' | 'assistant' | 'tool';

export interface StoredMessage {
  role: StoredMessageRole;
  content: string;
}

export interface StoredSession {
  /** Persistence schema version — bump on incompatible shape changes. */
  version: 1;
  sessionId: string;
  /** ISO timestamp of first persist. */
  createdAt: string;
  /** ISO timestamp of last persist. */
  updatedAt: string;
  /** Running chat history (FIFO-trimmed by the backend before save). */
  messages: StoredMessage[];
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface SessionStoreOptions {
  /** Directory where per-session JSON files live. Created on first write. */
  baseDir: string;
}

/**
 * Default file-backed session store. Tiny: read / write / delete on a flat
 * directory of JSON files. Returns `null` honestly when a session id is
 * unknown so the backend can answer the spec's "session not found" condition.
 */
export class SessionStore {
  private readonly baseDir: string;

  constructor(options: SessionStoreOptions) {
    if (!options.baseDir) {
      throw new TypeError('SessionStore: baseDir must be a non-empty string');
    }
    this.baseDir = options.baseDir;
  }

  /** Resolve a per-session file path, refusing malformed ids. */
  private resolvePath(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new Error(`SessionStore: invalid sessionId "${sessionId}"`);
    }
    return path.join(this.baseDir, `${sessionId}.json`);
  }

  /** Atomically write the session record. */
  async save(record: StoredSession): Promise<void> {
    const file = this.resolvePath(record.sessionId);
    // mkdirSync({recursive:true}) is idempotent — call unconditionally so two
    // concurrent saves can't race the existsSync → mkdirSync window (verifier
    // LOW 2). Harmless on an already-existing directory.
    mkdirSync(this.baseDir, { recursive: true });
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(record), 'utf8');
    await rename(tmp, file);
  }

  /**
   * Load a session record. Returns `null` for ENOENT, malformed JSON, or
   * schema mismatch — never throws on missing/corrupt sessions, only on
   * malformed ids.
   */
  async load(sessionId: string): Promise<StoredSession | null> {
    const file = this.resolvePath(sessionId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isStoredSession(parsed)) return null;
    if (parsed.sessionId !== sessionId) return null; // tampered file
    return parsed;
  }

  /** Delete a session record. Idempotent on missing files. */
  async delete(sessionId: string): Promise<void> {
    const file = this.resolvePath(sessionId);
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

/** Set of role strings the message validator accepts at runtime. */
const VALID_ROLES: ReadonlySet<StoredMessageRole> = new Set(['user', 'assistant', 'tool']);

/** Structural guard for a {@link StoredSession}. */
export function isStoredSession(v: unknown): v is StoredSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    s['version'] === 1 &&
    typeof s['sessionId'] === 'string' &&
    typeof s['createdAt'] === 'string' &&
    typeof s['updatedAt'] === 'string' &&
    Array.isArray(s['messages']) &&
    s['messages'].every((m) => {
      if (!m || typeof m !== 'object') return false;
      const r = (m as { role?: unknown }).role;
      const c = (m as { content?: unknown }).content;
      // Role MUST be one of the StoredMessageRole values (verifier MED 1 —
      // permitting any non-undefined role let `role: 42` or `role: "system"`
      // slip through, then mis-replayed as a user_message_chunk).
      return typeof r === 'string' && VALID_ROLES.has(r as StoredMessageRole) && typeof c === 'string';
    })
  );
}
