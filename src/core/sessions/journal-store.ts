/**
 * @file journal-store.ts
 * @description JournalSessionStore — append-only JSONL session persistence.
 *
 * Layout under baseDir (default ~/.sudo-ai/sessions):
 *   sessions.json          — index of all sessions (see journal-index.ts)
 *   {agentId}/{uuid}.jsonl — one JSONL file per session
 *
 * agentId = first 12 hex chars of SHA-256("{channel}:{peerId}").
 * All disk writes are synchronous (appendFileSync / writeFileSync) so they
 * never block the async event loop with dangling promise chains.
 * All reads are wrapped in try/catch; missing files silently return undefined.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { createLogger } from '../shared/logger.js';
import type { ChannelType } from '../channels/types.js';
import type { Session } from './types.js';
import type {
  JournalEvent,
  JournalMessage,
  JournalSessionCreated,
  SessionIndex,
  SessionIndexEntry,
} from './journal-types.js';
import { readIndex, writeIndex, findEntry, findActiveEntry } from './journal-index.js';

const log = createLogger('sessions:journal-store');

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function deriveAgentId(channel: string, peerId: string): string {
  return createHash('sha256')
    .update(`${channel}:${peerId}`)
    .digest('hex')
    .slice(0, 12);
}

function toJsonlLine(event: JournalEvent): string {
  return JSON.stringify(event);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// JournalSessionStore
// ---------------------------------------------------------------------------

export class JournalSessionStore {
  private readonly baseDir: string;
  private readonly indexPath: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.sudo-ai', 'sessions');
    this.indexPath = path.join(this.baseDir, 'sessions.json');
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (err) {
      log.error({ baseDir: this.baseDir, err }, 'constructor: cannot create base directory');
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async get(sessionId: string): Promise<Session | undefined> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');
    const entry = findEntry(readIndex(this.indexPath), sessionId);
    if (!entry) return undefined;
    return this._hydrate(entry);
  }

  async save(session: Session): Promise<void> {
    this._validate(session);
    const index = readIndex(this.indexPath);
    const entry = findEntry(index, session.id);
    if (!entry) {
      log.warn({ sessionId: session.id }, 'save: session not found in index');
      return;
    }
    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg) {
      const event: JournalMessage = {
        ts: nowIso(),
        sessionId: session.id,
        type: 'message',
        role: lastMsg.role,
        content: lastMsg.content,
        ...(lastMsg.toolName !== undefined && { toolName: lastMsg.toolName }),
      };
      this._writeEvent(entry, event);
    }
    entry.updatedAt = nowIso();
    if (session.state === 'archived') entry.state = 'archived';
    writeIndex(this.indexPath, index);
    log.debug({ sessionId: session.id }, 'session saved');
  }

  async archive(sessionId: string): Promise<void> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');
    const index = readIndex(this.indexPath);
    const entry = findEntry(index, sessionId);
    if (!entry) {
      log.warn({ sessionId }, 'archive: session not in index');
      return;
    }
    entry.state = 'archived';
    entry.updatedAt = nowIso();
    writeIndex(this.indexPath, index);
    log.info({ sessionId }, 'session archived');
  }

  async getOrCreate(channel: ChannelType, peerId: string): Promise<Session> {
    if (!channel) throw new TypeError('channel must not be empty');
    if (!peerId) throw new TypeError('peerId must not be empty');

    const index = readIndex(this.indexPath);
    const agentId = deriveAgentId(channel, peerId);
    const existing = findActiveEntry(index, channel, peerId);
    if (existing) {
      const session = this._hydrate(existing);
      if (session) return session;
      log.warn({ sessionId: existing.id }, 'getOrCreate: JSONL missing, creating new session');
    }

    const sessionId = nanoid();
    const now = nowIso();
    const relFile = `${agentId}/${sessionId}.jsonl`;
    const absFile = path.join(this.baseDir, agentId, `${sessionId}.jsonl`);

    mkdirSync(path.dirname(absFile), { recursive: true });

    const createdEvent: JournalSessionCreated = {
      ts: now,
      sessionId,
      type: 'session',
      channel,
      peerId,
    };
    writeFileSync(absFile, toJsonlLine(createdEvent) + '\n', 'utf8');

    const newEntry: SessionIndexEntry = {
      id: sessionId,
      channel,
      peerId,
      agentId,
      file: relFile,
      createdAt: now,
      updatedAt: now,
      state: 'active',
    };
    index.entries.push(newEntry);
    writeIndex(this.indexPath, index);
    log.info({ sessionId, agentId }, 'new session created');

    return this._buildSession(newEntry, []);
  }

  async appendEvent(sessionId: string, event: JournalEvent): Promise<void> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');
    const index = readIndex(this.indexPath);
    const entry = findEntry(index, sessionId);
    if (!entry) {
      log.warn({ sessionId }, 'appendEvent: session not in index');
      return;
    }
    this._writeEvent(entry, event);
    writeIndex(this.indexPath, index);
  }

  async listSessions(agentId?: string): Promise<SessionIndexEntry[]> {
    const index = readIndex(this.indexPath);
    if (!agentId) return index.entries;
    return index.entries.filter((e) => e.agentId === agentId);
  }

  /**
   * Absolute path on disk where this session's JSONL lives. Returns
   * undefined when the session is not in the index. Exposed for crash-safe
   * callers that need to fsync the file after a write.
   */
  getFilePath(sessionId: string): string | undefined {
    if (!sessionId) return undefined;
    const entry = findEntry(readIndex(this.indexPath), sessionId);
    if (!entry) return undefined;
    const absFile = path.resolve(this.baseDir, entry.file);
    if (!absFile.startsWith(path.resolve(this.baseDir) + path.sep)) return undefined;
    return absFile;
  }

  /** Base directory holding all session JSONL files. */
  get journalDir(): string {
    return this.baseDir;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Synchronously append one JSONL line; updates entry.updatedAt in-place.
   * THROWS on write failure (gap #17 — was previously silent, but the
   * crash-safe path in DualSessionManager relies on save() propagating
   * disk-full / EACCES so it can refuse to mirror the message to SQLite).
   * Legacy callers (DualSessionManager.save/appendEvent default path)
   * already wrap journal calls in try/catch and downgrade to a warn log,
   * so this stays non-fatal for them.
   */
  private _writeEvent(entry: SessionIndexEntry, event: JournalEvent): void {
    const absFile = path.resolve(this.baseDir, entry.file);
    if (!absFile.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`journal: entry.file ${entry.file} escapes baseDir`);
    }
    appendFileSync(absFile, toJsonlLine(event) + '\n', 'utf8');
    entry.updatedAt = nowIso();
  }

  /** Reconstruct a Session by replaying the JSONL file. Returns undefined on error. */
  private _hydrate(entry: SessionIndexEntry): Session | undefined {
    const absFile = path.resolve(this.baseDir, entry.file);
    if (!absFile.startsWith(path.resolve(this.baseDir) + path.sep)) {
      log.error({ entry: { file: entry.file } }, 'entry.file escapes baseDir — rejecting');
      return undefined;
    }
    try {
      if (!existsSync(absFile)) return undefined;
      const raw = readFileSync(absFile, 'utf8');
      const messages: Session['messages'] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as JournalEvent;
          if (ev.type === 'message') {
            messages.push({
              role: ev.role,
              content: ev.content,
              ...(ev.toolName !== undefined && { toolName: ev.toolName }),
            });
          }
        } catch { /* malformed line — skip */ }
      }
      return this._buildSession(entry, messages);
    } catch (err) {
      log.warn({ sessionId: entry.id, err }, '_hydrate: read error');
      return undefined;
    }
  }

  private _buildSession(entry: SessionIndexEntry, messages: Session['messages']): Session {
    return {
      id: entry.id,
      channel: entry.channel as ChannelType,
      peerId: entry.peerId,
      state: entry.state,
      messages,
      createdAt: new Date(entry.createdAt),
      updatedAt: new Date(entry.updatedAt),
    };
  }

  private _validate(session: Session): void {
    if (!session?.id) throw new TypeError('session.id must not be empty');
    if (!session.channel) throw new TypeError('session.channel must not be empty');
    if (!session.peerId) throw new TypeError('session.peerId must not be empty');
  }
}
