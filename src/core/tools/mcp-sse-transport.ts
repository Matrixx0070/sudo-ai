/**
 * @file tools/mcp-sse-transport.ts
 * @description SSE (Server-Sent Events) transport for MCP connections.
 *
 * Implements EventSource-based communication with automatic reconnection
 * using exponential backoff.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../shared/logger.js';

const log = createLogger('tools:mcp-sse-transport');

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

export interface SSETransportConfig {
  /** SSE endpoint URL */
  url: string;
  /** Optional Bearer token for Authorization header */
  accessToken?: string | undefined;
  /** Base reconnect delay in milliseconds */
  reconnectBaseMs?: number;
  /** Maximum reconnect delay in milliseconds */
  reconnectMaxMs?: number;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
}

interface SSETransportConfigResolved {
  url: string;
  accessToken?: string | undefined;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  connectionTimeoutMs: number;
}

export type SSETransportState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

// ---------------------------------------------------------------------------
// SSETransport
// ---------------------------------------------------------------------------

export class SSETransport extends EventEmitter<{
  open: [];
  message: [SSEMessage];
  error: [Error];
  close: [];
  reconnecting: [attempt: number, delayMs: number];
}> {
  private state: SSETransportState = 'disconnected';
  private abortController: AbortController | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly config: SSETransportConfigResolved;

  constructor(config: SSETransportConfig) {
    super();
    this.config = {
      url: config.url,
      accessToken: config.accessToken,
      reconnectBaseMs: config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs: config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      connectionTimeoutMs: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    };
  }

  /** Current connection state */
  getState(): SSETransportState {
    return this.state;
  }

  /** Check if currently connected */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Connect to the SSE endpoint and start listening for events.
   * Automatically reconnects on failure with exponential backoff.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      log.debug({ url: this.config.url }, 'SSETransport.connect called but already connecting/connected');
      return;
    }

    this.state = 'connecting';
    await this._connectWithRetry();
  }

  private async _connectWithRetry(): Promise<void> {
    // Check kill-switch
    if (process.env['SUDO_MCP_REMOTE_DISABLE'] === '1') {
      log.debug('SSE transport disabled via SUDO_MCP_REMOTE_DISABLE');
      this.state = 'error';
      this.emit('error', new Error('SSE transport disabled by kill-switch'));
      return;
    }

    try {
      await this._doConnect();
      this.reconnectAttempt = 0; // Reset on success
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.reconnectAttempt++;

      const delayMs = Math.min(
        this.config.reconnectBaseMs * Math.pow(2, this.reconnectAttempt - 1),
        this.config.reconnectMaxMs,
      );

      log.warn(
        { url: this.config.url, attempt: this.reconnectAttempt, delayMs, error: error.message },
        'SSE connection failed, scheduling reconnect',
      );

      this.state = 'error';
      this.emit('error', error);
      this.emit('reconnecting', this.reconnectAttempt, delayMs);

      this._scheduleReconnect(delayMs);
    }
  }

  private async _doConnect(): Promise<void> {
    this.abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      this.abortController?.abort();
    }, this.config.connectionTimeoutMs);

    try {
      const headers: HeadersInit = {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      };

      if (this.config.accessToken) {
        headers['Authorization'] = `Bearer ${this.config.accessToken}`;
      }

      const response = await fetch(this.config.url, {
        headers,
        signal: this.abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`SSE connection failed: HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      this.state = 'connected';
      this.emit('open');
      log.info({ url: this.config.url }, 'SSE connection established');

      // Start reading the stream
      await this._readStream(response.body);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  private async _readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastEventId: string | undefined;
    let retryMs: number | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.info({ url: this.config.url }, 'SSE stream ended');
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('id:')) {
            lastEventId = trimmed.slice(3).trim();
          } else if (trimmed.startsWith('event:')) {
            // Store event type for next data line
            const eventType = trimmed.slice(6).trim();
            // Next data line will use this event type
            const nextLine = await this._readNextDataLine(reader, decoder, buffer);
            if (nextLine.data) {
              this._emitMessage({ event: eventType, data: nextLine.data, id: lastEventId, retry: nextLine.retry });
              buffer = nextLine.buffer;
            }
          } else if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            this._emitMessage({ data, id: lastEventId, retry: retryMs });
          } else if (trimmed.startsWith('retry:')) {
            retryMs = parseInt(trimmed.slice(6).trim(), 10);
          }
        }
      }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        // Clean disconnect
        return;
      }
      throw err;
    } finally {
      reader.releaseLock();
    }

    // Stream ended - attempt reconnect
    this.state = 'disconnected';
    this.emit('close');
    this._scheduleReconnect(this.config.reconnectBaseMs);
  }

  private async _readNextDataLine(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    buffer: string,
  ): Promise<{ data: string; retry?: number; buffer: string }> {
    while (true) {
      if (!buffer) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = decoder.decode(value, { stream: true });
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          return { data: trimmed.slice(5).trim(), buffer };
        } else if (trimmed.startsWith('retry:')) {
          return { data: '', retry: parseInt(trimmed.slice(6).trim(), 10), buffer };
        } else if (trimmed) {
          // Non-empty, non-data line - return what we have
          return { data: '', buffer };
        }
      }
    }
    return { data: '', buffer };
  }

  private _emitMessage(msg: SSEMessage): void {
    log.debug({ event: msg.event, id: msg.id }, 'SSE message received');
    this.emit('message', msg);
  }

  private _scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectWithRetry();
    }, delayMs);
  }

  /** Disconnect and stop reconnection attempts */
  disconnect(): void {
    log.info({ url: this.config.url }, 'SSE transport disconnecting');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.state = 'disconnected';
    this.emit('close');
  }

  /** Update the access token for reconnection */
  setAccessToken(token: string): void {
    this.config.accessToken = token;
    log.debug('SSE transport access token updated');
  }
}
