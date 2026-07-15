/**
 * @file websocket-channel.ts
 * @description Dedicated WebSocket streaming server for SUDO-AI.
 *
 * Based on Codex's prefer_websockets: true and ChatGPT's realtime WebSocket.
 * Runs on a dedicated port (default 3003) separate from the web chat adapter.
 *
 * Protocol — client sends:
 *   { "message": "user text", "sessionId": "optional-override" }
 *
 * Server streams back:
 *   { "type": "token",    "content": "..." }      — partial text chunk
 *   { "type": "progress", "text": "..." }         — tool execution update
 *   { "type": "done",     "full_response": "..." } — final complete response
 *   { "type": "error",    "message": "..." }       — error during processing
 *
 * Env vars:
 *   WS_STREAMING_PORT  — port to listen on (default: 3003)
 *   WS_STREAMING_TOKEN — optional Bearer token for auth
 */

import http from 'node:http';
import { createLogger } from '../shared/logger.js';
import { resolveEnvSecret } from '../secrets/secret-ref.js';

const log = createLogger('channels:websocket');

// ---------------------------------------------------------------------------
// Duck-typed interfaces (avoids circular imports and hard ws type dep)
// ---------------------------------------------------------------------------

interface WSRawClient {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  readyState: number;
}

interface WSRawServer {
  on(event: 'connection', listener: (ws: WSRawClient, req: unknown) => void): void;
  close(cb?: () => void): void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inbound message from WebSocket client. */
interface InboundMessage {
  /** The user's text message. */
  message: string;
  /** Optional session ID override. If absent the channel assigns one. */
  sessionId?: string;
}

/** Outbound frame sent from server to client. */
type OutboundFrame =
  | { type: 'token'; content: string }
  | { type: 'progress'; text: string }
  | { type: 'done'; full_response: string }
  | { type: 'error'; message: string };

/**
 * Callback invoked by the channel when a complete message arrives.
 * The handler should stream response events back using the provided emit function.
 *
 * @param message   - User's message text.
 * @param sessionId - Session identifier for this client.
 * @param emit      - Function to push frames back to this specific client.
 */
export type WSMessageHandler = (
  message: string,
  sessionId: string,
  emit: (frame: OutboundFrame) => void,
) => Promise<void>;

// ---------------------------------------------------------------------------
// WebSocketChannel
// ---------------------------------------------------------------------------

/**
 * Standalone WebSocket streaming server.
 *
 * Register a message handler via onMessage() before calling start().
 * Call stop() to gracefully shut down.
 */
export class WebSocketChannel {
  private _server: http.Server | null = null;
  private _wss: WSRawServer | null = null;
  private _handler: WSMessageHandler | null = null;
  private _isRunning = false;

  private readonly _port: number;
  private readonly _token: string | undefined;

  constructor(port?: number) {
    this._port = port ?? parseInt(process.env['WS_STREAMING_PORT'] ?? '3003', 10);
    this._token = resolveEnvSecret('WS_STREAMING_TOKEN') || undefined;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Register the handler that processes inbound messages and emits stream frames. */
  onMessage(handler: WSMessageHandler): void {
    this._handler = handler;
  }

  /** Start the WebSocket server. Idempotent — no-op if already running. */
  async start(): Promise<void> {
    if (this._isRunning) {
      log.warn('WebSocketChannel already running — skipping start');
      return;
    }

    try {
      const { WebSocketServer } = await import('ws');
      const WSServerClass = WebSocketServer as unknown as new (opts: Record<string, unknown>) => WSRawServer;

      this._server = http.createServer((_req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Upgrade required — connect via WebSocket');
      });

      this._wss = new WSServerClass({ server: this._server, path: '/stream' });

      this._wss.on('connection', (ws: WSRawClient, req: unknown) => {
        this._handleConnection(ws, req as http.IncomingMessage);
      });

      await new Promise<void>((resolve, reject) => {
        const srv = this._server!;
        (srv as typeof srv & { once: (e: string, cb: (...a: unknown[]) => void) => void })
          .once('error', reject);
        srv.listen(this._port, '0.0.0.0', () => {
          this._isRunning = true;
          log.info({ port: this._port }, 'WebSocketChannel streaming server started');
          resolve();
        });
      });
    } catch (err) {
      log.error({ err: String(err) }, 'WebSocketChannel failed to start');
      throw err;
    }
  }

  /** Gracefully stop the server and close all connections. */
  async stop(): Promise<void> {
    if (!this._isRunning) return;

    try {
      await new Promise<void>((resolve) => {
        if (this._wss) {
          this._wss.close(() => resolve());
        } else if (this._server) {
          this._server.close(() => resolve());
        } else {
          resolve();
        }
      });
    } catch (err) {
      log.error({ err: String(err) }, 'WebSocketChannel stop error');
    } finally {
      this._isRunning = false;
      this._server = null;
      this._wss = null;
      log.info('WebSocketChannel stopped');
    }
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _handleConnection(ws: WSRawClient, req: http.IncomingMessage): void {
    // Token auth: check Authorization header or ?token= query param.
    if (this._token) {
      const authHeader = req.headers['authorization'] ?? '';
      let tokenOk = authHeader === `Bearer ${this._token}`;

      if (!tokenOk) {
        try {
          const url = new URL(req.url ?? '/', `http://localhost:${this._port}`);
          tokenOk = url.searchParams.get('token') === this._token;
        } catch { /* malformed URL — keep tokenOk=false */ }
      }

      if (!tokenOk) {
        log.warn({ ip: req.socket?.remoteAddress }, 'WebSocketChannel: auth failed — closing connection');
        ws.close(4001, 'Unauthorized');
        return;
      }
    }

    const connId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    log.info({ connId, ip: req.socket?.remoteAddress }, 'WebSocket client connected');

    ws.on('message', (...args: unknown[]) => {
      const raw = (args[0] as Buffer | string).toString().trim();
      if (!raw) return;
      void this._handleMessage(ws, connId, raw);
    });

    ws.on('close', () => {
      log.info({ connId }, 'WebSocket client disconnected');
    });

    ws.on('error', (...args: unknown[]) => {
      log.error({ connId, err: args[0] }, 'WebSocket client error');
    });
  }

  private async _handleMessage(ws: WSRawClient, connId: string, raw: string): Promise<void> {
    let parsed: InboundMessage;

    try {
      parsed = JSON.parse(raw) as InboundMessage;
    } catch {
      this._send(ws, { type: 'error', message: 'Invalid JSON — expected { message: string, sessionId?: string }' });
      return;
    }

    if (!parsed.message || typeof parsed.message !== 'string' || !parsed.message.trim()) {
      this._send(ws, { type: 'error', message: 'Field "message" must be a non-empty string' });
      return;
    }

    if (!this._handler) {
      log.warn({ connId }, 'No message handler registered — dropping message');
      this._send(ws, { type: 'error', message: 'Server not ready — no message handler registered' });
      return;
    }

    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : connId;

    log.debug({ connId, sessionId, msgLen: parsed.message.length }, 'WebSocket message received');

    const emit = (frame: OutboundFrame): void => {
      this._send(ws, frame);
    };

    try {
      await this._handler(parsed.message.trim(), sessionId, emit);
    } catch (err) {
      log.error({ connId, sessionId, err: String(err) }, 'WebSocket handler error');
      this._send(ws, { type: 'error', message: `Handler error: ${String(err)}` });
    }
  }

  /** Safely send a JSON frame to the client. No-op if socket is not open. */
  private _send(ws: WSRawClient, frame: OutboundFrame): void {
    // readyState === 1 means OPEN
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(frame), (err) => {
        if (err) log.warn({ err: String(err) }, 'WebSocket send callback error');
      });
    } catch (err) {
      log.warn({ err: String(err) }, 'WebSocket send threw');
    }
  }
}
