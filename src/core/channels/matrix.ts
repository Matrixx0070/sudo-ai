/**
 * @file matrix.ts
 * @description Matrix channel adapter using the Matrix client-server API (fetch-based).
 *
 * Env vars:
 *   MATRIX_HOMESERVER    - e.g. https://matrix.org (required)
 *   MATRIX_ACCESS_TOKEN  - user access token (required)
 *
 * Receive: long-polling /_matrix/client/v3/sync (30 s timeout).
 * Send:    PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}
 * Invites are auto-accepted.
 */

import { createLogger } from '../shared/logger.js';
import { ChannelError } from '../shared/errors.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  ChatType,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';
import { resolveEnvSecret } from '../secrets/secret-ref.js';

const log = createLogger('channels:matrix');

const SYNC_TIMEOUT_MS = 30_000;
const CHUNK_LIMIT = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const cut = slice.lastIndexOf('\n');
    chunks.push(remaining.slice(0, cut > limit * 0.5 ? cut : limit));
    remaining = remaining.slice(cut > limit * 0.5 ? cut : limit).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class MatrixAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'matrix';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _syncActive = false;
  private _nextBatch: string | undefined;
  private _primed = false;
  private _txnCounter = 0;
  private _selfId: string | undefined;

  private readonly _hs: string;
  private readonly _token: string;

  constructor() {
    const hs = process.env['MATRIX_HOMESERVER'];
    const token = resolveEnvSecret('MATRIX_ACCESS_TOKEN') ?? undefined;
    if (!hs) throw new ChannelError('MATRIX_HOMESERVER env var required', 'channel_auth_missing', { envKey: 'MATRIX_HOMESERVER' });
    if (!token) throw new ChannelError('MATRIX_ACCESS_TOKEN env var required', 'channel_auth_missing', { envKey: 'MATRIX_ACCESS_TOKEN' });
    this._hs = hs.replace(/\/$/, '');
    this._token = token;
  }

  get isConnected(): boolean { return this._isConnected; }

  onMessage(handler: MessageHandler): void { this._handler = handler; }

  async start(): Promise<void> {
    if (this._isConnected) { log.warn('Matrix adapter already connected'); return; }
    this._isConnected = true;
    this._syncActive = true;
    await this._primeSync();
    void this._syncLoop();
    log.info({ hs: this._hs }, 'Matrix adapter connected');
  }

  async stop(): Promise<void> {
    this._syncActive = false;
    this._isConnected = false;
    log.info('Matrix adapter stopped');
  }

  async send(peerId: string, text: string, options?: SendOptions): Promise<void> {
    if (!peerId) throw new ChannelError('peerId required', 'channel_invalid_peer', { peerId });
    if (!this._isConnected) throw new ChannelError('Matrix not connected', 'channel_not_connected', { peerId });
    try {
      for (const chunk of chunkText(text, CHUNK_LIMIT)) {
        if (!chunk) continue;
        const txn = `sudoai-${Date.now()}-${++this._txnCounter}`;
        await this._req('PUT',
          `/_matrix/client/v3/rooms/${encodeURIComponent(peerId)}/send/m.room.message/${encodeURIComponent(txn)}`,
          { msgtype: 'm.text', body: chunk, ...(options?.replyToId ? { 'm.relates_to': { 'm.in_reply_to': { event_id: options.replyToId } } } : {}) },
        );
      }
      log.debug({ peerId }, 'Matrix message sent');
    } catch (err) {
      log.error({ peerId, err }, 'Matrix send failed');
      if (err instanceof ChannelError) throw err;
      throw new ChannelError('Matrix send failed', 'channel_send_failed', { peerId, cause: String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // Sync loop
  // ---------------------------------------------------------------------------

  private async _primeSync(): Promise<void> {
    try {
      const data = await this._req('GET', `/_matrix/client/v3/sync?timeout=0&filter={"room":{"timeline":{"limit":1}}}`);
      this._nextBatch = data['next_batch'] as string | undefined;
      this._primed = true;
    } catch (err) {
      log.warn({ err }, 'Matrix prime sync failed');
    }
  }

  private async _syncLoop(): Promise<void> {
    while (this._syncActive) {
      try {
        const qs = new URLSearchParams({ timeout: String(SYNC_TIMEOUT_MS) });
        if (this._nextBatch) qs.set('since', this._nextBatch);
        const data = await this._req('GET', `/_matrix/client/v3/sync?${qs}`);
        this._nextBatch = data['next_batch'] as string | undefined;
        // If prime sync failed, this first sync ran without a `since` token and
        // returns each joined room's recent timeline. Treat it as a baseline only
        // (auto-join invites but do not dispatch historical messages as new ones).
        const dispatch = this._primed;
        this._primed = true;
        await this._processSync(data, dispatch);
      } catch (err) {
        if (!this._syncActive) break;
        log.error({ err }, 'Matrix sync error — retrying in 5 s');
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async _processSync(data: Record<string, unknown>, dispatch = true): Promise<void> {
    const rooms = data['rooms'] as Record<string, unknown> | undefined;
    if (!rooms) return;

    // Auto-join invites
    for (const roomId of Object.keys((rooms['invite'] as Record<string, unknown> | undefined) ?? {})) {
      try {
        await this._req('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {});
        log.info({ roomId }, 'Matrix auto-joined room');
      } catch (err) { log.error({ roomId, err }, 'Matrix join failed'); }
    }

    // Skip dispatching the baseline (unprimed first) sync's timeline so the bot
    // does not reply to historical messages as if they were newly received.
    if (!dispatch) return;

    // Dispatch timeline messages
    const selfId = await this._getSelfId();
    const joined = (rooms['join'] as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [roomId, room] of Object.entries(joined)) {
      const events = ((room['timeline'] as { events?: Array<Record<string, unknown>> } | undefined)?.events) ?? [];
      for (const ev of events) {
        if (ev['type'] !== 'm.room.message') continue;
        const content = ev['content'] as Record<string, unknown> | undefined;
        if (!content || content['msgtype'] !== 'm.text') continue;
        const sender = String(ev['sender'] ?? 'unknown');
        if (sender === selfId) continue;
        await this._dispatch(roomId, sender, String(content['body'] ?? ''), String(ev['event_id'] ?? Date.now()));
      }
    }
  }

  private async _getSelfId(): Promise<string> {
    if (this._selfId) return this._selfId;
    try {
      const data = await this._req('GET', '/_matrix/client/v3/account/whoami');
      const userId = String(data['user_id'] ?? '');
      // Only memoize a real user_id; leave undefined on empty/failure so it retries
      // (caching '' would make own-message filtering never match → self-reply loop).
      if (userId) this._selfId = userId;
      return userId;
    } catch { return ''; }
  }

  private async _dispatch(roomId: string, sender: string, text: string, eventId: string): Promise<void> {
    if (!this._handler) { log.warn({ roomId }, 'No handler — Matrix message dropped'); return; }
    const msg: UnifiedMessage = {
      id: eventId, channel: 'matrix', peerId: roomId, peerName: sender,
      chatType: 'group' as ChatType, text, timestamp: new Date(),
    };
    log.debug({ roomId, sender, textLen: text.length }, 'inbound Matrix message');
    try { await this._handler(msg); } catch (err) { log.error({ roomId, sender, err }, 'Matrix handler error'); }
  }

  // ---------------------------------------------------------------------------
  // HTTP helper
  // ---------------------------------------------------------------------------

  private async _req(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = path.startsWith('http') ? path : `${this._hs}${path}`;
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (!res.ok) throw new ChannelError(`Matrix ${method} ${path} HTTP ${res.status}`, 'channel_send_failed', { status: res.status });
    return (await res.json()) as Record<string, unknown>;
  }
}
