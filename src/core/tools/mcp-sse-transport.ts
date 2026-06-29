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
/** Cap the incomplete-frame buffer so a server that never emits a frame boundary can't OOM us. */
const MAX_SSE_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

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
  private intentionalClose = false;
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
   * Resolves once the connection is established (not when the stream ends),
   * so callers can proceed with the MCP handshake. Automatically reconnects
   * on failure with exponential backoff.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      log.debug({ url: this.config.url }, 'SSETransport.connect called but already connecting/connected');
      return;
    }

    this.intentionalClose = false;
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
      this._onConnectionFailure(err);
    }
  }

  /**
   * Handle a connection or in-flight stream failure: emit the error and
   * schedule a reconnect with exponential backoff. No-op when the transport
   * was closed intentionally via disconnect().
   */
  private _onConnectionFailure(err: unknown): void {
    if (this.intentionalClose) {
      return;
    }

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

      // Start reading the stream in the background. The read loop runs for the
      // entire lifetime of the connection, so awaiting it here would prevent
      // connect() from ever resolving — which would block the MCP `initialize`
      // handshake forever. Resolve now (the connection is established) and
      // route any stream error through the reconnect path asynchronously.
      void this._readStream(response.body).catch((streamErr) => {
        this._onConnectionFailure(streamErr);
      });
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

    // Fields accumulated for the SSE frame currently being parsed. A frame is
    // terminated by a blank line, at which point it is dispatched. Event/id/
    // retry/data fields belonging to the same frame are associated together
    // rather than read out-of-band, so a frame delivered in a single chunk is
    // parsed correctly without blocking for the next chunk.
    let eventType: string | undefined;
    const dataLines: string[] = [];

    const dispatchFrame = (): void => {
      if (dataLines.length > 0) {
        this._emitMessage({
          event: eventType,
          data: dataLines.join('\n').trim(),
          id: lastEventId,
          retry: retryMs,
        });
      }
      // Reset per-frame state for the next event.
      eventType = undefined;
      dataLines.length = 0;
    };

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

        // A server that streams without a frame boundary would grow buffer unbounded
        // → OOM. Cap it: throw to drop the stream (routed to the reconnect path).
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          throw new Error('SSE buffer exceeded cap — dropping connection');
        }

        for (const line of lines) {
          const trimmed = line.trim();
          // A blank line terminates the current event frame and dispatches it.
          if (!trimmed) {
            dispatchFrame();
            continue;
          }

          if (trimmed.startsWith('id:')) {
            lastEventId = trimmed.slice(3).trim();
          } else if (trimmed.startsWith('event:')) {
            eventType = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            dataLines.push(trimmed.slice(5).trim());
          } else if (trimmed.startsWith('retry:')) {
            retryMs = parseInt(trimmed.slice(6).trim(), 10);
          }
        }
      }

      // Stream ended: dispatch any frame not terminated by a trailing blank line.
      dispatchFrame();
    } catch (err) {
      if (this.intentionalClose || this.abortController?.signal.aborted) {
        // Clean disconnect — do not reconnect
        return;
      }
      throw err;
    } finally {
      reader.releaseLock();
    }

    // Stream ended on its own — attempt reconnect unless intentionally closed.
    if (this.intentionalClose) {
      return;
    }
    this.state = 'disconnected';
    this.emit('close');
    this._scheduleReconnect(this.config.reconnectBaseMs);
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

    this.intentionalClose = true;

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
