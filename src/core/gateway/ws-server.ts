/**
 * gateway/ws-server.ts
 *
 * Attaches a WebSocket JSON-RPC server to an existing http.Server.
 *
 * Transport:   ws package (WebSocketServer)
 * Path:        defaults to '/ws'
 * Auth:        optional bearer token via ?token= query param on the Upgrade request
 * Protocol:    RpcRequest → RpcResponse (one response per request)
 *              Server may also push RpcEvent messages at any time
 *
 * GW-8 hardening:
 *   - Idempotency keys on mutating methods (dedupe, single execution).
 *   - Backpressure contract: hello advertises {maxPayload, maxBufferedBytes};
 *     slow consumers past the buffer ceiling are closed (metadata-only log).
 *   - Preauth flood control: per-IP auth-attempt lockout at upgrade;
 *     per-connection unauthorized-frame cap; preauth frame-size cap.
 *   - Close codes: 1008 policy, 1009 too-big, 1013 suspending, 4001 auth-rotated.
 *
 * Error policy:
 *   - Parse errors       → respond with code -32700 (Parse error)
 *   - Unknown method     → respond with code -32601 (Method not found)
 *   - Handler throws     → respond with code -32603 (Internal error)
 *   - Never throw out of this module
 */

import { authenticateToken, type GatewayPrincipal } from './auth.js';
import {
  ConnectParamsSchema,
  buildHelloOk,
  mayCallMethod,
  requiredScopeFor,
  rpcV2Enabled,
  isMutatingMethod,
  WS_CLOSE,
  PREAUTH_MAX_FRAME_BYTES,
  MAX_BUFFERED_BYTES,
  MAX_UNAUTHORIZED_FRAMES,
} from './rpc-schema.js';
import { IdempotencyStore } from './idempotency.js';
import { SlidingWindowLimiter } from './rate-limit.js';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { createLogger } from '../shared/logger.js';
import { buildRpcRouter } from './rpc-handlers.js';
import type { RpcRequest, RpcResponse } from './rpc-types.js';

const log = createLogger('ws-server');

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Maximum simultaneous WebSocket connections per remote IP. */
const MAX_CONNECTIONS_PER_IP = 10;

/** Maximum messages per interval per connection. */
const MSG_RATE_LIMIT = 30;
const MSG_RATE_WINDOW_MS = 10_000;

/** Per-IP active connection counts. */
const ipConnectionCounts = new Map<string, number>();

/**
 * GW-8: per-IP upgrade auth-attempt limiter (10 failed auths/min → 5-min
 * lockout). Shared shape with webhook auth flood control (rate-limit.ts).
 * Module-scoped so it persists across connections for the process lifetime.
 */
const authAttemptLimiter = new SlidingWindowLimiter({
  limit: 10,
  windowMs: 60_000,
  lockoutMs: 5 * 60_000,
});

/** GW-8: process-wide idempotency cache for mutating RPC methods. */
const idempotency = new IdempotencyStore();

/** Increment the count for an IP; return false if it would exceed the cap. */
function trackIpConnect(ip: string): boolean {
  const current = ipConnectionCounts.get(ip) ?? 0;
  if (current >= MAX_CONNECTIONS_PER_IP) return false;
  ipConnectionCounts.set(ip, current + 1);
  return true;
}

/** Decrement the count for an IP when a connection closes. */
function trackIpDisconnect(ip: string): void {
  const current = ipConnectionCounts.get(ip) ?? 0;
  if (current <= 1) {
    ipConnectionCounts.delete(ip);
  } else {
    ipConnectionCounts.set(ip, current - 1);
  }
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Server-level dependencies passed in at startup.
 * All fields are typed as `unknown` so ws-server.ts remains decoupled from
 * the concrete types of each subsystem.
 */
export interface WsServerDeps {
  /** The Node.js http.Server that the WebSocket server will attach to. */
  httpServer: HttpServer;
  /** Session manager — used by chat/sessions handlers. */
  sessionManager: unknown;
  /** Tool registry — used by tools.catalog. */
  toolRegistry: unknown;
  /** Agent loop — used by chat.send / chat.abort. */
  agentLoop: unknown;
  /** Optional cron manager — used by cron.* handlers. */
  cronManager?: unknown;
  /** Optional hook manager — lifecycle hooks for extensibility. */
  hookManager?: unknown;
}

/** Options for configuring the WebSocket RPC server. */
export interface WsServerOptions {
  /**
   * If set, every upgrade request must include `?token=<secret>`.
   * Connections that omit or mismatch the token are rejected with HTTP 401.
   */
  secret?: string;
  /**
   * The URL path the WebSocket server listens on.
   * Defaults to '/ws'.
   */
  path?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** JSON-encode a value; returns null on failure (should never happen). */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Send a pre-built RpcResponse to a WebSocket client, absorbing errors. */
function sendResponse(ws: WebSocket, response: RpcResponse): void {
  const payload = safeStringify(response);
  if (payload === null) {
    log.error({ id: response.id }, 'Failed to serialize RpcResponse');
    return;
  }
  try {
    ws.send(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ id: response.id, err: msg }, 'ws.send failed — client may have disconnected');
  }
}

/** Validate that a parsed value looks like an RpcRequest. */
function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && typeof v['method'] === 'string';
}

/** Extract the optional idempotencyKey from a parsed frame (string or undefined). */
function extractIdempotencyKey(value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const k = (value as Record<string, unknown>)['idempotencyKey'];
    if (typeof k === 'string' && k.length > 0 && k.length <= 200) return k;
  }
  return undefined;
}

/** Extract the ?token= query param from an upgrade request URL. */
function extractToken(req: IncomingMessage): string | null {
  try {
    // req.url on an upgrade request is a path+query string, not a full URL.
    const base = 'http://localhost'; // dummy base for URL parsing
    const parsed = new URL(req.url ?? '/', base);
    return parsed.searchParams.get('token');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocket JSON-RPC server to the provided http.Server.
 *
 * The WebSocketServer does NOT create its own HTTP server; it hooks into
 * the existing one via the 'upgrade' event so both HTTP and WS share port 18900.
 *
 * @param deps    - Runtime dependencies (session manager, tool registry, etc.)
 * @param options - Optional config (auth secret, path).
 * @returns The constructed WebSocketServer instance (useful for testing / shutdown).
 */
export function attachWsRpc(
  deps: WsServerDeps,
  options: WsServerOptions = {},
): WebSocketServer {
  const wsPath = options.path ?? '/ws';
  const secret = options.secret ?? null;

  const router = buildRpcRouter(deps);

  // noServer: true — we handle the 'upgrade' event ourselves so we can
  // perform auth before handing off to the WebSocketServer.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  // -------------------------------------------------------------------------
  // Upgrade handler — auth gate + path check
  // -------------------------------------------------------------------------
  deps.httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const base = 'http://localhost';
    let reqPath = '/';
    try {
      reqPath = new URL(req.url ?? '/', base).pathname;
    } catch {
      // malformed URL — reject
    }

    // Only handle our designated path; leave other upgrade requests alone.
    if (reqPath !== wsPath) {
      log.debug({ reqPath, wsPath }, 'Upgrade request not for WS path — ignoring');
      return;
    }

    // GW-8: preauth flood control — an IP that has flooded failed auth attempts
    // is locked out before we even do the constant-time compare.
    const upgradeIp = req.socket.remoteAddress ?? 'unknown';
    if (authAttemptLimiter.isLocked(upgradeIp)) {
      log.warn({ reqPath, ip: upgradeIp }, 'WebSocket upgrade rejected — auth-attempt lockout');
      (socket as import('node:net').Socket).write(
        'HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }

    // Auth via the unified module (./auth.ts): the injected GATEWAY_SECRET (as the
    // gateway-secret credential) OR the operator GATEWAY_TOKEN, presented via ?token=.
    // Loopback-dev when no secret is configured; fail-closed when proxied.
    // SUDO_GATEWAY_UNIFIED_AUTH=0 restores the legacy open-when-unset behaviour.
    const secretBuf = secret !== null ? Buffer.from(secret, 'utf8') : null;
    const principal = authenticateToken(extractToken(req), req, {
      accept: ['gateway-secret', 'gateway-token', 'loopback'],
      legacySecretEnv: 'GATEWAY_SECRET',
      secretOverride: secretBuf,
      secretOverrideCredential: 'gateway-secret',
    });
    if (!principal.ok) {
      // GW-8: count the failed auth toward the per-IP lockout.
      authAttemptLimiter.record(upgradeIp);
      log.warn({ reqPath, ip: upgradeIp, reason: principal.reason }, 'WebSocket upgrade rejected — invalid or missing token');
      // Destroy the socket with an HTTP 401 response.
      (socket as import('node:net').Socket).write(
        'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    // Verified-good auth clears any accumulated attempts for this IP.
    authAttemptLimiter.reset(upgradeIp);

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as WebSocket & { _principal?: GatewayPrincipal })._principal = principal;
      wss.emit('connection', ws, req);
    });
  });

  // -------------------------------------------------------------------------
  // Connection handler
  // -------------------------------------------------------------------------
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remoteIp = req.socket.remoteAddress ?? 'unknown';
    const clientId = `${remoteIp}:${req.socket.remotePort ?? 0}`;

    // Per-IP connection cap
    if (!trackIpConnect(remoteIp)) {
      log.warn({ clientId, remoteIp }, 'WebSocket connection rejected — per-IP connection limit exceeded');
      ws.close(WS_CLOSE.POLICY, 'Too many connections from this IP');
      return;
    }

    log.info({ clientId }, 'WebSocket client connected');

    // Slice C/2: when RPC v2 is on, require a connect handshake first frame and
    // enforce per-method operator scopes against the auth principal from upgrade.
    const principal = (ws as WebSocket & { _principal?: GatewayPrincipal })._principal;
    let handshakeDone = !rpcV2Enabled();

    // GW-8: per-connection unauthorized/out-of-order frame counter.
    let unauthorizedFrames = 0;

    // Per-connection message rate limiting: max MSG_RATE_LIMIT messages per MSG_RATE_WINDOW_MS
    let msgCount = 0;
    const msgRateTimer = setInterval(() => { msgCount = 0; }, MSG_RATE_WINDOW_MS);

    // Heartbeat: ping every 25s to detect stale connections early
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, 25_000);
    ws.on('pong', () => { /* alive */ });

    /** GW-8: record an unauthorized/out-of-order frame; close at the cap. */
    const flagUnauthorized = (): boolean => {
      unauthorizedFrames += 1;
      if (unauthorizedFrames >= MAX_UNAUTHORIZED_FRAMES) {
        log.warn({ clientId, unauthorizedFrames }, 'WebSocket unauthorized-frame cap reached — closing');
        ws.close(WS_CLOSE.POLICY, 'Too many unauthorized frames');
        return true;
      }
      return false;
    };

    /** GW-8: slow-consumer guard — close if the send buffer is over the ceiling. */
    const backpressureExceeded = (): boolean => {
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        log.warn({ clientId, bufferedAmount: ws.bufferedAmount }, 'WebSocket slow consumer — closing (buffer over ceiling)');
        ws.close(WS_CLOSE.POLICY, 'Slow consumer');
        return true;
      }
      return false;
    };

    // -----------------------------------------------------------------------
    // Message handler
    // -----------------------------------------------------------------------
    ws.on('message', (raw) => {
      // GW-8: slow-consumer backpressure check before doing any work.
      if (backpressureExceeded()) return;

      msgCount++;
      if (msgCount > MSG_RATE_LIMIT) {
        log.warn({ clientId, msgCount }, 'WebSocket message rate limit exceeded — dropping message');
        sendResponse(ws, {
          id: '',
          error: { code: -32000, message: 'Rate limit exceeded' },
        });
        return;
      }

      const rawBytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw), 'utf8');
      // GW-8: preauth frame-size cap — before the connect handshake completes,
      // frames are tiny (connect only); anything larger is rejected.
      if (!handshakeDone && rawBytes > PREAUTH_MAX_FRAME_BYTES) {
        log.warn({ clientId, rawBytes }, 'WebSocket preauth frame exceeds cap — closing');
        ws.close(WS_CLOSE.TOO_BIG, 'Preauth frame too large');
        return;
      }

      let parsed: unknown;
      const rawStr = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);

      // 1. Parse JSON
      try {
        parsed = JSON.parse(rawStr);
      } catch {
        log.warn({ clientId, rawStr: rawStr.slice(0, 200) }, 'Failed to parse WebSocket message as JSON');
        sendResponse(ws, {
          id: '',
          error: { code: -32700, message: 'Parse error: message must be valid JSON' },
        });
        return;
      }

      // 2. Validate RpcRequest shape
      if (!isRpcRequest(parsed)) {
        log.warn({ clientId, parsed }, 'Message is not a valid RpcRequest');
        sendResponse(ws, {
          id: '',
          error: { code: -32600, message: 'Invalid Request: missing id or method' },
        });
        return;
      }

      const { id, method, params } = parsed;
      const idempotencyKey = extractIdempotencyKey(parsed);

      // 2b. RPC v2 (gated): connect handshake + per-method operator scopes.
      if (rpcV2Enabled()) {
        if (!handshakeDone) {
          if (method !== 'connect') {
            // Out-of-order frame before the handshake — unauthorized.
            if (flagUnauthorized()) return;
            sendResponse(ws, { id, error: { code: -32001, message: 'Expected connect as the first frame' } });
            return;
          }
          if (!ConnectParamsSchema.safeParse(params).success) {
            sendResponse(ws, { id, error: { code: -32602, message: 'Invalid connect params' } });
            return;
          }
          handshakeDone = true;
          sendResponse(ws, { id, result: buildHelloOk(principal, Array.from(router.keys())) });
          return;
        }
        if (method === 'connect') {
          sendResponse(ws, { id, error: { code: -32002, message: 'Already connected' } });
          return;
        }
        if (!mayCallMethod(principal, method)) {
          if (flagUnauthorized()) return;
          sendResponse(ws, { id, error: { code: -32003, message: `Forbidden: requires ${requiredScopeFor(method)}` } });
          return;
        }
        // GW-8: mutating methods MUST carry an idempotencyKey under v2.
        if (isMutatingMethod(method) && idempotencyKey === undefined) {
          sendResponse(ws, { id, error: { code: -32602, message: `idempotencyKey required for mutating method ${method}` } });
          return;
        }
      }

      // 3. Route to handler (async, errors caught below)
      const handler = router.get(method);
      if (handler === undefined) {
        log.warn({ clientId, id, method }, 'Unknown RPC method');
        sendResponse(ws, {
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        return;
      }

      log.debug({ clientId, id, method, idempotent: idempotencyKey !== undefined }, 'Dispatching RPC call');

      // GW-8: idempotency — a mutating method with a key runs at most once per
      // key within the TTL; a duplicate returns the same settled result.
      const exec: Promise<unknown> =
        idempotencyKey !== undefined && isMutatingMethod(method)
          ? idempotency.run(`${method}:${idempotencyKey}`, () => handler(params)).promise
          : handler(params);

      exec.then((result) => {
        sendResponse(ws, { id, result });
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ clientId, id, method, err: msg }, 'RPC handler threw an error');
        // Fix 8: Do not leak internal error details to the client
        sendResponse(ws, {
          id,
          error: { code: -32603, message: 'Internal server error' },
        });
      });
    });

    // -----------------------------------------------------------------------
    // Error / close handlers
    // -----------------------------------------------------------------------
    ws.on('error', (err) => {
      log.error({ clientId, err: err.message }, 'WebSocket error');
    });

    ws.on('close', (code, reason) => {
      clearInterval(msgRateTimer);
      clearInterval(pingInterval);
      trackIpDisconnect(remoteIp);
      const reasonStr = reason ? reason.toString() : '';
      log.info({ clientId, code, reason: reasonStr }, 'WebSocket client disconnected');
    });
  });

  wss.on('error', (err) => {
    log.error({ err: err.message }, 'WebSocketServer error');
  });

  log.info({ path: wsPath, auth: secret !== null }, 'WebSocket RPC server attached');
  return wss;
}

/**
 * GW-8: close every live connection with 4001 (auth-rotated) so clients re-auth
 * cleanly after a GATEWAY_TOKEN rotation. Call from the token-reload seam.
 */
export function closeAllForAuthRotation(wss: WebSocketServer): void {
  for (const ws of wss.clients) {
    try {
      ws.close(WS_CLOSE.AUTH_ROTATED, 'GATEWAY_TOKEN rotated — re-authenticate');
    } catch {
      /* best effort */
    }
  }
}
