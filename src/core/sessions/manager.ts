/**
 * @file manager.ts
 * @description SessionManager — creates, loads, persists, and archives sessions.
 *
 * Each (channel, peerId) pair owns exactly one active session at a time.
 * Sessions are hot-cached in memory after first load. Persistence is via MindDB.
 *
 * Per-peer message processing is serialized through a KeyedAsyncQueue to prevent
 * race conditions when messages from the same peer arrive in rapid succession.
 */

import { createLogger } from '../shared/index.js';
import { genId } from '../shared/index.js';
import { PATHS } from '../shared/index.js';
import type { MindDB } from '../memory/db.js';
import type { ChannelType } from '../channels/types.js';
import { KeyedAsyncQueue } from './queue.js';
import type { BrainMessage, Session, SessionState } from './types.js';

const log = createLogger('sessions:manager');

/** In-memory session cache entry. */
interface CacheEntry {
  session: Session;
  dirtyAt?: number; // epoch ms of last unsaved modification
  /** Number of messages in session.messages that are already persisted to the DB. */
  persistedMessageCount: number;
}

/**
 * Central session management service.
 *
 * @example
 * ```ts
 * const manager = new SessionManager(db);
 * const session = await manager.getOrCreate('telegram', 'user-123');
 * session.messages.push({ role: 'user', content: 'Hello' });
 * await manager.save(session);
 * ```
 */
// ---------------------------------------------------------------------------
// DM scope mode
// ---------------------------------------------------------------------------

/**
 * 'main'     — one shared session per (channel, peerId) pair regardless of context.
 * 'per-peer' — isolated sessions per peerId; equivalent to 'main' in current model
 *              but semantically signals that each peer gets a fully isolated context.
 */
export type DmScopeMode = 'main' | 'per-peer';

export class SessionManager {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queue = new KeyedAsyncQueue();
  private readonly db: MindDB;
  private readonly MAX_CACHE = 200;
  private readonly dmScope: DmScopeMode;

  /**
   * @param db      - Open MindDB instance.
   * @param dmScope - DM scope mode. Default: 'main'.
   */
  constructor(db: MindDB, dmScope: DmScopeMode = 'main') {
    this.db = db;
    this.dmScope = dmScope;
    log.info({ dbPath: PATHS.MIND_DB, dmScope }, 'SessionManager initialized');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Return the active session for a given peer, creating one if it does not
   * exist. Creation and load are serialized per peer to prevent duplicates.
   *
   * @param channel - Channel type.
   * @param peerId  - Platform-specific peer identifier.
   * @returns The active (possibly freshly created) Session.
   */
  async getOrCreate(channel: ChannelType, peerId: string): Promise<Session> {
    this._validatePeer(channel, peerId);
    const key = this._peerKey(channel, peerId);

    return this.queue.enqueue(key, async () => {
      // Check hot cache first.
      const cached = this.cache.get(key);
      if (cached && cached.session.state === 'active') {
        return cached.session;
      }

      // Try to load from DB.
      const existing = this._loadFromDb(channel, peerId);
      if (existing) {
        this.cache.set(key, { session: existing, persistedMessageCount: existing.messages.length });
        this._evictIfOverLimit();
        log.debug({ channel, peerId, sessionId: existing.id }, 'session loaded from DB');
        return existing;
      }

      // Create new session.
      const session = this._createSession(channel, peerId);
      this._persistToDb(session);
      this.cache.set(key, { session, persistedMessageCount: 0 });
      this._evictIfOverLimit();
      log.info({ channel, peerId, sessionId: session.id }, 'new session created');
      return session;
    });
  }

  /**
   * Retrieve a session by its unique ID from cache or DB.
   *
   * @param sessionId - The session's nanoid.
   * @returns The Session, or undefined if not found.
   */
  async get(sessionId: string): Promise<Session | undefined> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');

    // Check cache
    for (const entry of this.cache.values()) {
      if (entry.session.id === sessionId) return entry.session;
    }

    // Check DB. Populate the cache with the correct persisted-message count so
    // that a subsequent save() only persists newly-appended messages rather than
    // re-inserting the entire hydrated history (which would duplicate it).
    const loaded = this._loadBySessionId(sessionId);
    if (loaded) {
      const key = this._peerKey(loaded.channel, loaded.peerId);
      if (!this.cache.has(key)) {
        this.cache.set(key, { session: loaded, persistedMessageCount: loaded.messages.length });
        this._evictIfOverLimit();
      }
    }
    return loaded;
  }

  /**
   * Persist a session's current state to MindDB.
   * Updates `updatedAt` automatically.
   *
   * @param session - The session to save.
   */
  async save(session: Session): Promise<void> {
    this._validateSession(session);
    session.updatedAt = new Date();

    // Ensure session is in cache before _persistToDb so message tracking works.
    // Seed persistedMessageCount from the DB, NOT 0: this session may have been
    // EVICTED from the cache (the cache is size-limited) while still holding its
    // full in-memory message array. Re-registering at 0 would make _persistToDb
    // re-insert the entire history as duplicates on every post-eviction save —
    // the root of the duplicate-message bug (up to 60 copies of one reply).
    const key = this._peerKey(session.channel, session.peerId);
    if (!this.cache.has(key)) {
      this.cache.set(key, { session, persistedMessageCount: this.db.countMessages?.(session.id) ?? 0 });
      this._evictIfOverLimit();
    }

    this._persistToDb(session);

    const cached = this.cache.get(key);
    if (cached) {
      cached.dirtyAt = undefined; // mark clean
    }

    log.debug({ sessionId: session.id }, 'session saved');
  }

  /**
   * Mark a session as archived. Archived sessions are retained in DB but
   * excluded from `listActive()`. A new session will be created on the next
   * `getOrCreate()` call for the same peer.
   *
   * @param sessionId - ID of the session to archive.
   */
  async archive(sessionId: string): Promise<void> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');

    const session = await this.get(sessionId);
    if (!session) {
      log.warn({ sessionId }, 'archive: session not found');
      return;
    }

    session.state = 'archived';
    session.updatedAt = new Date();
    this._persistToDb(session);

    // Evict from cache so next getOrCreate() starts fresh.
    const key = this._peerKey(session.channel, session.peerId);
    this.cache.delete(key);

    log.info({ sessionId, channel: session.channel, peerId: session.peerId }, 'session archived');
  }

  /**
   * Return all currently active sessions (from cache, backed by DB lookup).
   */
  async listActive(): Promise<Session[]> {
    return this._listActiveFromDb();
  }

  /**
   * Export a session's conversation as a Markdown-formatted transcript.
   *
   * @param sessionId - ID of the session to export.
   * @returns Markdown string, or undefined if session not found.
   */
  async exportSession(sessionId: string): Promise<string | undefined> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');

    const session = await this.get(sessionId);
    if (!session) {
      log.warn({ sessionId }, 'exportSession: session not found');
      return undefined;
    }

    const lines: string[] = [
      `# Session ${session.id}`,
      '',
      `- **Channel:** ${session.channel}`,
      `- **Peer:** ${session.peerId}`,
      `- **State:** ${session.state}`,
      `- **Model:** ${session.model ?? 'unknown'}`,
      `- **Created:** ${session.createdAt.toISOString()}`,
      `- **Updated:** ${session.updatedAt.toISOString()}`,
      '',
      '---',
      '',
    ];

    for (const msg of session.messages) {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      lines.push(`### ${role}`);
      lines.push('');
      lines.push(msg.content);
      if (msg.toolName) {
        lines.push('');
        lines.push(`*Tool: \`${msg.toolName}\`*`);
      }
      lines.push('');
    }

    log.debug({ sessionId, messageCount: session.messages.length }, 'Session exported as markdown');
    return lines.join('\n');
  }

  /**
   * Archive all sessions whose `updatedAt` is older than `olderThanDays` days.
   *
   * @param olderThanDays - Sessions not updated within this many days will be archived.
   * @returns Number of sessions archived.
   */
  async pruneOldSessions(olderThanDays: number): Promise<number> {
    if (typeof olderThanDays !== 'number' || olderThanDays < 1) {
      throw new RangeError('pruneOldSessions: olderThanDays must be >= 1');
    }

    const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs);
    const active = await this.listActive();

    let pruned = 0;
    for (const session of active) {
      if (session.updatedAt < cutoff) {
        await this.archive(session.id);
        pruned++;
      }
    }

    log.info({ olderThanDays, cutoff: cutoff.toISOString(), pruned }, 'Session pruning complete');
    return pruned;
  }

  /**
   * Return the DM scope mode this manager was constructed with.
   */
  get scopeMode(): DmScopeMode {
    return this.dmScope;
  }

  /**
   * Return the active cache size.
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Return the KeyedAsyncQueue so external callers (e.g. MessageRouter) can
   * serialize work against the same per-peer queue.
   */
  get peerQueue(): KeyedAsyncQueue {
    return this.queue;
  }

  // ---------------------------------------------------------------------------
  // DB persistence (synchronous better-sqlite3 calls)
  // ---------------------------------------------------------------------------

  private _persistToDb(session: Session): void {
    try {
      this.db.storeSession({
        id: session.id,
        model: session.model ?? 'unknown',
        title: `${session.channel}:${session.peerId}`,
      });

      // Store session metadata in a separate KV-style chunk so we can
      // reconstruct the session object. We use a deterministic path.
      const metaPath = `session:${session.id}:meta`;
      const meta = JSON.stringify({
        id: session.id,
        channel: session.channel,
        peerId: session.peerId,
        state: session.state,
        model: session.model,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      });

      this.db.storeChunk(meta, metaPath, 'conversation', { isEvergreen: true, role: 'system' });

      // Persist any new messages that have not yet been written to the DB.
      const key = this._peerKey(session.channel, session.peerId);
      const cached = this.cache.get(key);
      // Never assume 0 on a cache miss — reconcile against the DB so an evicted
      // session doesn't re-insert its whole history (duplicate-message bug).
      const alreadyPersisted = cached?.persistedMessageCount ?? this.db.countMessages?.(session.id) ?? 0;
      const totalMessages = session.messages.length;

      if (totalMessages > alreadyPersisted) {
        const newMessages = session.messages.slice(alreadyPersisted);
        let failed = 0;
        for (const msg of newMessages) {
          try {
            this.db.storeMessage(session.id, msg.role, msg.content ?? '', {
              tool_name:  msg.toolName  ?? undefined,
              tool_input: msg.toolInput ?? undefined,
              tool_output: msg.toolOutput ?? undefined,
            });
          } catch (msgErr) {
            // A single un-persistable message (e.g. an injection-scanner
            // rejection in strict mode) must NEVER abort the loop and silently
            // drop every later message — including the turn's final assistant
            // reply. That was the live "runs tools then goes quiet" bug. Log,
            // skip, and keep going so the rest of the turn still persists.
            failed++;
            log.error(
              { sessionId: session.id, role: msg.role, err: String(msgErr) },
              'storeMessage failed — skipping this message, continuing persist',
            );
          }
        }
        // Advance the counter past EVERY message we attempted (stored or skipped)
        // so a poison message is not retried forever and clean messages are not
        // re-inserted as duplicates on the next save.
        if (cached) {
          cached.persistedMessageCount = totalMessages;
        }
        log.debug(
          { sessionId: session.id, newCount: newMessages.length - failed, skipped: failed, total: totalMessages },
          'Messages persisted to DB',
        );
      }
    } catch (err) {
      log.error({ sessionId: session.id, err }, 'Failed to persist session to DB');
      throw err;
    }
  }

  private _loadFromDb(channel: ChannelType, peerId: string): Session | undefined {
    try {
      // Find the active session chunk for this peer.
      // Scan all session meta rows newest-first. We cannot filter by
      // channel/peerId in SQL because those live inside the JSON `text` blob,
      // and meta rows accumulate (storeChunk dedups by content hash, but
      // `updatedAt` changes on every save). A LIMIT here would only cover the
      // most-recently-saved sessions across ALL peers and could miss this
      // peer's active session entirely. Mirrors _listActiveFromDb's unlimited scan.
      const rows = this.db.db
        .prepare<{ path: string }, { text: string; path: string }>(
          `SELECT text, path FROM chunks WHERE path LIKE :path AND source = 'conversation' ORDER BY rowid DESC`,
        )
        .all({ path: `session:%:meta` });

      for (const row of rows) {
        try {
          const meta = JSON.parse(row.text) as {
            id: string;
            channel: string;
            peerId: string;
            state: string;
            model?: string;
            createdAt: string;
            updatedAt: string;
          };
          if (
            meta.channel === channel &&
            meta.peerId === peerId &&
            meta.state === 'active'
          ) {
            return this._hydrateSession(meta);
          }
        } catch {
          // malformed row — skip
        }
      }
      return undefined;
    } catch (err) {
      log.error({ channel, peerId, err }, 'Failed to load session from DB');
      return undefined;
    }
  }

  private _loadBySessionId(sessionId: string): Session | undefined {
    try {
      const metaPath = `session:${sessionId}:meta`;
      const chunk = this.db.db
        .prepare<{ path: string }, { text: string }>(
          `SELECT text FROM chunks WHERE path = :path ORDER BY rowid DESC LIMIT 1`,
        )
        .get({ path: metaPath });

      if (!chunk) return undefined;

      const meta = JSON.parse(chunk.text) as {
        id: string;
        channel: string;
        peerId: string;
        state: string;
        model?: string;
        createdAt: string;
        updatedAt: string;
      };

      return this._hydrateSession(meta);
    } catch (err) {
      log.error({ sessionId, err }, 'Failed to load session by ID from DB');
      return undefined;
    }
  }

  private _listActiveFromDb(): Session[] {
    try {
      const rows = this.db.db
        .prepare<Record<string, never>, { text: string }>(
          `SELECT text FROM chunks WHERE path LIKE 'session:%:meta' AND source = 'conversation' ORDER BY rowid DESC`,
        )
        .all({});

      const seen = new Set<string>(); // dedupe by id
      const sessions: Session[] = [];

      for (const row of rows) {
        try {
          const meta = JSON.parse(row.text) as {
            id: string;
            channel: string;
            peerId: string;
            state: string;
            model?: string;
            createdAt: string;
            updatedAt: string;
          };
          if (meta.state === 'active' && !seen.has(meta.id)) {
            seen.add(meta.id);
            sessions.push(this._hydrateSession(meta));
          }
        } catch {
          // malformed — skip
        }
      }

      return sessions;
    } catch (err) {
      log.error({ err }, 'Failed to list active sessions from DB');
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _createSession(channel: ChannelType, peerId: string): Session {
    const now = new Date();
    return {
      id: genId(),
      channel,
      peerId,
      state: 'active',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private _hydrateSession(meta: {
    id: string;
    channel: string;
    peerId: string;
    state: string;
    model?: string;
    createdAt: string;
    updatedAt: string;
  }): Session {
    // Load recent messages from DB.
    const dbMessages = this.db.getSessionMessages(meta.id, 100);
    const messages: BrainMessage[] = dbMessages.map((m) => ({
      role: m.role,
      content: m.content,
      toolName: m.tool_name ?? undefined,
      toolInput: m.tool_input ?? undefined,
      toolOutput: m.tool_output ?? undefined,
    }));

    return {
      id: meta.id,
      channel: meta.channel as ChannelType,
      peerId: meta.peerId,
      state: meta.state as SessionState,
      model: meta.model,
      messages,
      createdAt: new Date(meta.createdAt),
      updatedAt: new Date(meta.updatedAt),
    };
  }

  private _peerKey(channel: ChannelType, peerId: string): string {
    return `${channel}:${peerId}`;
  }

  private _validatePeer(channel: ChannelType, peerId: string): void {
    if (!channel) throw new TypeError('channel must not be empty');
    if (!peerId) throw new TypeError('peerId must not be empty');
  }

  /** Evict the oldest cache entry when the cache exceeds MAX_CACHE. */
  private _evictIfOverLimit(): void {
    if (this.cache.size > this.MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        log.debug({ evictedKey: oldest, cacheSize: this.cache.size }, 'session cache entry evicted');
      }
    }
  }

  private _validateSession(session: Session): void {
    if (!session?.id) throw new TypeError('session.id must not be empty');
    if (!session.channel) throw new TypeError('session.channel must not be empty');
    if (!session.peerId) throw new TypeError('session.peerId must not be empty');
  }
}
