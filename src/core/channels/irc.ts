/**
 * @file irc.ts
 * @description IRC channel adapter using raw TCP sockets (node:net).
 *
 * Env vars:
 *   IRC_SERVER       - hostname of the IRC server (required)
 *   IRC_PORT         - port number (default: 6667)
 *   IRC_NICK         - nickname to use (required)
 *   IRC_CHANNELS     - comma-separated list of channels to join (e.g. #general,#dev)
 *   IRC_PASSWORD     - optional server/NickServ password
 *
 * Handles: PRIVMSG (channel + DM), PING/PONG, auto-reconnect on disconnect.
 */

import net from 'node:net';
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

const log = createLogger('channels:irc');

const RECONNECT_DELAY_MS = 10_000;
const PRIVMSG_MAX = 400; // Safe IRC PRIVMSG limit (protocol max ~512 total)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an IRC message line into prefix, command, and parameters. */
function parseIRC(line: string): { prefix?: string; command: string; params: string[] } {
  let rest = line;
  let prefix: string | undefined;

  if (rest.startsWith(':')) {
    const spaceIdx = rest.indexOf(' ');
    prefix = rest.slice(1, spaceIdx);
    rest = rest.slice(spaceIdx + 1);
  }

  const trailIdx = rest.indexOf(' :');
  let trail: string | undefined;
  if (trailIdx !== -1) {
    trail = rest.slice(trailIdx + 2);
    rest = rest.slice(0, trailIdx);
  }

  const parts = rest.trim().split(' ').filter(Boolean);
  const command = parts.shift() ?? '';
  const params = trail !== undefined ? [...parts, trail] : parts;

  return { prefix, command, params };
}

function nickFromPrefix(prefix?: string): string {
  if (!prefix) return 'unknown';
  const bangIdx = prefix.indexOf('!');
  return bangIdx !== -1 ? prefix.slice(0, bangIdx) : prefix;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class IRCAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'irc';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _socket: net.Socket | null = null;
  private _buffer = '';
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopRequested = false;

  private readonly _server: string;
  private readonly _port: number;
  private readonly _nick: string;
  private readonly _channels: string[];
  private readonly _password: string | undefined;

  constructor() {
    const server = process.env['IRC_SERVER'];
    const nick = process.env['IRC_NICK'];
    if (!server) {
      throw new ChannelError(
        'IRC_SERVER env var is required',
        'channel_auth_missing',
        { envKey: 'IRC_SERVER' },
      );
    }
    if (!nick) {
      throw new ChannelError(
        'IRC_NICK env var is required',
        'channel_auth_missing',
        { envKey: 'IRC_NICK' },
      );
    }
    this._server = server;
    this._port = parseInt(process.env['IRC_PORT'] ?? '6667', 10);
    this._nick = nick;
    this._channels = (process.env['IRC_CHANNELS'] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    this._password = resolveEnvSecret('IRC_PASSWORD') ?? undefined;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('IRC adapter already connected — skipping start');
      return;
    }
    this._stopRequested = false;
    return this._connect();
  }

  async stop(): Promise<void> {
    this._stopRequested = true;
    try {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this._socket) {
        this._raw('QUIT :SUDO-AI shutting down');
        this._socket.destroy();
        this._socket = null;
      }
    } catch (err) {
      log.error({ err }, 'Error stopping IRC adapter');
    } finally {
      this._isConnected = false;
      log.info('IRC adapter stopped');
    }
  }

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    if (!this._isConnected || !this._socket) {
      throw new ChannelError('IRC adapter is not connected', 'channel_not_connected', { peerId });
    }

    try {
      // Split into safe chunks
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > PRIVMSG_MAX) {
        chunks.push(remaining.slice(0, PRIVMSG_MAX));
        remaining = remaining.slice(PRIVMSG_MAX);
      }
      if (remaining) chunks.push(remaining);

      for (const chunk of chunks) {
        this._raw(`PRIVMSG ${peerId} :${chunk}`);
      }
      log.debug({ peerId, chunks: chunks.length }, 'IRC message sent');
    } catch (err) {
      log.error({ peerId, err }, 'IRC send failed');
      throw new ChannelError('Failed to send IRC message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this._server, port: this._port });
      this._socket = socket;
      this._buffer = '';

      socket.once('connect', () => {
        log.info({ server: this._server, port: this._port }, 'IRC TCP connected');
        if (this._password) this._raw(`PASS ${this._password}`);
        this._raw(`NICK ${this._nick}`);
        this._raw(`USER sudoai 0 * :SUDO-AI Bot`);
      });

      socket.on('data', (data: Buffer) => {
        this._buffer += data.toString('utf8');
        const lines = this._buffer.split('\r\n');
        this._buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line) this._handleLine(line, resolve);
        }
      });

      socket.on('close', () => {
        this._isConnected = false;
        log.warn('IRC socket closed');
        if (!this._stopRequested) {
          log.info({ delayMs: RECONNECT_DELAY_MS }, 'Scheduling IRC reconnect');
          this._reconnectTimer = setTimeout(() => void this._connect(), RECONNECT_DELAY_MS);
        }
      });

      socket.on('error', (err: Error) => {
        log.error({ err }, 'IRC socket error');
        if (!this._isConnected) reject(new ChannelError('IRC connect failed', 'channel_start_failed', { cause: String(err) }));
      });
    });
  }

  private _handleLine(line: string, onReady?: (value: void) => void): void {
    log.debug({ line }, 'IRC <');
    const { prefix, command, params } = parseIRC(line);

    switch (command) {
      case 'PING':
        this._raw(`PONG :${params[0] ?? ''}`);
        break;

      case '001': // RPL_WELCOME — we are registered
        this._isConnected = true;
        log.info({ nick: this._nick }, 'IRC registered with server');
        for (const chan of this._channels) {
          this._raw(`JOIN ${chan}`);
        }
        onReady?.();
        break;

      case 'PRIVMSG': {
        const target = params[0] ?? '';
        const text = params[1] ?? '';
        const nick = nickFromPrefix(prefix);
        // Ignore own messages
        if (nick === this._nick) break;
        const isChannel = target.startsWith('#') || target.startsWith('&');
        void this._dispatch(nick, isChannel ? target : nick, text, isChannel ? 'group' : 'dm');
        break;
      }

      case 'ERROR':
        log.error({ line }, 'IRC server error');
        break;
    }
  }

  private async _dispatch(
    nick: string,
    target: string,
    text: string,
    chatType: ChatType,
  ): Promise<void> {
    if (!this._handler) {
      log.warn({ nick }, 'No handler — IRC message dropped');
      return;
    }

    const msg: UnifiedMessage = {
      id: `${Date.now()}-${nick}`,
      channel: 'irc',
      peerId: target,
      peerName: nick,
      chatType,
      text,
      timestamp: new Date(),
    };

    log.debug({ nick, target, textLen: text.length }, 'inbound IRC message');

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ nick, err }, 'IRC message handler error');
    }
  }

  private _raw(line: string): void {
    if (!this._socket) return;
    log.debug({ line }, 'IRC >');
    this._socket.write(`${line}\r\n`, 'utf8');
  }
}
