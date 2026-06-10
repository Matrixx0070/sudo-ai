/**
 * @file whatsapp.ts
 * @description WhatsApp channel adapter using @whiskeysockets/baileys.
 *
 * Features:
 *  - Persistent multi-file auth stored in data/whatsapp-auth/.
 *  - QR code logged to console on first connect.
 *  - Text, image, video, and document message handling.
 *  - Allowlist enforcement via JID.
 *  - Automatic reconnection on socket closure.
 *  - Graceful stop via socket.logout() + socket.end().
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
// @ts-expect-error @hapi/boom is an optional peer dependency of baileys
import { Boom } from '@hapi/boom';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/index.js';
import { ChannelError } from '../shared/index.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  MediaAttachment,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';

import type { HookContext, HookEvent } from '../hooks/index.js';
import { rateLimiter } from './rate-limit.js';

// ---------------------------------------------------------------------------
// Hook emission support
// ---------------------------------------------------------------------------

/** Minimal hook-emission interface compatible with HookManager. */
export interface HookEmitterLike {
  emit(event: HookEvent, context: HookContext): Promise<void>;
}

const log = createLogger('channels:whatsapp');

const DEFAULT_AUTH_PATH = 'data/whatsapp-auth';
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * WhatsApp channel adapter built on Baileys.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'whatsapp';

  private socket: WASocket | null = null;
  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _stopping = false;
  private _reconnectCount = 0;
  private readonly authPath: string;
  private readonly allowedJids: Set<string>;
  private _hooks: HookEmitterLike | null = null;

  /**
   * @param authPath    - Directory to persist multi-file auth state.
   * @param allowedJids - Allowlisted sender JIDs. Empty = allow all.
   */
  constructor(authPath = DEFAULT_AUTH_PATH, allowedJids: string[] = []) {
    this.authPath = path.resolve(authPath);
    this.allowedJids = new Set(allowedJids);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  /**
   * Inject a HookEmitter so the adapter can emit lifecycle events.
   * Must be called before start() to ensure all events are captured.
   */
  setHookEmitter(hooks: HookEmitterLike): void {
    this._hooks = hooks;
  }

  /**
   * Fire-and-forget hook emission.
   * Any thrown exception is caught and logged so a broken hook never
   * breaks a channel send or inbound message processing.
   */
  private async _safeEmit(event: HookEvent, context: Omit<HookContext, 'event'>): Promise<void> {
    if (!this._hooks) return;
    try {
      await this._hooks.emit(event, { event, ...context } as HookContext);
    } catch (err) {
      log.warn({ event, err: String(err) }, 'WhatsApp hook emission failed — continuing');
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('WhatsApp adapter already connected — skipping start');
      return;
    }
    this._stopping = false;
    this._reconnectCount = 0;
    await this._connect();
  }

  async stop(): Promise<void> {
    this._stopping = true;
    if (!this.socket) return;
    try {
      this.socket.ev.removeAllListeners('connection.update');
      this.socket.ev.removeAllListeners('creds.update');
      this.socket.ev.removeAllListeners('messages.upsert');
      await this.socket.logout();
    } catch {
      // logout may fail if already disconnected
    }
    try {
      this.socket.end(undefined);
    } catch (err) {
      log.error({ err }, 'WhatsApp socket end error (ignored)');
    }
    this._isConnected = false;
    this.socket = null;
    log.info('WhatsApp adapter stopped');
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!this.socket || !this._isConnected) {
      throw new ChannelError('WhatsApp adapter is not connected', 'channel_not_connected', {
        peerId,
      });
    }
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }

    try {
      // Ensure JID format: add @s.whatsapp.net if missing
      const jid = peerId.includes('@') ? peerId : `${peerId}@s.whatsapp.net`;
      await this.socket.sendMessage(jid, { text });
      log.debug({ jid, textLen: text.length }, 'WhatsApp message sent');

      // Emit message:sent once per send call (fire-and-forget).
      void this._safeEmit('message:sent', {
        channel: 'whatsapp',
        meta: { peerId, chunks: 1 },
      });
    } catch (err) {
      log.error({ peerId, err }, 'WhatsApp send failed');
      throw new ChannelError('Failed to send WhatsApp message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal connection management
  // ---------------------------------------------------------------------------

  private async _connect(): Promise<void> {
    try {
      mkdirSync(this.authPath, { recursive: true });
    } catch (err) {
      throw new ChannelError('Failed to create WhatsApp auth directory', 'channel_start_failed', {
        path: this.authPath,
        cause: String(err),
      });
    }

    let authState: Awaited<ReturnType<typeof useMultiFileAuthState>>;
    try {
      authState = await useMultiFileAuthState(this.authPath);
    } catch (err) {
      throw new ChannelError('Failed to load WhatsApp auth state', 'channel_auth_missing', {
        path: this.authPath,
        cause: String(err),
      });
    }

    const { state, saveCreds } = authState;

    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: log.child({ sub: 'baileys' }) as Parameters<typeof makeWASocket>[0]['logger'],
    });

    this.socket = socket;

    // Persist updated credentials
    socket.ev.on('creds.update', saveCreds);

    // Connection state changes
    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.info({ qr }, 'WhatsApp QR code — scan to pair');
      }

      if (connection === 'open') {
        this._isConnected = true;
        this._reconnectCount = 0;
        log.info('WhatsApp connected');
      }

      if (connection === 'close') {
        this._isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldLogout = statusCode === DisconnectReason.loggedOut;

        log.warn({ statusCode, shouldLogout }, 'WhatsApp connection closed');

        if (!this._stopping && !shouldLogout) {
          void this._scheduleReconnect();
        } else if (shouldLogout) {
          log.warn('WhatsApp logged out — manual re-authentication required');
        }
      }
    });

    // Inbound messages
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const raw of messages) {
        void this._processInbound(raw);
      }
    });
  }

  private async _scheduleReconnect(): Promise<void> {
    if (this._reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
      log.error(
        { attempts: this._reconnectCount },
        'WhatsApp max reconnect attempts reached — giving up',
      );
      return;
    }

    this._reconnectCount++;
    const delay = RECONNECT_DELAY_MS * this._reconnectCount;
    log.info({ attempt: this._reconnectCount, delayMs: delay }, 'WhatsApp scheduling reconnect');

    await new Promise<void>((r) => setTimeout(r, delay));

    if (!this._stopping) {
      try {
        await this._connect();
      } catch (err) {
        log.error({ err }, 'WhatsApp reconnect attempt failed');
        void this._scheduleReconnect();
      }
    }
  }

  private async _processInbound(raw: proto.IWebMessageInfo): Promise<void> {
    const key = raw.key;
    if (!raw.message || !key || key.fromMe) return;

    const from = key.remoteJid ?? '';
    const sender = key.participant ?? from;

    if (this.allowedJids.size > 0 && !this.allowedJids.has(sender) && !this.allowedJids.has(from)) {
      log.warn({ sender, from }, 'WhatsApp message from non-allowlisted JID — dropped');
      return;
    }

    // Per-peer rate limiting
    const rl = await rateLimiter.check('whatsapp', sender || from);
    if (!rl.allowed) {
      if (!rl.burstWarned) {
        const secs = Math.ceil((rl.retryAfterMs ?? 60000) / 1000);
        const jid = (sender || from).includes('@') ? (sender || from) : `${sender || from}@s.whatsapp.net`;
        try { await this.socket?.sendMessage(jid, {
          text: `Please slow down — try again in ${secs}s`
        }); } catch { /* ignore */ }
      }
      return;
    }

    const text =
      raw.message.conversation ??
      raw.message.extendedTextMessage?.text ??
      raw.message.imageMessage?.caption ??
      raw.message.videoMessage?.caption ??
      raw.message.documentMessage?.caption ??
      '';

    const media = this._extractMedia(raw);

    const msg: UnifiedMessage = {
      id: key.id ?? String(Date.now()),
      channel: 'whatsapp',
      peerId: sender || from,
      peerName: raw.pushName ?? sender ?? from,
      chatType: from.endsWith('@g.us') ? 'group' : 'dm',
      text,
      media: media.length > 0 ? media : undefined,
      timestamp: new Date((raw.messageTimestamp as number) * 1000),
    };

    log.debug({ peerId: msg.peerId, textLen: text.length }, 'inbound WhatsApp message');

    // Emit message:received — fire-and-forget, must not block message processing.
    void this._safeEmit('message:received', {
      channel: 'whatsapp',
      meta: { peerId: msg.peerId, text: msg.text, mediaCount: media.length },
    });

    if (!this._handler) {
      log.warn({ peerId: msg.peerId }, 'No handler registered — WhatsApp message dropped');
      return;
    }

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ peerId: msg.peerId, err }, 'WhatsApp message handler error');
    }
  }

  private _extractMedia(raw: proto.IWebMessageInfo): MediaAttachment[] {
    const msg = raw.message;
    if (!msg) return [];

    if (msg.imageMessage) {
      return [{ type: 'image', mimeType: msg.imageMessage.mimetype ?? 'image/jpeg' }];
    }
    if (msg.videoMessage) {
      return [{ type: 'video', mimeType: msg.videoMessage.mimetype ?? 'video/mp4' }];
    }
    if (msg.audioMessage) {
      return [{ type: 'audio', mimeType: msg.audioMessage.mimetype ?? 'audio/ogg' }];
    }
    if (msg.documentMessage) {
      return [
        {
          type: 'document',
          mimeType: msg.documentMessage.mimetype ?? 'application/octet-stream',
          filename: msg.documentMessage.fileName ?? undefined,
        },
      ];
    }

    return [];
  }
}
