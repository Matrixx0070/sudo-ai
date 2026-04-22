/**
 * @file channels/imessage-connector.ts
 * @description macOS iMessage connector via read-only access to chat.db.
 *
 * Platform:
 *   macOS only — reads ~/Library/Messages/chat.db (SQLite, read-only).
 *   On Linux/Windows → returns {supported: false, output: 'iMessage requires macOS'}.
 *
 * Privacy note:
 *   Access to chat.db requires Full Disk Access permission in macOS System Preferences.
 *   This connector is read-only — it never writes to the Messages database.
 *
 * Implementation uses better-sqlite3 if available (already a project dep).
 * Falls back to graceful error if better-sqlite3 is unavailable.
 *
 * @module channels/imessage-connector
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:imessage');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IMessageConversation {
  chatId: number;
  displayName: string | null;
  lastMessage: string | null;
  lastMessageDate: string | null;
  messageCount: number;
}

export interface IMessageListResult {
  supported: boolean;
  conversations?: IMessageConversation[];
  count?: number;
  output: string;
}

export interface IMessageMessage {
  rowid: number;
  text: string | null;
  isFromMe: boolean;
  date: string;
  handle: string | null;
}

export interface IMessageReadResult {
  supported: boolean;
  messages?: IMessageMessage[];
  count?: number;
  output: string;
}

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

const IMESSAGE_NOT_SUPPORTED = 'iMessage requires macOS — not available on this platform.';

// ---------------------------------------------------------------------------
// chat.db path
// ---------------------------------------------------------------------------

function getChatDbPath(): string {
  return path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
}

// ---------------------------------------------------------------------------
// SQLite access (dynamic import of better-sqlite3)
// ---------------------------------------------------------------------------

type BetterSqlite3Database = {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
  close: () => void;
};

async function openChatDb(): Promise<BetterSqlite3Database | null> {
  const dbPath = getChatDbPath();
  if (!fs.existsSync(dbPath)) {
    log.warn({ dbPath }, 'chat.db not found — Full Disk Access may not be granted');
    return null;
  }

  try {
    // Dynamic import to avoid static dependency requirement
    const specifier = 'better-sqlite3';
    const { default: Database } = await (import(specifier) as Promise<{ default: new (path: string, opts?: Record<string, unknown>) => BetterSqlite3Database }>);
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Failed to open chat.db (better-sqlite3 may not be available)');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apple epoch conversion (seconds since 2001-01-01)
// ---------------------------------------------------------------------------

const APPLE_EPOCH_OFFSET_S = 978307200; // seconds between 1970-01-01 and 2001-01-01

function appleTimestampToISO(appleNanoSeconds: number | bigint): string {
  const ns = typeof appleNanoSeconds === 'bigint'
    ? Number(appleNanoSeconds)
    : appleNanoSeconds;
  // Apple uses nanoseconds in newer schemas, seconds in older ones
  // Detect: if value > 1e15 it's nanoseconds, else seconds
  const seconds = ns > 1e15
    ? ns / 1e9 + APPLE_EPOCH_OFFSET_S
    : ns + APPLE_EPOCH_OFFSET_S;
  return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List recent iMessage conversations.
 *
 * @param limit  - Maximum conversations to return (default 20).
 * @param signal - Optional AbortSignal (not used for sync SQLite ops).
 * @returns Conversation list or not-supported/not-available error.
 */
export async function listIMessageConversations(
  limit = 20,
  _signal?: AbortSignal,
): Promise<IMessageListResult> {
  if (!isMacOS()) {
    return { supported: false, output: IMESSAGE_NOT_SUPPORTED };
  }

  const db = await openChatDb();
  if (!db) {
    return {
      supported: true,
      output: 'iMessage: could not open chat.db. Check Full Disk Access permission in System Preferences.',
    };
  }

  try {
    const rows = db.prepare(`
      SELECT
        c.ROWID AS chatId,
        c.display_name AS displayName,
        m.text AS lastMessage,
        m.date AS lastMessageDate,
        COUNT(m2.ROWID) AS messageCount
      FROM chat c
      LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      LEFT JOIN message m ON m.ROWID = (
        SELECT MAX(ROWID) FROM message m3
        JOIN chat_message_join cmj3 ON cmj3.message_id = m3.ROWID
        WHERE cmj3.chat_id = c.ROWID
      )
      LEFT JOIN message m2 ON m2.ROWID IN (
        SELECT message_id FROM chat_message_join WHERE chat_id = c.ROWID
      )
      GROUP BY c.ROWID
      ORDER BY lastMessageDate DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    const conversations: IMessageConversation[] = rows.map(row => ({
      chatId: Number(row['chatId']),
      displayName: row['displayName'] as string | null,
      lastMessage: row['lastMessage'] as string | null,
      lastMessageDate: row['lastMessageDate']
        ? appleTimestampToISO(row['lastMessageDate'] as number)
        : null,
      messageCount: Number(row['messageCount'] ?? 0),
    }));

    log.info({ count: conversations.length }, 'iMessage conversations listed');

    return {
      supported: true,
      conversations,
      count: conversations.length,
      output: `Found ${conversations.length} conversation(s).`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'iMessage DB query failed');
    return { supported: true, output: `imessage-connector error: ${msg}` };
  } finally {
    try { db.close(); } catch { /* non-fatal */ }
  }
}

/**
 * Read messages from a specific iMessage chat.
 *
 * @param chatId - Chat ROWID from listIMessageConversations.
 * @param limit  - Maximum messages to return (default 50).
 * @param signal - Optional AbortSignal.
 * @returns Message list or not-supported/not-available error.
 */
export async function readIMessageChat(
  chatId: number,
  limit = 50,
  _signal?: AbortSignal,
): Promise<IMessageReadResult> {
  if (!isMacOS()) {
    return { supported: false, output: IMESSAGE_NOT_SUPPORTED };
  }

  if (!Number.isInteger(chatId) || chatId <= 0) {
    return { supported: true, output: 'imessage: chatId must be a positive integer' };
  }

  const db = await openChatDb();
  if (!db) {
    return {
      supported: true,
      output: 'iMessage: could not open chat.db. Check Full Disk Access permission.',
    };
  }

  try {
    const rows = db.prepare(`
      SELECT
        m.ROWID AS rowid,
        m.text,
        m.is_from_me AS isFromMe,
        m.date,
        h.id AS handle
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE cmj.chat_id = ?
      ORDER BY m.date DESC
      LIMIT ?
    `).all(chatId, limit) as Array<Record<string, unknown>>;

    const messages: IMessageMessage[] = rows.map(row => ({
      rowid: Number(row['rowid']),
      text: row['text'] as string | null,
      isFromMe: Boolean(row['isFromMe']),
      date: appleTimestampToISO(row['date'] as number),
      handle: row['handle'] as string | null,
    }));

    log.info({ chatId, count: messages.length }, 'iMessage chat read');

    return {
      supported: true,
      messages,
      count: messages.length,
      output: `Retrieved ${messages.length} message(s) from chat ${chatId}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ chatId, err: msg }, 'iMessage DB read failed');
    return { supported: true, output: `imessage-connector error: ${msg}` };
  } finally {
    try { db.close(); } catch { /* non-fatal */ }
  }
}
