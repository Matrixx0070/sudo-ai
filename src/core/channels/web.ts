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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { WebSocketServer } from 'ws';
import { createLogger } from '../shared/logger.js';
import { ChannelError } from '../shared/errors.js';
import { projectPath } from '../shared/paths.js';
import { serveStaticFile, buildSpaCSPHeader } from '../gateway/static-middleware.js';
import type { ChannelAdapter } from './adapter.js';
import type { AgentEvent } from '../agent/types.js';
import type {
  ChannelType,
  MediaAttachment,
  MessageHandler,
  SendOptions,
  UnifiedMessage,
} from './types.js';

const log = createLogger('channels:web');

// ---------------------------------------------------------------------------
// File-upload support
// ---------------------------------------------------------------------------

/** Directory where browser-uploaded files are saved (shared with Telegram). */
const WEB_UPLOAD_DIR = projectPath('data', 'uploads');
/** Hard cap on a decoded upload (10 MB). base64 inflates ~1.37x on the wire. */
const WEB_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** WS frame cap — covers base64 payload + JSON envelope overhead above the decoded cap. */
const WEB_WS_MAX_PAYLOAD = 16 * 1024 * 1024;
/** Max size of an outbound media attachment embedded (base64) in a WS reply frame. */
const WEB_MEDIA_OUT_MAX_BYTES = 8 * 1024 * 1024;

/** Envelope the browser sends over the WS to upload a file. */
interface AttachmentEnvelope {
  name: string;
  mime: string;
  dataBase64: string;
  caption?: string;
}

/**
 * Parse a raw WS frame as an attachment envelope.
 * Returns null for anything that isn't a `{ type:'__attachment', ... }` object
 * with the required string fields — so plain-text messages (the common case,
 * including text that happens to be JSON) fall through to normal dispatch.
 */
/**
 * Build the WS frame that delivers an agent media attachment to the browser.
 * The SPA's reply handler renders `media[]` (image preview / audio player /
 * download link) from these data-URL parts — keep the shape in sync with the
 * client's `ChatWSMedia` type.
 */
export function buildMediaReplyFrame(part: { type: string; mimeType: string; filename?: string; dataBase64: string }): string {
  return JSON.stringify({
    type: 'reply',
    content: '',
    media: [{
      type: part.type,
      mimeType: part.mimeType,
      filename: part.filename ?? 'file',
      dataBase64: part.dataBase64,
    }],
  });
}

/**
 * Map an agent-loop event to a WS frame the SPA already renders, so the web
 * chat shows live activity during a turn instead of a silent wait:
 *   - tool-call   → a `progress` frame ("Running <tool>…") → ProgressBar
 *   - stream-chunk→ a `token` frame (the step's text) → streaming preview bubble
 * Returns null for events the web UI doesn't surface. Keep frame shapes in sync
 * with the SPA's `ChatWSMessage` union (useWebSocket.ts).
 */
export function agentEventToWebFrame(ev: AgentEvent): string | null {
  if (ev.type === 'tool-call') {
    return JSON.stringify({ type: 'progress', text: `Running ${ev.name}…` });
  }
  if (ev.type === 'stream-chunk' && ev.chunk.trim()) {
    return JSON.stringify({ type: 'token', text: ev.chunk });
  }
  return null;
}

export function parseAttachmentEnvelope(raw: string): AttachmentEnvelope | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o['type'] !== '__attachment') return null;
  if (typeof o['name'] !== 'string' || typeof o['mime'] !== 'string' || typeof o['dataBase64'] !== 'string') {
    return null;
  }
  return {
    name: o['name'],
    mime: o['mime'],
    dataBase64: o['dataBase64'],
    ...(typeof o['caption'] === 'string' ? { caption: o['caption'] } : {}),
  };
}

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

    // Admin REST handlers are registered (and dispatched) solely by
    // api/admin/register.ts via the gateway wiring in cli.ts when
    // SUDO_ADMIN_API=1. The WebAdapter has no /api/admin dispatcher, so it no
    // longer registers them here.

    // Build a noServer WebSocketServer for /chat/ws connections only.
    // maxPayload bounds inbound frames so a large file upload (base64 over WS)
    // is accepted up to the cap but cannot exhaust memory.
    const wss = new WebSocketServer({ noServer: true, maxPayload: WEB_WS_MAX_PAYLOAD });

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
        const raw = data.toString();
        const ip = (httpReq.socket as { remoteAddress?: string } | null)?.remoteAddress;
        // A file upload arrives as a JSON attachment envelope; everything else
        // is a plain-text message. Only frames starting with '{' are parse-probed.
        if (raw.length > 0 && raw[0] === '{') {
          const env = parseAttachmentEnvelope(raw);
          if (env) { void this._handleAttachment(peerId, env, ip); return; }
        }
        const text = raw.trim();
        if (!text) return;
        void this._dispatch(peerId, text, ip);
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

  /**
   * Deliver an agent media attachment (image, voice/audio, generated file) to the
   * browser by base64-embedding it in a `{type:'reply', media:[…]}` WS frame, which
   * the SPA renders inline (image preview / audio player / download link). The
   * symmetric counterpart to the inbound upload path. `attachment.buffer` must be
   * populated by the caller; oversized files are dropped (logged), not embedded.
   */
  async sendMedia(peerId: string, attachment: MediaAttachment): Promise<void> {
    if (!peerId) {
      throw new ChannelError('peerId must not be empty', 'channel_invalid_peer', { peerId });
    }
    if (!this._isConnected) {
      throw new ChannelError('Web adapter is not connected', 'channel_not_connected', { peerId });
    }
    const ws = this._clients.get(peerId);
    if (!ws) {
      log.warn({ peerId }, 'Web sendMedia: no active WS connection for peerId — dropped');
      return;
    }
    const buf = attachment.buffer;
    if (!buf || buf.length === 0) {
      log.warn({ peerId, filename: attachment.filename }, 'Web sendMedia: no bytes — dropped');
      return;
    }
    if (buf.length > WEB_MEDIA_OUT_MAX_BYTES) {
      log.warn({ peerId, bytes: buf.length, filename: attachment.filename }, 'Web sendMedia: attachment too large to embed — dropped');
      return;
    }

    const frame = buildMediaReplyFrame({
      type: attachment.type,
      mimeType: attachment.mimeType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      dataBase64: buf.toString('base64'),
    });
    try {
      ws.send(frame);
      log.info({ peerId, type: attachment.type, bytes: buf.length }, 'Web media reply sent');
    } catch (err) {
      log.error({ peerId, err }, 'Web sendMedia failed');
      throw new ChannelError('Failed to send Web media', 'channel_send_failed', {
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
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="csp-nonce" content="${nonce}"><title>SUDO-AI Chat</title></head><body><h1>SUDO-AI Chat</h1><p>React SPA not built. Run: npx vite build</p></body></html>`);
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
          void this._dispatch(data.peerId, data.text, (req.socket as { remoteAddress?: string } | null)?.remoteAddress)
            .then(() => {
              if (res.headersSent || res.writableEnded) return;
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            })
            .catch((err) => {
              log.error({ peerId: data.peerId, err }, 'POST /api/message dispatch reply failed');
              if (res.headersSent || res.writableEnded) return;
              try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false }));
              } catch { /* best-effort */ }
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

  /**
   * Push a structured status frame ({ type, error }) to a connected client.
   * Best-effort: silently no-ops if the peer has no open socket.
   */
  private _notifyClient(peerId: string, type: 'error', message: string): void {
    const ws = this._clients.get(peerId);
    if (!ws) return;
    try { ws.send(JSON.stringify({ type, error: message })); } catch { /* best-effort */ }
  }

  /**
   * Handle a browser file upload: decode + size-check, sanitize the filename,
   * persist under data/uploads/, then dispatch a normal message whose text names
   * the saved path (with a vision hint for images) and carries `media` metadata —
   * mirroring the Telegram photo/document path so the agent treats it identically.
   */
  private async _handleAttachment(peerId: string, env: AttachmentEnvelope, peerIp?: string): Promise<void> {
    let buf: Buffer;
    try {
      buf = Buffer.from(env.dataBase64, 'base64');
    } catch {
      log.warn({ peerId }, 'Web attachment: invalid base64 — dropped');
      this._notifyClient(peerId, 'error', 'Attachment could not be decoded.');
      return;
    }
    if (buf.length === 0) {
      this._notifyClient(peerId, 'error', 'Attachment was empty.');
      return;
    }
    if (buf.length > WEB_UPLOAD_MAX_BYTES) {
      log.warn({ peerId, bytes: buf.length }, 'Web attachment too large — dropped');
      this._notifyClient(peerId, 'error', `Attachment too large (max ${Math.floor(WEB_UPLOAD_MAX_BYTES / 1024 / 1024)}MB).`);
      return;
    }

    // Sanitize: basename only (no path traversal), allowlist chars, bound length.
    const rawName = basename(env.name || 'upload');
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'upload';
    const savedPath = join(WEB_UPLOAD_DIR, `web-${Date.now()}-${safeName}`);
    try {
      mkdirSync(WEB_UPLOAD_DIR, { recursive: true });
      writeFileSync(savedPath, buf);
    } catch (err) {
      log.error({ peerId, err }, 'Web attachment: failed to save');
      this._notifyClient(peerId, 'error', 'Failed to save the attachment.');
      return;
    }

    const isImage = env.mime.startsWith('image/');
    const label = isImage ? 'Image' : 'File';
    const visionHint = isImage ? ' Use browser.vision to analyze it if needed.' : '';
    const caption = env.caption?.trim() ?? '';
    const textWithHint = caption
      ? `${caption}\n[${label} attached: ${savedPath}.${visionHint}]`
      : `[${label} attached: ${savedPath}.${visionHint}]`;

    const media: MediaAttachment[] = [{
      type: isImage ? 'image' : 'document',
      mimeType: env.mime || 'application/octet-stream',
      filename: safeName,
      url: savedPath,
    }];

    log.info({ peerId, savedPath, bytes: buf.length, mime: env.mime }, 'Web attachment received');
    void this._dispatch(peerId, textWithHint, peerIp, media);
  }

  private async _dispatch(peerId: string, text: string, peerIp?: string, media?: MediaAttachment[]): Promise<void> {
    if (!this._handler) {
      log.warn({ peerId }, 'No handler — Web message dropped');
      return;
    }

    const msg: UnifiedMessage = {
      id: `${Date.now()}-${peerId}`,
      channel: 'web',
      peerId,
      ...(peerIp ? { peerIp } : {}),
      peerName: peerId,
      chatType: 'dm',
      text,
      timestamp: new Date(),
      ...(media && media.length ? { media } : {}),
    };

    log.debug({ peerId, textLen: text.length }, 'inbound Web message');

    try {
      await this._handler(msg);
    } catch (err) {
      log.error({ peerId, err }, 'Web message handler error');
    }
  }
}
