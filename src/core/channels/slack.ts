/**
 * @file slack.ts
 * @description Slack channel adapter using the Slack Web API (fetch-based, no SDK).
 *
 * Receive path: Socket Mode WebSocket via apps.connections.open (requires
 * SLACK_APP_TOKEN). Falls back to conversations.history polling when absent.
 * Send path:    chat.postMessage REST API.
 * Chunk limit:  40 000 characters (Slack Block Kit text limit).
 *
 * Receive internals are in slack-receive.ts; this file owns the ChannelAdapter
 * contract, outbound send, and message normalization only.
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
import { SlackSocketMode, SlackPoller } from './slack-receive.js';
import type { SlackMessageEvent } from './slack-receive.js';
import { resolveEnvSecret } from '../secrets/secret-ref.js';

const log = createLogger('channels:slack');

const SLACK_API = 'https://slack.com/api';
const CHUNK_LIMIT = 40_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakAt = slice.lastIndexOf('\n');
    const cut = breakAt > limit * 0.5 ? breakAt : limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function slackPost(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ChannelError(
      `Slack API HTTP ${res.status} on ${endpoint}`,
      'channel_send_failed',
      { status: res.status },
    );
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (!data['ok']) {
    throw new ChannelError(
      `Slack API error on ${endpoint}: ${String(data['error'])}`,
      'channel_send_failed',
      { slackError: data['error'] },
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class SlackAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'slack';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  private _socketMode: SlackSocketMode | null = null;
  private _poller: SlackPoller | null = null;

  private readonly _botToken: string;
  private readonly _appToken: string | undefined;
  private readonly _pollChannels: string[];

  constructor() {
    const bot = resolveEnvSecret('SLACK_BOT_TOKEN') ?? undefined;
    if (!bot) {
      throw new ChannelError(
        'SLACK_BOT_TOKEN env var is required',
        'channel_auth_missing',
        { envKey: 'SLACK_BOT_TOKEN' },
      );
    }
    this._botToken = bot;
    this._appToken = resolveEnvSecret('SLACK_APP_TOKEN') ?? undefined;
    this._pollChannels = (process.env['SLACK_POLL_CHANNELS'] ?? '').split(',').filter(Boolean);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  async start(): Promise<void> {
    if (this._isConnected) {
      log.warn('Slack adapter already connected — skipping start');
      return;
    }

    const eventHandler = (ev: SlackMessageEvent) => this._dispatch(ev);

    if (this._appToken) {
      this._socketMode = new SlackSocketMode(this._appToken, () => void this.start());
      this._socketMode.onEvent(eventHandler);
      await this._socketMode.connect();
    } else {
      log.warn('SLACK_APP_TOKEN absent — falling back to polling');
      this._poller = new SlackPoller(this._botToken, this._pollChannels);
      this._poller.onEvent(eventHandler);
      this._poller.start();
    }

    this._isConnected = true;
    log.info({ mode: this._appToken ? 'socket' : 'poll' }, 'Slack adapter connected');
  }

  async stop(): Promise<void> {
    try {
      this._socketMode?.disconnect();
      this._poller?.stop();
    } catch (err) {
      log.error({ err }, 'Error stopping Slack adapter');
    } finally {
      this._isConnected = false;
      log.info('Slack adapter stopped');
    }
  }

  async send(peerId: string, text: string, options?: SendOptions): Promise<void> {
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    if (!this._isConnected) {
      throw new ChannelError('Slack adapter is not connected', 'channel_not_connected', { peerId });
    }

    try {
      const chunks = chunkText(text, CHUNK_LIMIT);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) continue;
        const body: Record<string, unknown> = { channel: peerId, text: chunk };
        if (i === 0 && options?.replyToId) body['thread_ts'] = options.replyToId;
        await slackPost('chat.postMessage', this._botToken, body);
      }
      log.debug({ peerId, chunks: chunks.length }, 'Slack message sent');
    } catch (err) {
      log.error({ peerId, err }, 'Slack send failed');
      if (err instanceof ChannelError) throw err;
      throw new ChannelError('Failed to send Slack message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Normalize
  // ---------------------------------------------------------------------------

  private async _dispatch(ev: SlackMessageEvent): Promise<void> {
    if (!this._handler) {
      log.warn({ userId: ev.userId }, 'No handler — Slack message dropped');
      return;
    }

    const chatType: ChatType = ev.channelId.startsWith('D') ? 'dm' : 'group';
    const msg: UnifiedMessage = {
      id: ev.ts,
      channel: 'slack',
      peerId: ev.channelId,
      peerName: ev.userId,
      chatType,
      text: ev.text,
      replyToId: ev.threadTs,
      timestamp: new Date(parseFloat(ev.ts) * 1000),
    };

    log.debug({ userId: ev.userId, channelId: ev.channelId, textLen: ev.text.length }, 'inbound Slack message');

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ userId: ev.userId, err }, 'Slack message handler error');
    }
  }
}
