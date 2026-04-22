/**
 * @file slack-receive.ts
 * @description Internal receive strategies for the Slack adapter.
 * Exports SlackSocketMode (WebSocket) and SlackPoller (HTTP polling).
 * Not part of the public channels API — imported only by slack.ts.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:slack:receive');

const SLACK_API = 'https://slack.com/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackMessageEvent {
  userId: string;
  channelId: string;
  text: string;
  ts: string;
  threadTs?: string;
}

export type SlackEventHandler = (event: SlackMessageEvent) => Promise<void>;

/** Minimal WebSocket interface — avoids hard dependency on ws types. */
interface WSClient {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
}

// ---------------------------------------------------------------------------
// Socket Mode
// ---------------------------------------------------------------------------

export class SlackSocketMode {
  private _ws: WSClient | null = null;
  private _handler: SlackEventHandler | null = null;
  private _active = false;

  constructor(private readonly appToken: string, private readonly onReconnect: () => void) {}

  onEvent(handler: SlackEventHandler): void {
    this._handler = handler;
  }

  async connect(): Promise<void> {
    const res = await fetch(`${SLACK_API}/apps.connections.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) throw new Error(`apps.connections.open HTTP ${res.status}`);
    const data = (await res.json()) as { ok: boolean; url?: string };
    if (!data.ok || !data.url) throw new Error('apps.connections.open did not return url');

    let ws: WSClient;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = await (Function('return import("ws")')() as Promise<any>);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ws = new m.WebSocket(data.url) as WSClient;
    } catch {
      throw new Error('ws package not installed — run: npm install ws');
    }

    this._ws = ws;
    this._active = true;

    ws.on('message', (...args: unknown[]) => {
      const raw = args[0] as Buffer | string;
      try {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        this._handlePayload(payload);
      } catch (err) {
        log.error({ err }, 'Socket Mode parse error');
      }
    });

    ws.on('close', () => {
      log.warn('Slack Socket Mode WS closed');
      this._active = false;
      if (this._active !== false) return; // closed by stop()
      setTimeout(() => this.onReconnect(), 5_000);
    });

    ws.on('error', (...args: unknown[]) => {
      log.error({ err: args[0] }, 'Slack Socket Mode WS error');
    });

    await new Promise<void>((resolve) => { ws.once('open', () => resolve()); });
    log.info('Slack Socket Mode connected');
  }

  disconnect(): void {
    this._active = false;
    this._ws?.close();
    this._ws = null;
  }

  private _handlePayload(payload: Record<string, unknown>): void {
    if (payload['envelope_id']) {
      this._ws?.send(JSON.stringify({ envelope_id: payload['envelope_id'] }));
    }
    if (payload['type'] !== 'events_api') return;
    const inner = (payload['payload'] as Record<string, unknown> | undefined)?.['event'] as
      | Record<string, unknown>
      | undefined;
    if (!inner || inner['type'] !== 'message' || inner['bot_id']) return;

    void this._handler?.({
      userId: String(inner['user'] ?? 'unknown'),
      channelId: String(inner['channel'] ?? ''),
      text: String(inner['text'] ?? ''),
      ts: String(inner['ts'] ?? Date.now()),
      threadTs: String(inner['thread_ts'] ?? '') || undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP polling fallback
// ---------------------------------------------------------------------------

export class SlackPoller {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastTs: string = String(Math.floor(Date.now() / 1000) - 5);
  private _handler: SlackEventHandler | null = null;

  constructor(
    private readonly botToken: string,
    private readonly channels: string[],
    private readonly intervalMs = 5_000,
  ) {}

  onEvent(handler: SlackEventHandler): void {
    this._handler = handler;
  }

  start(): void {
    if (this.channels.length === 0) {
      log.warn('No SLACK_POLL_CHANNELS set — polling is a no-op');
      return;
    }
    this._timer = setInterval(() => void this._poll(), this.intervalMs);
    log.info({ channels: this.channels, intervalMs: this.intervalMs }, 'Slack poller started');
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private async _poll(): Promise<void> {
    for (const channelId of this.channels) {
      try {
        const res = await fetch(
          `${SLACK_API}/conversations.history?channel=${channelId}&oldest=${this._lastTs}&limit=20`,
          { headers: { Authorization: `Bearer ${this.botToken}` } },
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { ok: boolean; messages?: Array<Record<string, unknown>> };
        if (!data.ok || !data.messages) continue;

        for (const msg of [...data.messages].reverse()) {
          if (msg['bot_id']) continue;
          await this._handler?.({
            userId: String(msg['user'] ?? 'unknown'),
            channelId,
            text: String(msg['text'] ?? ''),
            ts: String(msg['ts'] ?? ''),
            threadTs: String(msg['thread_ts'] ?? '') || undefined,
          });
          this._lastTs = String(msg['ts']);
        }
      } catch (err) {
        log.error({ channelId, err }, 'Slack poll error');
      }
    }
  }
}
