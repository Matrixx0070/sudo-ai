/**
 * @file cross-channel-memory.ts
 * @description Persistent, cross-channel conversation store backed by
 * better-sqlite3.  Allows the brain to retrieve a user's message history
 * regardless of which transport (Telegram, Discord, WhatsApp, …) the
 * messages arrived on.
 *
 * The table is created on first instantiation if it does not already exist.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { guardMemoryWrite, type MessageRole } from '../memory/injection-scanner.js';
import { DATA_DIR } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All supported channel transports.  Extends the base `ChannelType` in
 * `./types.ts` with `electron` and `voice` for desktop and audio channels.
 */
export type ChannelType =
  | 'telegram'
  | 'whatsapp'
  | 'discord'
  | 'slack'
  | 'signal'
  | 'matrix'
  | 'irc'
  | 'web'
  | 'electron'
  | 'voice';

export interface CrossChannelMessage {
  id: number;
  channel: ChannelType;
  peerId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const DDL = `
  CREATE TABLE IF NOT EXISTS cross_channel_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    channel   TEXT NOT NULL,
    peer_id   TEXT NOT NULL,
    role      TEXT NOT NULL,
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ccm_peer
    ON cross_channel_messages(peer_id, timestamp DESC);
`;

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * Stores and retrieves conversation messages across all channel types.
 *
 * Usage:
 * ```ts
 * const mem = new CrossChannelMemory();
 * mem.storeMessage('telegram', 'user123', 'Hello!', 'user');
 * const ctx = mem.retrieveContext('telegram', 'user123', 20);
 * ```
 */
export class CrossChannelMemory {
  private db: Database.Database;

  constructor(dbPath: string = path.join(DATA_DIR, 'mind.db')) {
    this.db = new Database(dbPath);
    this.db.exec(DDL);
  }

  /**
   * Persist a single message to the store.
   *
   * @param channel - Transport the message arrived on / will be sent via.
   * @param peerId  - Platform-specific identifier for the user/peer.
   * @param content - Plain-text message body.
   * @param role    - Whether this message is from the user or the assistant.
   */
  storeMessage(
    channel: ChannelType,
    peerId: string,
    content: string,
    role: 'user' | 'assistant',
  ): void {
    // Security: scan for prompt-injection before persisting.
    // In strict mode, MemoryInjectionError propagates to callers.
    // In sanitize mode, content is replaced with the cleaned version.
    const safeContent = guardMemoryWrite(content, 'CrossChannelMemory.storeMessage', role as MessageRole);
    this.db
      .prepare(
        'INSERT INTO cross_channel_messages (channel, peer_id, role, content, timestamp) VALUES (?,?,?,?,?)',
      )
      .run(channel, peerId, role, safeContent, new Date().toISOString());
  }

  /**
   * Retrieve the most recent messages for a peer on a specific channel,
   * returned in chronological order (oldest first).
   *
   * @param channel - Channel to filter by.
   * @param peerId  - Peer to filter by.
   * @param limit   - Maximum number of messages to return (default 20).
   */
  retrieveContext(
    channel: ChannelType,
    peerId: string,
    limit: number = 20,
  ): CrossChannelMessage[] {
    return this.db
      .prepare(
        'SELECT * FROM cross_channel_messages WHERE peer_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(peerId, limit)
      .reverse() as CrossChannelMessage[];
  }

  /**
   * Return up to `limit` recent messages for a peer across ALL channels,
   * ordered most-recent-first.
   *
   * @param peerId - Peer whose history to retrieve.
   * @param limit  - Maximum number of messages to return (default 50).
   */
  getUserHistory(peerId: string, limit: number = 50): CrossChannelMessage[] {
    return this.db
      .prepare(
        'SELECT * FROM cross_channel_messages WHERE peer_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(peerId, limit) as CrossChannelMessage[];
  }

  /**
   * Return the distinct channel types on which a peer has sent or received
   * at least one message.
   *
   * @param peerId - Peer to look up.
   */
  getChannelsForUser(peerId: string): ChannelType[] {
    const rows = this.db
      .prepare('SELECT DISTINCT channel FROM cross_channel_messages WHERE peer_id = ?')
      .all(peerId) as { channel: ChannelType }[];
    return rows.map(r => r.channel);
  }
}
