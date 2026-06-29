/**
 * @file tenancy/front-door.ts
 * @description Stage 2 — public front-door reverse proxy for instance-per-tenant.
 *
 * The ONLY public entry point. Tenant instances bind loopback-only (127.0.0.1), so
 * they are unreachable except through this proxy. Flow per request:
 *   1. The user presents THEIR public `userKey` (Bearer header or ?token=).
 *   2. We resolve it (timing-safe) to a tenant.
 *   3. We reverse-proxy to that tenant's loopback instance, REPLACING the
 *      Authorization with the tenant's INTERNAL token — the user never holds or
 *      sees the instance token.
 * Streaming (SSE/chunked) is preserved; the request body is size-capped; hop-by-hop
 * headers are stripped; the internal token is never logged or echoed to the client.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { TenantManager } from './tenant-manager.js';
import type { Tenant } from './types.js';

const log = createLogger('tenancy:front-door');

/** Request headers we never forward upstream (hop-by-hop + ones we set ourselves). */
const STRIP_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection',
  'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'authorization',
]);
/** Response headers we never forward back (hop-by-hop). */
const STRIP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authenticate',
]);

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

export interface TenantFrontDoorOptions {
  manager: TenantManager;
  /** Public port to bind. */
  port: number;
  /** Bind host — defaults to all interfaces (this is the public entry point). */
  host?: string;
  /** Max client request body before 413. */
  maxBodyBytes?: number;
  /** Upstream connect/response timeout before 504. */
  upstreamTimeoutMs?: number;
}

/** Timing-safe string equality (length-guarded — timingSafeEqual throws on length mismatch). */
function timingSafeStrEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Extract the bearer credential from the Authorization header or ?token= query param. */
function extractCredential(req: IncomingMessage): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    return url.searchParams.get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Public reverse proxy that authenticates a user's `userKey` and routes to their
 * isolated tenant instance with the internal token injected.
 */
export class TenantFrontDoor {
  private readonly manager: TenantManager;
  private readonly port: number;
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private readonly upstreamTimeoutMs: number;
  private server: http.Server | null = null;

  constructor(opts: TenantFrontDoorOptions) {
    this.manager = opts.manager;
    this.port = opts.port;
    this.host = opts.host ?? '0.0.0.0';
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  }

  /** Resolve a presented public key to its tenant (timing-safe), or null. */
  resolveTenant(presentedKey: string): Tenant | null {
    if (!presentedKey) return null;
    let match: Tenant | null = null;
    // Compare against EVERY tenant (no early-return) so timing doesn't leak which
    // tenant matched or how far the scan got.
    for (const t of this.manager.list()) {
      if (timingSafeStrEq(presentedKey, t.userKey)) {
        match = t;
      }
    }
    return match;
  }

  /** The actual bound port (useful when constructed with port 0 in tests). */
  address(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.removeListener('error', reject);
        log.info({ port: this.address(), host: this.host }, 'TenantFrontDoor listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private _handle(req: IncomingMessage, res: ServerResponse): void {
    const key = extractCredential(req);
    if (!key) {
      sendJson(res, 401, { error: 'missing credential' });
      return;
    }
    const tenant = this.resolveTenant(key);
    if (!tenant) {
      // Do not reveal whether the key was well-formed — a wrong key is just unauthorized.
      sendJson(res, 401, { error: 'invalid credential' });
      return;
    }
    if (tenant.status !== 'running') {
      sendJson(res, 503, { error: 'tenant not running' });
      return;
    }
    this._proxy(req, res, tenant);
  }

  private _proxy(req: IncomingMessage, res: ServerResponse, tenant: Tenant): void {
    // Exactly one response is ever sent to the client. Once `responded` is set (an
    // error/limit reply OR the start of the streamed upstream response), every other
    // path is a no-op — so we never double-send or destroy the socket mid-reply.
    let responded = false;
    const respondOnce = (status: number, body: Record<string, unknown>): void => {
      if (responded || res.headersSent) return;
      responded = true;
      sendJson(res, status, body);
    };

    // Fast reject on a declared content-length over the cap — before connecting upstream.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      respondOnce(413, { error: 'payload too large' });
      req.resume(); // drain so the response delivers cleanly; do NOT destroy the client socket
      return;
    }

    // Build upstream headers: forward all but hop-by-hop + authorization, then inject
    // the INTERNAL token and point Host at the loopback instance.
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers['authorization'] = `Bearer ${tenant.token}`;
    headers['host'] = `127.0.0.1:${tenant.port}`;

    const upstream = http.request(
      { host: '127.0.0.1', port: tenant.port, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        if (responded) { upstreamRes.destroy(); return; }
        responded = true; // streaming the upstream response is our single reply
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (v === undefined) continue;
          if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
          outHeaders[k] = v;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        upstreamRes.pipe(res); // stream body (SSE/chunked preserved)
        upstreamRes.on('error', () => res.destroy());
      },
    );

    upstream.setTimeout(this.upstreamTimeoutMs, () => {
      upstream.destroy();
      respondOnce(504, { error: 'upstream timeout' });
    });
    upstream.on('error', (err) => {
      log.warn({ tenant: tenant.id, err: err.message }, 'upstream error');
      respondOnce(502, { error: 'upstream error' });
    });

    // Forward the client body while enforcing the size cap (count as we go — never
    // buffer the whole body). On overflow: 413, abandon the upstream, and DRAIN the
    // client (do not destroy its socket — that would prevent the 413 from arriving).
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      if (responded) return;
      bytes += chunk.length;
      if (bytes > this.maxBodyBytes) {
        respondOnce(413, { error: 'payload too large' });
        upstream.destroy();
        req.resume();
        return;
      }
      upstream.write(chunk);
    });
    req.on('end', () => { if (!responded) upstream.end(); });
    req.on('error', () => upstream.destroy());
  }
}
