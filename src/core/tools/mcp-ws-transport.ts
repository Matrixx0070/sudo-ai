/**
 * @file tools/mcp-ws-transport.ts
 * @description WebSocket transport for MCP connections.
 *
 * Implements WebSocket-based communication with ping/pong heartbeat
 * and automatic reconnection using exponential backoff.
 */

import WebSocket, { WebSocket as WebSocketType } from 'ws';
import { EventEmitter } from 'node:events';
import { createLogger } from '../shared/logger.js';

const log = createLogger('tools:mcp-ws-transport');

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

export interface WSTransportConfig {
  /** WebSocket URL (ws:// or wss://) */
  url: string;
  /** Optional Bearer token for Authorization header */
  accessToken?: string | undefined;
  /** Subprotocol to use (e.g., 'json-rpc') */
  protocol?: string | undefined;
  /** Base reconnect delay in milliseconds */
  reconnectBaseMs?: number;
  /** Maximum reconnect delay in milliseconds */
  reconnectMaxMs?: number;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Ping interval in milliseconds (0 to disable) */
  heartbeatIntervalMs?: number;
  /** Timeout waiting for pong in milliseconds */
  heartbeatTimeoutMs?: number;
}

interface WSTransportConfigResolved {
  url: string;
  accessToken?: string | undefined;
  protocol?: string | undefined;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  connectionTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export type WSTransportState = 'disconnected' | 'connecting' | 'connected' | 'error';

// ---------------------------------------------------------------------------
// WSTransport
// ---------------------------------------------------------------------------

export class WSTransport extends EventEmitter<{
  open: [];
  message: [data: string];
  error: [Error];
  close: [];
  reconnecting: [attempt: number, delayMs: number];
}> {
  private state: WSTransportState = 'disconnected';
  private ws: WebSocketType | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private readonly config: WSTransportConfigResolved;
  private isClosing = false;

  constructor(config: WSTransportConfig) {
    super();
    this.config = {
      url: config.url,
      accessToken: config.accessToken,
      protocol: config.protocol,
      reconnectBaseMs: config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs: config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      connectionTimeoutMs: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };
  }

  /** Current connection state */
  getState(): WSTransportState {
    return this.state;
  }

  /** Check if currently connected */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Connect to the WebSocket server.
   * Automatically reconnects on failure with exponential backoff.
   */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      log.debug({ url: this.config.url }, 'WSTransport.connect called but already connecting/connected');
      return;
    }

    this.isClosing = false;
    this.state = 'connecting';
    await this._connectWithRetry();
  }

  private async _connectWithRetry(): Promise<void> {
    // Check kill-switch
    if (process.env['SUDO_MCP_REMOTE_DISABLE'] === '1') {
      log.debug('WebSocket transport disabled via SUDO_MCP_REMOTE_DISABLE');
      this.state = 'error';
      this.emit('error', new Error('WebSocket transport disabled by kill-switch'));
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
        'WebSocket connection failed, scheduling reconnect',
      );

      this.state = 'error';
      this.emit('error', error);
      this.emit('reconnecting', this.reconnectAttempt, delayMs);

      this._scheduleReconnect(delayMs);
    }
  }

  private _doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        ws.terminate();
        reject(new Error('WebSocket connection timeout'));
      }, this.config.connectionTimeoutMs);

      const options: WebSocket.ClientOptions = {
        handshakeTimeout: this.config.connectionTimeoutMs,
      };

      if (this.config.protocol) {
        options.protocol = this.config.protocol;
      }

      if (this.config.accessToken) {
        options.headers = {
          Authorization: `Bearer ${this.config.accessToken}`,
        };
      }

      const ws = new WebSocket(this.config.url, options);

      ws.on('open', () => {
        clearTimeout(timeoutId);
        this.state = 'connected';
        this._startHeartbeat();
        this.emit('open');
        log.info({ url: this.config.url }, 'WebSocket connection established');
        resolve();
      });

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        this._resetHeartbeatTimeout();
        const message = isBinary ? data.toString('base64') : data.toString('utf8');
        log.debug({ length: message.length }, 'WebSocket message received');
        this.emit('message', message);
      });

      ws.on('error', (err) => {
        clearTimeout(timeoutId);
        log.debug({ error: err.message }, 'WebSocket error');
        // Don't emit error here - let close handler deal with it
        // unless we're still connecting
        if (this.state === 'connecting') {
          reject(err);
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timeoutId);
        this._stopHeartbeat();

        log.info(
          { url: this.config.url, code, reason: reason?.toString() },
          'WebSocket connection closed',
        );

        this.state = 'disconnected';
        this.emit('close');

        // Auto-reconnect unless explicitly closing
        if (!this.isClosing) {
          this._scheduleReconnect(this.config.reconnectBaseMs);
        }
      });

      ws.on('pong', () => {
        this._resetHeartbeatTimeout();
      });

      this.ws = ws;
    });
  }

  private _startHeartbeat(): void {
    if (this.config.heartbeatIntervalMs <= 0) {
      return;
    }

    this._scheduleHeartbeat();
  }

  private _scheduleHeartbeat(): void {
    if (this.state !== 'connected' || this.isClosing) {
      return;
    }

    this.heartbeatTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this._scheduleHeartbeatTimeout();
      }
    }, this.config.heartbeatIntervalMs);
  }

  private _scheduleHeartbeatTimeout(): void {
    this.heartbeatTimeoutTimer = setTimeout(() => {
      log.warn({ url: this.config.url }, 'WebSocket heartbeat timeout - reconnecting');
      this.ws?.terminate();
    }, this.config.heartbeatTimeoutMs);
  }

  private _resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private _scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.isClosing) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectWithRetry();
    }, delayMs);
  }

  /** Send a message over the WebSocket connection */
  send(data: string | Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn({ state: this.state }, 'WSTransport.send called but not connected');
      return false;
    }

    this.ws.send(data);
    return true;
  }

  /** Disconnect and stop reconnection attempts */
  disconnect(): void {
    log.info({ url: this.config.url }, 'WebSocket transport disconnecting');

    this.isClosing = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this._stopHeartbeat();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }

    this.state = 'disconnected';
  }

  /** Update the access token for reconnection */
  setAccessToken(token: string): void {
    this.config.accessToken = token;
    log.debug('WebSocket transport access token updated');
  }
}
