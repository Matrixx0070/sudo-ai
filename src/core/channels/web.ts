/**
 * @file web.ts
 * @description Web chat adapter — attaches to an existing http.Server.
 *
 * Env vars:
 *   WEB_CHAT_TOKEN - Optional bearer/query token gate for /chat, /api/message, /chat/ws
 *
 * Routes (registered on the gateway's shared server via attach()):
 *   GET  /chat         - served by static-middleware.ts (React SPA from dist/renderer/chat/)
 *   POST /api/message  - REST send-message { peerId, text }
 *   WS   /chat/ws      - bidirectional WebSocket (client sends text; server pushes replies)
 *
 * The adapter assigns each WebSocket connection a peerId (uuid-like timestamp).
 * send(peerId, text) writes to the matching WS connection if open.
 */

import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLogger } from '../shared/logger.js';
import { ChannelError } from '../shared/errors.js';
import { serveStaticFile, buildSpaCSPHeader } from '../gateway/static-middleware.js';
import type { ChannelAdapter } from './adapter.js';
import type {
  ChannelType,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';

const log = createLogger('channels:web');

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Timing-safe token comparison. Returns false (not equal) if lengths differ
 * (avoids throwing from timingSafeEqual when buffers are different lengths).
 */
function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract bearer token from Authorization header or ?token= query param.
 * Returns empty string if not present.
 */
function extractToken(req: http.IncomingMessage, parsedUrl?: URL): string {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (parsedUrl) {
    return parsedUrl.searchParams.get('token') ?? '';
  }
  return '';
}

/**
 * Returns true if token enforcement is required in this environment.
 * Strict enforcement applies when WEB_CHAT_ENABLED==='true' AND NODE_ENV==='production'.
 * In dev/test, a missing token logs a warning but allows the request.
 */
function isProductionMode(): boolean {
  return (
    process.env['NODE_ENV'] === 'production' &&
    process.env['WEB_CHAT_ENABLED'] === 'true'
  );
}

/** Minimal WebSocket client interface (avoids hard dep on ws types). */
interface WSClient {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  ping(): void;
  readyState: number;
  OPEN: number;
}


// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WebAdapter implements ChannelAdapter {
  readonly channel: ChannelType = 'web';

  private _isConnected = false;
  private _handler: MessageHandler | null = null;
  /** Map from peerId -> active WebSocket connection. */
  private _clients = new Map<string, WSClient>();

  get isConnected(): boolean {
    return this._isConnected;
  }

  onMessage(handler: MessageHandler): void {
    this._handler = handler;
  }

  /**
   * Attach the web adapter to an already-running http.Server.
   * Registers 'request' and 'upgrade' listeners on the shared gateway server.
   * Does NOT call server.listen() — the gateway server is already bound.
   *
   * Prerequisites: server.ts handleRequest allowlist must include /chat and /api/message.
   */
  attach(server: http.Server): void {
    if (this._isConnected) {
      log.warn('Web adapter already attached — skipping');
      return;
    }

    // Validate WEB_CHAT_TOKEN is configured when running in production mode.
    const configuredToken = process.env['WEB_CHAT_TOKEN'] ?? '';
    if (isProductionMode() && !configuredToken) {
      const msg = 'WEB_CHAT_TOKEN must be set when WEB_CHAT_ENABLED=true and NODE_ENV=production';
      log.error(msg);
      throw new Error(msg);
    }
    if (!configuredToken) {
      log.warn('WEB_CHAT_TOKEN is not set — web chat is unauthenticated (set token for production use)');
    }

    // Fire-and-forget one-shot admin handler registration (non-blocking).
    void (async () => {
      try {
        const { registerAdminHandlers } = await import('../api/admin/index.js');
        await registerAdminHandlers();
      } catch (err) {
        log.error({ err }, 'registerAdminHandlers init failed in WebAdapter.attach');
      }
    })();

    // Build a noServer WebSocketServer for /chat/ws connections only.
    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws: WSClient, req: unknown) => {
      const httpReq = req as http.IncomingMessage;

      // Allow a fixed peerId via ?peer= query param so external API posts
      // (POST /api/message { peerId }) reach the same browser session.
      let wsUrl2: URL;
      try { wsUrl2 = new URL(httpReq.url ?? '/', 'http://localhost'); }
      catch { wsUrl2 = new URL('/', 'http://localhost'); }
      const requestedPeer = wsUrl2.searchParams.get('peer');
      const peerId = requestedPeer
        ? requestedPeer.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || `web-${randomUUID()}`
        : `web-${randomUUID()}`;
      this._clients.set(peerId, ws);
      log.info({ peerId, ip: (httpReq.socket as { remoteAddress?: string } | null)?.remoteAddress }, 'Web WS client connected');

      const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.ping();
        }
      }, 25_000);
      ws.on('pong', () => { /* alive */ });

      ws.on('message', (...args: unknown[]) => {
        const data = args[0] as Buffer | string;
        const text = data.toString().trim();
        if (!text) return;
        void this._dispatch(peerId, text);
      });

      ws.on('close', () => {
        clearInterval(pingInterval);
        this._clients.delete(peerId);
        log.info({ peerId }, 'Web WS client disconnected');
      });

      ws.on('error', (...args: unknown[]) => {
        clearInterval(pingInterval);
        log.error({ peerId, err: args[0] }, 'Web WS client error');
        this._clients.delete(peerId);
      });
    });

    // HTTP request listener: only handles /chat and /api/message.
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this._handleHTTP(req, res);
    });

    // WebSocket upgrade listener: only handles /chat/ws.
    server.on('upgrade', (req: http.IncomingMessage, socket: unknown, head: unknown) => {
      const upgradeUrl = req.url ?? '/';
      const upgradePath = upgradeUrl.split('?')[0] ?? '/';
      if (upgradePath !== '/chat/ws') {
        // Not our path — leave for the JSON-RPC ws-server.ts upgrade listener.
        return;
      }

      const sock = socket as { write: (s: string) => void; destroy: () => void };
      const clientIp = (req.socket as { remoteAddress?: string } | null)?.remoteAddress;

      // Fix 3: CSWSH — Origin allowlist check.
      // In production, reject connections from unlisted or missing origins.
      // In dev/test (NODE_ENV !== 'production'), allow missing origin with a warning.
      const origin = req.headers.origin;
      const rawAllowed = process.env['WEB_CHAT_ALLOWED_ORIGINS'];
      const allowedOrigins: string[] = rawAllowed
        ? rawAllowed.split(',').map((o) => o.trim()).filter(Boolean)
        : [`http://127.0.0.1:${process.env['GATEWAY_PORT'] ?? '18900'}`, `http://localhost:${process.env['GATEWAY_PORT'] ?? '18900'}`];
      // Auto-allow common Vite / local dev origins so local testing works without env tweaks.
      const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'];
      const originOk = origin
        ? allowedOrigins.includes(origin) || devOrigins.includes(origin)
        : false;

      if (!originOk) {
        if (isProductionMode()) {
          log.warn({ clientIp, origin }, 'WebSocket /chat/ws rejected — origin not in allowlist');
          sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          sock.destroy();
          return;
        }
        // Dev/test: allow but warn (ws client does not send Origin header)
        log.warn({ clientIp, origin: origin ?? '(none)' }, 'WebSocket /chat/ws — no/unknown origin, allowing in non-production mode');
      }

      // Fix 2: Auth — check WEB_CHAT_TOKEN via Bearer header or ?token= param.
      // Skip auth for local/loopback connections so dev testing works seamlessly.
      const wsToken = process.env['WEB_CHAT_TOKEN'] ?? '';
      const isLocalDev = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost' || clientIp?.startsWith('192.168.') || clientIp?.startsWith('10.');
      if (wsToken && !isLocalDev) {
        let parsedUpgradeUrl: URL;
        try {
          parsedUpgradeUrl = new URL(upgradeUrl, 'http://localhost');
        } catch {
          parsedUpgradeUrl = new URL('/', 'http://localhost');
        }
        const providedToken = extractToken(req, parsedUpgradeUrl);
        if (!safeTokenEqual(providedToken, wsToken)) {
          log.warn({ clientIp }, 'WebSocket /chat/ws auth failed — invalid or missing token');
          sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          sock.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket as import('stream').Duplex, head as Buffer, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    this._isConnected = true;
    log.info({ chatPath: '/chat', wsPath: '/chat/ws' }, 'Web adapter attached to gateway server');
  }

  /**
   * Deprecated: use attach(server) instead.
   * Kept as a no-op stub so existing call sites (tests, etc.) don't throw.
   */
  async start(): Promise<void> {
    log.warn('WebAdapter.start() is deprecated — use attach(gatewayServer) instead. start() is a no-op in attach mode.');
    this._isConnected = true;
  }

  async stop(): Promise<void> {
    try {
      for (const ws of this._clients.values()) {
        ws.close();
      }
      this._clients.clear();
    } catch (err) {
      log.error({ err }, 'Error stopping Web adapter');
    } finally {
      this._isConnected = false;
      log.info('Web adapter stopped');
    }
  }

  async send(peerId: string, text: string, _options?: SendOptions): Promise<void> {
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    if (!this._isConnected) {
      throw new ChannelError('Web adapter is not connected', 'channel_not_connected', { peerId });
    }

    const ws = this._clients.get(peerId);
    if (!ws) {
      log.warn({ peerId }, 'Web send: no active WS connection for peerId — dropped');
      return;
    }

    try {
      ws.send(text);
      log.debug({ peerId, textLen: text.length }, 'Web WS message sent');
    } catch (err) {
      log.error({ peerId, err }, 'Web send failed');
      throw new ChannelError('Failed to send Web message', 'channel_send_failed', {
        peerId,
        cause: String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP handler — only /chat (GET) and /api/message (POST)
  // ---------------------------------------------------------------------------

  private async _handleHTTP(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    const url = rawUrl.split('?')[0] ?? '/';

    // Only handle paths this adapter owns; leave everything else to other listeners.
    if (url !== '/chat' && url !== '/api/message') {
      return;
    }

    // -----------------------------------------------------------------------
    // Auth: if WEB_CHAT_TOKEN is set, require it via Authorization: Bearer header
    // or ?token= query parameter (timing-safe comparison).
    // Skip auth for local/loopback connections so dev testing works seamlessly
    // (mirrors the WS upgrade path bypass above).
    // -----------------------------------------------------------------------
    const requiredToken = process.env['WEB_CHAT_TOKEN'] ?? '';
    const clientIp = (req.socket as { remoteAddress?: string } | null)?.remoteAddress;
    const isLocalDev = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === 'localhost' || clientIp?.startsWith('192.168.') || clientIp?.startsWith('10.');
    if (requiredToken && !isLocalDev) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl, `http://${req.headers['host'] ?? 'localhost'}`);
      } catch {
        parsedUrl = new URL('/', 'http://localhost');
      }
      const providedToken = extractToken(req, parsedUrl);
      if (!safeTokenEqual(providedToken, requiredToken)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized. Provide Authorization: Bearer <token> header or ?token=YOUR_TOKEN in the URL.');
        return;
      }
    }

    // -----------------------------------------------------------------------
    // GET /chat — serve React SPA via static middleware, fallback to inline HTML
    // -----------------------------------------------------------------------
    if (method === 'GET' && url === '/chat') {
      const served = serveStaticFile(req, res, '/chat');
      if (!served) {
        // Fallback: serve minimal inline HTML if SPA not built. Apply the same
        // nonce-based CSP as the static SPA path so the security posture (and the
        // gateway's CSP contract) holds even before `vite build` has produced dist/.
        const nonce = randomBytes(16).toString('base64');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': buildSpaCSPHeader(nonce),
        });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="csp-nonce" content="${nonce}"><title>SUDO Chat</title></head><body><h1>SUDO Chat</h1><p>React SPA not built. Run: npx vite build</p></body></html>`);
      }
      return;
    }

    // -----------------------------------------------------------------------
    // REST API: POST /api/message
    // Body cap: 64 KB hard limit. Reject at the streaming level to avoid OOM.
    // -----------------------------------------------------------------------
    if (method === 'POST' && url === '/api/message') {
      const MAX_BODY_BYTES = 64 * 1024; // 64 KB
      let body = '';
      let totalBytes = 0;
      let overLimit = false;

      req.on('data', (chunk: Buffer) => {
        if (overLimit) return;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          overLimit = true;
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload too large (max 64KB)');
          req.destroy();
          return;
        }
        body += chunk.toString();
      });

      req.on('end', () => {
        if (overLimit) return;
        try {
          const data = JSON.parse(body) as { peerId?: string; text?: string };
          if (!data.peerId || !data.text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'peerId and text are required' }));
            return;
          }
          // Echo the injected user message to the browser so both sides are visible
          const senderWs = this._clients.get(data.peerId);
          if (senderWs) {
            try { senderWs.send(JSON.stringify({ type: 'user_echo', text: data.text })); } catch { /* best-effort */ }
          }
          void this._dispatch(data.peerId, data.text).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // Should not reach here (guarded above), but keep a safe fallback.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }

  // ---------------------------------------------------------------------------
  // Normalize
  // ---------------------------------------------------------------------------

  private async _dispatch(peerId: string, text: string): Promise<void> {
    if (!this._handler) {
      log.warn({ peerId }, 'No handler — Web message dropped');
      return;
    }

    const msg: UnifiedMessage = {
      id: `${Date.now()}-${peerId}`,
      channel: 'web',
      peerId,
      peerName: peerId,
      chatType: 'dm',
      text,
      timestamp: new Date(),
    };

    log.debug({ peerId, textLen: text.length }, 'inbound Web message');

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ peerId, err }, 'Web message handler error');
    }
  }
}
