/**
 * @file dual-manager.ts
 * @description DualSessionManager — wraps SessionManager (SQLite primary) and
 * JournalSessionStore (JSONL secondary) behind a single duck-typed interface.
 *
 * Read policy  : primary only — the SQLite store is the authoritative source of truth.
 * Write policy : both stores; primary failure throws; journal failure logs warning only.
 *
 * This lets callers transparently persist sessions to both backends without knowing the
 * underlying stores exist.
 */

import { createLogger } from '../shared/logger.js';
import type { ChannelType } from '../channels/types.js';
import type { Session } from './types.js';
import type { SessionManager } from './manager.js';
import type { JournalSessionStore } from './journal-store.js';
import type { KeyedAsyncQueue } from './queue.js';
import type { DmScopeMode } from './manager.js';
import type { JournalEvent } from './journal-types.js';

const log = createLogger('sessions:dual-manager');

// ---------------------------------------------------------------------------
// DualSessionManager
// ---------------------------------------------------------------------------

/**
 * Facade over SessionManager (primary / SQLite) and JournalSessionStore
 * (secondary / JSONL).  All methods present the same duck-typed surface as
 * SessionManager so the rest of the codebase can swap to DualSessionManager
 * without changing call sites.
 *
 * @example
 * ```ts
 * const dual = new DualSessionManager(sessionManager, journalStore);
 * const session = await dual.getOrCreate('telegram', 'user-123');
 * session.messages.push({ role: 'user', content: 'Hello' });
 * await dual.save(session);
 * ```
 */
export class DualSessionManager {
  private readonly primary: SessionManager;
  private readonly journal: JournalSessionStore;

  constructor(primary: SessionManager, journal: JournalSessionStore) {
    if (!primary) throw new TypeError('DualSessionManager: primary must not be null');
    if (!journal) throw new TypeError('DualSessionManager: journal must not be null');
    this.primary = primary;
    this.journal = journal;
    log.info('DualSessionManager initialized');
  }

  // ---------------------------------------------------------------------------
  // Reads — primary only
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a session by its unique ID.
   * Reads from the primary SQLite store only.
   */
  async get(sessionId: string): Promise<Session | undefined> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');
    return this.primary.get(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Writes — primary + journal (dual write)
  // ---------------------------------------------------------------------------

  /**
   * Persist a session.  Writes to primary first (throws on failure), then to
   * journal (logs warning on failure — never throws).
   */
  async save(session: Session): Promise<void> {
    // Primary write — failure is fatal
    await this.primary.save(session);

    // Journal write — failure is non-fatal
    try {
      await this.journal.save(session);
    } catch (err) {
      log.warn({ sessionId: session.id, err: String(err) }, 'dual-manager: journal save failed (non-fatal)');
    }
  }

  /**
   * Archive a session.  Archives on primary first (throws on failure), then on
   * journal (logs warning on failure — never throws).
   */
  async archive(sessionId: string): Promise<void> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');

    // Primary archive — failure is fatal
    await this.primary.archive(sessionId);

    // Journal archive — failure is non-fatal
    try {
      await this.journal.archive(sessionId);
    } catch (err) {
      log.warn({ sessionId, err: String(err) }, 'dual-manager: journal archive failed (non-fatal)');
    }
  }

  /**
   * Return the active session for a given peer, creating one if it does not exist.
   * Creates/loads on primary first (throws on failure), then mirrors to journal
   * (logs warning on failure — never throws).
   */
  async getOrCreate(channel: ChannelType, peerId: string): Promise<Session> {
    if (!channel) throw new TypeError('channel must not be empty');
    if (!peerId) throw new TypeError('peerId must not be empty');

    // Primary is authoritative for read + create
    const session = await this.primary.getOrCreate(channel, peerId);

    // Mirror creation to journal — non-fatal
    try {
      await this.journal.getOrCreate(channel, peerId);
    } catch (err) {
      log.warn(
        { channel, peerId, sessionId: session.id, err: String(err) },
        'dual-manager: journal getOrCreate failed (non-fatal)',
      );
    }

    return session;
  }

  // ---------------------------------------------------------------------------
  // Delegated getters — primary only
  // ---------------------------------------------------------------------------

  /**
   * Per-peer serialization queue from the primary SessionManager.
   * External callers (e.g. MessageRouter) can enqueue work against this queue
   * to maintain ordering guarantees identical to using SessionManager directly.
   */
  get peerQueue(): KeyedAsyncQueue {
    return this.primary.peerQueue;
  }

  /**
   * DM scope mode of the primary SessionManager ('main' | 'per-peer').
   */
  get scopeMode(): DmScopeMode {
    return this.primary.scopeMode;
  }

  /**
   * Current size of the primary session in-memory cache.
   */
  get cacheSize(): number {
    return this.primary.cacheSize;
  }

  /**
   * Return all currently active sessions (delegates to primary).
   */
  async listActive(): Promise<Session[]> {
    return this.primary.listActive();
  }

  /**
   * Append a real-time event to the JSONL journal.
   * Non-fatal — journal failures only log warnings.
   */
  async appendEvent(sessionId: string, event: JournalEvent): Promise<void> {
    try {
      await this.journal.appendEvent(sessionId, event);
    } catch (err) {
      log.warn(
        { sessionId, type: event.type, err: String(err) },
        'dual-manager: journal appendEvent failed (non-fatal)',
      );
    }
  }
}
