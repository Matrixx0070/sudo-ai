/**
 * @file dual-manager.ts
 * @description DualSessionManager — wraps SessionManager (SQLite primary) and
 * JournalSessionStore (JSONL secondary) behind a single duck-typed interface.
 *
 * Read policy: primary only — the SQLite store is the authoritative source.
 *
 * Write policy depends on the `crashSafe` constructor flag:
 *
 *   - crashSafe:false (default) — primary first (failure throws), then
 *     journal best-effort (failure logs warning, does not throw). Byte-
 *     identical to the pre-gap-#17 behaviour.
 *   - crashSafe:true (gap #17) — journal first WITH fsync (failure throws),
 *     then primary (failure throws). The slow-but-safe path. Guarantees
 *     "SQLite never leads JSONL" so a crash between the two writes leaves
 *     the journal as the more-complete store, recoverable on next boot via
 *     `scanInterruptedSessions`.
 *
 * Lifecycle methods (`archive`) follow the same per-mode contract.
 */

import { createLogger } from '../shared/logger.js';
import type { ChannelType } from '../channels/types.js';
import type { Session } from './types.js';
import type { SessionManager } from './manager.js';
import type { JournalSessionStore } from './journal-store.js';
import type { KeyedAsyncQueue } from './queue.js';
import type { DmScopeMode } from './manager.js';
import type { JournalEvent } from './journal-types.js';
import { fsyncFile } from './crash-safe.js';
import { readIndex, writeIndex, findActiveEntry } from './journal-index.js';

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
export interface DualSessionManagerOptions {
  /**
   * When true (gap #17 crash-safe ordering), `save()` writes the JSONL
   * journal FIRST with a follow-up fsync, then the SQLite primary. A
   * crash between the two leaves the journal as the more-complete store,
   * which the boot-time scanner detects. Default false preserves the
   * existing SQLite-first ordering byte-identically for callers that have
   * not asked for the invariant.
   */
  crashSafe?: boolean;
}

export class DualSessionManager {
  private readonly primary: SessionManager;
  private readonly journal: JournalSessionStore;
  private readonly crashSafe: boolean;

  constructor(
    primary: SessionManager,
    journal: JournalSessionStore,
    options: DualSessionManagerOptions = {},
  ) {
    if (!primary) throw new TypeError('DualSessionManager: primary must not be null');
    if (!journal) throw new TypeError('DualSessionManager: journal must not be null');
    this.primary = primary;
    this.journal = journal;
    this.crashSafe = options.crashSafe ?? false;
    log.info({ crashSafe: this.crashSafe }, 'DualSessionManager initialized');
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
   * Persist a session.
   *
   * Default ordering (crashSafe:false): primary first (throws on failure),
   * then journal (logs warning on failure — never throws). Byte-identical
   * to the pre-gap-#17 behaviour.
   *
   * Crash-safe ordering (crashSafe:true): journal first WITH fsync (throws
   * on failure), then primary (also throws on failure). A crash between
   * the journal write and the primary write leaves the JSONL as the
   * more-complete store; the boot-time scanInterruptedSessions detector
   * surfaces the divergence. Journal failure throws here because in the
   * crash-safe mode the journal is the authoritative log and we must not
   * mirror to SQLite something we couldn't durably log.
   */
  async save(session: Session): Promise<void> {
    if (this.crashSafe) {
      // Journal first — fatal on failure (we will NOT mirror to SQLite
      // anything that did not durably hit the log).
      await this.journal.save(session);
      const filePath = this.journal.getFilePath(session.id);
      if (filePath) fsyncFile(filePath);

      // Primary second.
      await this.primary.save(session);
      return;
    }

    // Legacy ordering: primary first, journal best-effort.
    await this.primary.save(session);
    try {
      await this.journal.save(session);
    } catch (err) {
      log.warn({ sessionId: session.id, err: String(err) }, 'dual-manager: journal save failed (non-fatal)');
    }
  }

  /**
   * Archive a session. Same per-mode contract as save(): crashSafe:true →
   * journal first (fatal), primary second (fatal); crashSafe:false →
   * primary first (fatal), journal best-effort (warn-only).
   */
  async archive(sessionId: string): Promise<void> {
    if (!sessionId) throw new TypeError('sessionId must not be empty');

    if (this.crashSafe) {
      await this.journal.archive(sessionId);
      const filePath = this.journal.getFilePath(sessionId);
      if (filePath) fsyncFile(filePath);
      await this.primary.archive(sessionId);
      return;
    }

    await this.primary.archive(sessionId);
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
   *
   * Drift reconciliation: SQLite primary and the journal-store allocate IDs
   * independently. Older journals (created before the dual-store wiring) carry
   * a different nanoid than the SQLite primary for the same (channel, peerId)
   * pair, which silently breaks every subsequent save/appendEvent keyed off
   * the primary id. After both stores resolve, if the journal's active entry
   * has a different id, the primary id is recorded under journal.aliases[]
   * so future lookups via findEntry resolve correctly. No JSONL files are
   * renamed; the existing 122-msg history under the original id is preserved.
   */
  async getOrCreate(channel: ChannelType, peerId: string): Promise<Session> {
    if (!channel) throw new TypeError('channel must not be empty');
    if (!peerId) throw new TypeError('peerId must not be empty');

    // Primary is authoritative for read + create
    const session = await this.primary.getOrCreate(channel, peerId);

    // Mirror creation to journal — non-fatal
    try {
      const journalSession = await this.journal.getOrCreate(channel, peerId);
      if (journalSession.id !== session.id) {
        this._aliasPrimaryId(channel, peerId, journalSession.id, session.id);
      }
    } catch (err) {
      log.warn(
        { channel, peerId, sessionId: session.id, err: String(err) },
        'dual-manager: journal getOrCreate failed (non-fatal)',
      );
    }

    return session;
  }

  /**
   * Add `primaryId` to the journal entry's aliases[] so future findEntry calls
   * keyed off the primary id resolve to this entry. Idempotent (no-op if the
   * alias is already present). Failures are warn-only — alias write must never
   * break the session flow.
   */
  private _aliasPrimaryId(
    channel: ChannelType,
    peerId: string,
    journalId: string,
    primaryId: string,
  ): void {
    try {
      const indexPath = `${this.journal.journalDir}/sessions.json`;
      const index = readIndex(indexPath);
      const entry = findActiveEntry(index, channel, peerId);
      if (!entry) return;
      if (entry.id === primaryId) return;
      if (entry.aliases?.includes(primaryId)) return;
      entry.aliases = [...(entry.aliases ?? []), primaryId];
      writeIndex(indexPath, index);
      log.info(
        { channel, peerId, journalId, primaryId },
        'dual-manager: journal-id drift reconciled via alias',
      );
    } catch (err) {
      log.warn(
        { channel, peerId, journalId, primaryId, err: String(err) },
        'dual-manager: alias write failed (non-fatal)',
      );
    }
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
