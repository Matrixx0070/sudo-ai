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
import { attachWriteThrough } from './write-through.js';
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
  /**
   * How many recent messages to load into the working set on a cold reload
   * (restart / cache eviction). Default 100 was only ~7-8 turns once per-turn
   * system blocks (Today/brief/commitments) are counted. Raise via
   * SUDO_HYDRATE_MESSAGE_LIMIT to restore more conversation after a restart —
   * the MAX_CONTEXT_TOKENS budget + compaction bound what actually reaches the
   * model, so a larger reload is safe (worst case: one compaction on reload).
   */
  private readonly HYDRATE_LIMIT: number = (() => {
    const raw = Number(process.env['SUDO_HYDRATE_MESSAGE_LIMIT']);
    return Number.isInteger(raw) && raw >= 20 ? raw : 100;
  })();
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

    // Windowing/compaction/fork REASSIGN session.messages to a fresh array,
    // shedding the write-through wrapper; re-attach here (idempotent) so the
    // wrapper gap never outlives one save. Messages appended during the gap
    // are caught by the identity scan below.
    attachWriteThrough(session, this.db);

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

      // Phase 2b — meta upsert: storeChunk APPENDS a row each save, so a session's
      // meta accumulated (one session had 9 'active' + 4 'archived' rows). That
      // let an archived session be re-loaded via a stale older 'active' row (the
      // no-op fork loop, #445). Replace this session's prior meta rows so exactly
      // one current meta row exists. Best-effort; correctness is already covered
      // by _loadFromDb's newest-meta-per-id (#445).
      try {
        this.db.db.prepare("DELETE FROM chunks WHERE path = ? AND source = 'conversation'").run(metaPath);
      } catch (delErr) {
        log.warn({ sessionId: session.id, err: String(delErr) }, 'meta upsert: prior-row delete failed (non-fatal)');
      }
      this.db.storeChunk(meta, metaPath, 'conversation', { isEvergreen: true, role: 'system' });

      // Persist any new messages that have not yet been written to the DB.
      const key = this._peerKey(session.channel, session.peerId);
      const cached = this.cache.get(key);

      if (process.env['SUDO_IDENTITY_PERSIST'] !== '0') {
        // Phase 2a — identity-based persistence. Each message carries a (non-DB)
        // `_persisted` marker once written. We persist any message lacking it.
        // Unlike the legacy positional `slice(persistedMessageCount)`, this
        // survives in-memory array mutation — the fork's unshift,
        // trimSessionMessages, and windowing `.map(m => ({...m}))` (the spread
        // copies the enumerable marker) — so no turn's messages are dropped or
        // duplicated across a fork/trim (the original "lost chats" failure mode).
        // Hydrated messages are pre-marked at load (they came FROM the DB).
        let persisted = 0;
        let failed = 0;
        let skippedEphemeral = 0;
        const persistEphemeral = process.env['SUDO_PERSIST_EPHEMERAL'] === '1';
        for (const msg of session.messages) {
          const m = msg as BrainMessage & { _persisted?: boolean; _ephemeral?: boolean; _durable?: boolean };
          if (m._persisted === true) continue;
          // System messages are ephemeral turn-scaffolding by default — the agent
          // loop re-generates them every turn from live state (intelligence brief,
          // routing notes, idle nudges, LoopGuard, commitments, daily memory logs,
          // …). On the live DB these were the LARGEST role (system 2.5x user),
          // diluting the hydrate reload window with stale, re-injected noise. We
          // persist a system message ONLY when explicitly marked `_durable` (the
          // session-fork handoff notice). `_ephemeral` also forces a skip for any
          // role. We mark skipped messages persisted so the per-message bookkeeping
          // stays consistent. Kill-switch SUDO_PERSIST_EPHEMERAL=1 restores write-all.
          const skip = m._ephemeral === true || (msg.role === 'system' && m._durable !== true);
          if (skip && !persistEphemeral) {
            m._persisted = true;
            skippedEphemeral++;
            continue;
          }
          try {
            this.db.storeMessage(session.id, msg.role, msg.content ?? '', {
              tool_name:  msg.toolName  ?? undefined,
              tool_input: msg.toolInput ?? undefined,
              tool_output: msg.toolOutput ?? undefined,
            });
            persisted++;
          } catch (msgErr) {
            failed++;
            log.error(
              { sessionId: session.id, role: msg.role, err: String(msgErr) },
              'storeMessage failed — skipping this message, continuing persist',
            );
          }
          m._persisted = true; // mark even on failure: never retry a poison message forever
        }
        if (cached) cached.persistedMessageCount = session.messages.length;
        if (persisted > 0 || failed > 0 || skippedEphemeral > 0) {
          log.debug(
            { sessionId: session.id, newCount: persisted, skipped: failed, skippedEphemeral, total: session.messages.length },
            'Messages persisted to DB (identity)',
          );
        }
      } else {
        // Legacy positional path (kill-switch SUDO_IDENTITY_PERSIST=0). Fragile
        // under array mutation; kept only as an escape hatch.
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
              failed++;
              log.error(
                { sessionId: session.id, role: msg.role, err: String(msgErr) },
                'storeMessage failed — skipping this message, continuing persist',
              );
            }
          }
          if (cached) cached.persistedMessageCount = totalMessages;
          log.debug(
            { sessionId: session.id, newCount: newMessages.length - failed, skipped: failed, total: totalMessages },
            'Messages persisted to DB',
          );
        }
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

      // Meta rows are append-only (storeChunk writes a NEW row on every save —
      // state/updatedAt change so the content hash differs), and the scan is
      // newest-first. Therefore the FIRST meta row seen for a given session id
      // is its CURRENT state. Decide each id by its newest meta ONLY: a stale
      // older 'active' row must never resurrect a session that has since been
      // archived. That resurrection was the no-op fork loop — a telegram session
      // past the fork threshold got archived then immediately re-loaded as
      // 'active' (via an older meta row) every turn, so the fork never rotated
      // and each turn's messages were lost.
      const resolvedIds = new Set<string>();
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
          if (meta.channel !== channel || meta.peerId !== peerId) continue;
          if (resolvedIds.has(meta.id)) continue; // already saw this id's newest meta
          resolvedIds.add(meta.id);
          if (meta.state === 'active') {
            return this._hydrateSession(meta);
          }
          // newest meta for this id is non-active → keep scanning for a DIFFERENT active id
        } catch {
          // malformed row — skip (does not mark any id as resolved)
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
    const session: Session = {
      id: genId(),
      channel,
      peerId,
      state: 'active',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    // Appends persist immediately from birth; the save() scan stays as the net.
    attachWriteThrough(session, this.db);
    return session;
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
    const dbMessages = this.db.getSessionMessages(meta.id, this.HYDRATE_LIMIT);
    const messages: BrainMessage[] = dbMessages.map((m) => ({
      role: m.role,
      content: m.content,
      toolName: m.tool_name ?? undefined,
      toolInput: m.tool_input ?? undefined,
      toolOutput: m.tool_output ?? undefined,
    }));
    // These came FROM the DB → mark persisted so identity-based persistence does
    // not re-insert the whole history as duplicates on the next save.
    for (const m of messages) (m as BrainMessage & { _persisted?: boolean })._persisted = true;

    const session: Session = {
      id: meta.id,
      channel: meta.channel as ChannelType,
      peerId: meta.peerId,
      state: meta.state as SessionState,
      model: meta.model,
      messages,
      createdAt: new Date(meta.createdAt),
      updatedAt: new Date(meta.updatedAt),
    };
    // Hydrated rows are pre-marked above, so attaching cannot re-persist them.
    attachWriteThrough(session, this.db);
    return session;
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
