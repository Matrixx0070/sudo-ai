/**
 * @file imessage-adapter.ts
 * @description iMessage channel adapter (Multi-Channel Gateway, Feature 1).
 *
 * The existing imessage-connector.ts is a read-only chat.db reader exposed as a
 * TOOL — it can neither receive-loop nor send, so iMessage was the one target
 * channel with no ChannelAdapter. This wraps the same chat.db source in a real
 * adapter:
 *   - receive: poll ~/Library/Messages/chat.db for new INBOUND rows since the
 *     last seen ROWID and emit UnifiedMessages (mirrors signal.ts's poll model).
 *   - send: AppleScript via `osascript` (text passed as argv, never interpolated
 *     into the script — no shell/AppleScript injection).
 *
 * macOS-only. On any other platform (or without Full Disk Access / better-sqlite3)
 * the adapter starts in no-op mode instead of throwing, so it is safe to register
 * on a Linux host — it simply never connects. Live use happens on the Mac.
 *
 * Known limitation: newer macOS stores some message bodies in `attributedBody`
 * (NULL `text`); this first version handles plain-`text` rows. Attributed-body
 * decode is a follow-up.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../shared/logger.js';
import { ChannelError } from '../shared/errors.js';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelType, MessageHandler, SendOptions, UnifiedMessage } from './types.js';

const execFileAsync = promisify(execFile);
const log = createLogger('channels:imessage');

const DEFAULT_POLL_MS = 3_000;
const APPLE_EPOCH_OFFSET_S = 978_307_200; // 1970→2001 seconds

/** Minimal better-sqlite3 surface we use (dynamic import — optional dep). */
type SqliteDb = {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown };
  close: () => void;
};

interface MessageRow { rowid: number; text: string | null; date: number | bigint; handle: string | null }

// AppleScript run with `on run argv` so buddy + text arrive as arguments — never
// string-interpolated into the script (injection-safe).
const SEND_APPLESCRIPT = [
  'on run argv',
  '  set targetBuddy to item 1 of argv',
  '  set targetText to item 2 of argv',
  '  tell application "Messages"',
  '    set targetService to 1st account whose service type = iMessage',
  '    set targetCell to participant targetBuddy of targetService',
  '    send targetText to targetCell',
  '  end tell',
  'end run',
].join('\n');

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

function chatDbPath(): string {
  return path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
}

export function appleToDate(appleTime: number | bigint): Date {
  const n = typeof appleTime === 'bigint' ? Number(appleTime) : appleTime;
  const seconds = n > 1e15 ? n / 1e9 + APPLE_EPOCH_OFFSET_S : n + APPLE_EPOCH_OFFSET_S;
  return new Date(seconds * 1000);
}

export interface IMessageAdapterOptions {
  pollIntervalMs?: number;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'imessage';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _db: SqliteDb | null = null;
  private _lastRowId = 0;
  private _polling = false;
  private readonly _pollIntervalMs: number;

  constructor(opts: IMessageAdapterOptions = {}) {
    this._pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('iMessage adapter already connected — skipping start');
      return;
    }
    if (!isMacOS()) {
      log.warn('iMessage adapter running in no-op mode — requires macOS');
      this._isConnected = true;
      return;
    }
    this._db = await this._openDb();
    if (!this._db) {
      log.warn('chat.db unavailable (Full Disk Access / better-sqlite3?) — iMessage adapter in no-op mode');
      this._isConnected = true;
      return;
    }
    // Baseline at the newest row so we don't replay history on boot.
    try {
      const row = this._db.prepare('SELECT MAX(ROWID) AS m FROM message').get() as { m: number | null } | undefined;
      this._lastRowId = Number(row?.m ?? 0);
    } catch (err) {
      log.warn({ err: String(err) }, 'iMessage: could not read baseline ROWID — starting at 0');
    }
    this._pollTimer = setInterval(() => void this._poll(), this._pollIntervalMs);
    this._isConnected = true;
    log.info({ lastRowId: this._lastRowId, pollMs: this._pollIntervalMs }, 'iMessage adapter connected (polling chat.db)');
  }

  async stop(): Promise<void> {
    try {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
      if (this._db) { this._db.close(); this._db = null; }
    } catch (err) {
      log.error({ err }, 'Error stopping iMessage adapter (ignored)');
    } finally {
      this._isConnected = false;
      log.info('iMessage adapter stopped');
    }
  }

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!peerId) throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    if (!isMacOS()) { log.warn({ peerId }, 'iMessage send skipped — not macOS'); return; }
    try {
      await execFileAsync('osascript', ['-e', SEND_APPLESCRIPT, peerId, text]);
      log.debug({ peerId, textLen: text.length }, 'iMessage sent');
    } catch (err) {
      log.error({ peerId, err }, 'iMessage send failed');
      throw new ChannelError('Failed to send iMessage', 'channel_send_failed', { peerId, cause: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async _openDb(): Promise<SqliteDb | null> {
    const dbPath = chatDbPath();
    if (!fs.existsSync(dbPath)) {
      log.warn({ dbPath }, 'chat.db not found — Full Disk Access may not be granted');
      return null;
    }
    try {
      const specifier = 'better-sqlite3';
      const { default: Database } = (await import(specifier)) as { default: new (p: string, o?: Record<string, unknown>) => SqliteDb };
      return new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      log.warn({ err: String(err) }, 'Failed to open chat.db (better-sqlite3 unavailable?)');
      return null;
    }
  }

  private async _poll(): Promise<void> {
    if (this._polling || !this._db || !this._handler) return;
    this._polling = true;
    try {
      const rows = this._db.prepare(
        `SELECT m.ROWID AS rowid, m.text AS text, m.date AS date, h.id AS handle
         FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL
         ORDER BY m.ROWID ASC LIMIT 50`,
      ).all(this._lastRowId) as MessageRow[];

      for (const r of rows) {
        this._lastRowId = Math.max(this._lastRowId, Number(r.rowid));
        const text = (r.text ?? '').trim();
        if (!text) continue;
        const handle = r.handle ?? 'unknown';
        const msg: UnifiedMessage = {
          id: String(r.rowid),
          channel: this.channel,
          peerId: handle,
          peerName: handle,
          chatType: 'dm',
          text,
          timestamp: appleToDate(r.date),
        };
        try {
          await this._handler(msg);
        } catch (err) {
          log.error({ handle, err }, 'iMessage handler error');
        }
      }
    } catch (err) {
      log.error({ err: String(err) }, 'iMessage poll error');
    } finally {
      this._polling = false;
    }
  }
}
