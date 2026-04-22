/**
 * @file gateway/sse-stream.ts
 * External SSE event stream — GET /v1/sessions/:id/stream and /events.
 * Auth: GATEWAY_TOKEN bearer. Rate: max 10 connections/session. Heartbeat: 15 s.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { HookManager, HookContext, HookEvent } from '../hooks/index.js';

const log = createLogger('sse-stream');

const RING_BUFFER_MAX = 500;
const HEARTBEAT_MS = 15_000;
const MAX_CONNS_PER_SESSION = 10;

// All HookEvent values — sync with hooks/index.ts when new events are added.
const ALL_HOOK_EVENTS: HookEvent[] = [
  'before:tool-call', 'after:tool-call', 'before:brain-call', 'after:brain-call',
  'on:error', 'on:file-write', 'on:message',
  'session:start', 'session:end',
  'pre:compact', 'post:compact', 'dream:start', 'dream:end',
  'instructions:loaded', 'teammate:idle', 'swarm:spawn', 'swarm:complete',
  'background:start', 'background:complete',
  'goal:created', 'goal:completed',
  'tool:approved', 'tool:denied',
  'steering:received',
  'mcp:connected', 'a2a:message', 'file:changed',
  'command:new', 'command:reset', 'command:stop',
  'session:compact:before', 'session:compact:after', 'session:compact:patch',
  'agent:bootstrap',
  'gateway:startup', 'gateway:shutdown',
  'message:received', 'message:transcribed', 'message:preprocessed', 'message:sent',
  'before_model_resolve', 'before_prompt_build',
  'tool_result_persist',
  'before_compaction', 'after_compaction',
  'before_install', 'after_install',
  'vault:set', 'vault:get', 'vault:rotate', 'vault:delete',
  'rate-limit:triggered',
  'mcp:tool-call',
  'model:route:cheap',
  'memory:scan:triggered',
];

export interface BufferedEvent {
  event: HookEvent;
  data: HookContext;
  ts: number;
}

interface SseClient {
  res: ServerResponse;
  filteredEvents: Set<string> | null; // null = no filter (all events)
  heartbeatTimer: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// Auth helpers — mirror the pattern in http-api.ts
// ---------------------------------------------------------------------------

function getTokenBuf(): Buffer | null {
  const t = process.env['GATEWAY_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}

function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

function isAuthorised(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (tokenBuf === null) return false; // no token configured → reject all
  const candidate = Buffer.from(extractBearer(req), 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}

// ---------------------------------------------------------------------------
// URL / query-string helpers
// ---------------------------------------------------------------------------

const STREAM_RE = /^\/v1\/sessions\/([^/]+)\/stream$/;
const EVENTS_RE = /^\/v1\/sessions\/([^/]+)\/events$/;

function splitUrl(url: string): { pathname: string; search: string } {
  const q = url.indexOf('?');
  return q === -1 ? { pathname: url, search: '' } : { pathname: url.slice(0, q), search: url.slice(q + 1) };
}

function parseFilterParam(search: string): Set<string> | null {
  const raw = new URLSearchParams(search).get('events');
  if (!raw?.trim()) return null;
  const set = new Set(raw.split(',').map((e) => e.trim()).filter(Boolean));
  return set.size > 0 ? set : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function formatChunk(event: HookEvent, ctx: HookContext): string {
  try {
    return `event: ${event}\ndata: ${JSON.stringify(ctx)}\n\n`;
  } catch (err) {
    log.error({ event, err: err instanceof Error ? err.message : String(err) }, 'SSE serialisation failed');
    return `event: ${event}\ndata: {}\n\n`;
  }
}

// ---------------------------------------------------------------------------
// SseStreamBroker
// ---------------------------------------------------------------------------

/**
 * Subscribes to every HookEvent and fans out to connected SSE clients
 * filtered by sessionId. Maintains a 500-event ring buffer per session.
 */
export class SseStreamBroker {
  private readonly clients = new Map<string, Set<SseClient>>();
  private readonly ringBuffers = new Map<string, BufferedEvent[]>();
  private readonly hookIds: string[] = [];
  private readonly tokenBuf: Buffer | null;

  constructor(private readonly hookManager: HookManager) {
    this.tokenBuf = getTokenBuf();
    if (!this.tokenBuf) {
      log.warn('GATEWAY_TOKEN is not set — all SSE connections will be rejected');
    }
    this.subscribeAll();
  }

  private subscribeAll(): void {
    for (const event of ALL_HOOK_EVENTS) {
      const id = this.hookManager.register(
        event,
        async (ctx: HookContext) => { this.fanOut(event, ctx); },
        `sse-broker:${event}`,
      );
      this.hookIds.push(id);
    }
    log.info({ count: this.hookIds.length }, 'SSE broker subscribed to all hook events');
  }

  private fanOut(event: HookEvent, ctx: HookContext): void {
    const sid = ctx.sessionId;
    if (!sid) return;

    // Append to ring buffer
    const buf = this.ringBuffers.get(sid) ?? [];
    buf.push({ event, data: ctx, ts: Date.now() });
    if (buf.length > RING_BUFFER_MAX) buf.shift();
    this.ringBuffers.set(sid, buf);

    const sessionClients = this.clients.get(sid);
    if (!sessionClients?.size) return;

    const chunk = formatChunk(event, ctx);
    for (const client of sessionClients) {
      if (client.filteredEvents && !client.filteredEvents.has(event)) continue;
      try {
        client.res.write(chunk);
      } catch (err) {
        log.warn({ sid, err: err instanceof Error ? err.message : String(err) }, 'SSE write failed — removing client');
        this.removeClient(sid, client);
      }
    }
  }

  addClient(sessionId: string, client: SseClient): void {
    const set = this.clients.get(sessionId) ?? new Set();
    set.add(client);
    this.clients.set(sessionId, set);
    log.info({ sessionId, total: set.size }, 'SSE client connected');
  }

  removeClient(sessionId: string, client: SseClient): void {
    clearInterval(client.heartbeatTimer);
    const set = this.clients.get(sessionId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.clients.delete(sessionId);
    log.info({ sessionId, remaining: set.size }, 'SSE client disconnected');
  }

  connectionCount(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0;
  }

  getBuffer(sessionId: string): BufferedEvent[] {
    return this.ringBuffers.get(sessionId) ?? [];
  }

  clearBuffer(sessionId: string): void {
    this.ringBuffers.delete(sessionId);
    log.info({ sessionId }, 'Ring buffer cleared');
  }

  handleStream(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    if (!isAuthorised(req, this.tokenBuf)) {
      sendJson(res, 401, { error: { message: 'Unauthorized: invalid or missing bearer token', type: 'auth_error' } });
      return;
    }
    if (this.connectionCount(sessionId) >= MAX_CONNS_PER_SESSION) {
      log.warn({ sessionId }, 'SSE connection limit reached');
      sendJson(res, 429, { error: { message: `Max ${MAX_CONNS_PER_SESSION} concurrent SSE connections per session`, type: 'rate_limit_error' } });
      return;
    }

    const { search } = splitUrl(req.url ?? '');
    const filteredEvents = parseFilterParam(search);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const heartbeatTimer = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeatTimer); }
    }, HEARTBEAT_MS);

    const client: SseClient = { res, filteredEvents, heartbeatTimer };
    this.addClient(sessionId, client);
    req.on('close', () => { this.removeClient(sessionId, client); });
  }

  handleHistoricalEvents(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    if (!isAuthorised(req, this.tokenBuf)) {
      sendJson(res, 401, { error: { message: 'Unauthorized: invalid or missing bearer token', type: 'auth_error' } });
      return;
    }
    const { search } = splitUrl(req.url ?? '');
    const filteredEvents = parseFilterParam(search);
    const buffer = this.getBuffer(sessionId);
    const events = filteredEvents ? buffer.filter((e) => filteredEvents.has(e.event)) : buffer;
    sendJson(res, 200, { sessionId, count: events.length, events });
    log.info({ sessionId, count: events.length }, 'Historical events served');
  }

  destroy(): void {
    for (const id of this.hookIds) this.hookManager.unregister(id);
    for (const [sessionId, set] of this.clients) {
      for (const client of set) {
        clearInterval(client.heartbeatTimer);
        try { client.res.end(); } catch { /* already ended */ }
      }
      this.clients.delete(sessionId);
    }
    log.info('SSE broker destroyed');
  }
}

// Route registration

/**
 * Attach SSE routes to an existing http.Server.
 * Also registers a `session:end` hook to auto-clear ring buffers.
 *
 * @returns The SseStreamBroker instance (for teardown / testing).
 */
export function registerSseRoutes(server: HttpServer, hookManager: HookManager): SseStreamBroker {
  const broker = new SseStreamBroker(hookManager);

  hookManager.register(
    'session:end',
    async (ctx: HookContext) => { if (ctx.sessionId) broker.clearBuffer(ctx.sessionId); },
    'sse-broker:session-end-cleanup',
  );

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? '') !== 'GET') return;
    const { pathname } = splitUrl(req.url ?? '');

    const streamMatch = STREAM_RE.exec(pathname);
    if (streamMatch) {
      const sessionId = decodeURIComponent(streamMatch[1] ?? '');
      if (!sessionId) { sendJson(res, 400, { error: { message: 'Missing session ID', type: 'validation_error' } }); return; }
      broker.handleStream(req, res, sessionId);
      return;
    }

    const eventsMatch = EVENTS_RE.exec(pathname);
    if (eventsMatch) {
      const sessionId = decodeURIComponent(eventsMatch[1] ?? '');
      if (!sessionId) { sendJson(res, 400, { error: { message: 'Missing session ID', type: 'validation_error' } }); return; }
      broker.handleHistoricalEvents(req, res, sessionId);
      return;
    }
    // Non-matching routes fall through to other listeners
  });

  log.info('SSE routes registered (/v1/sessions/:id/stream, /v1/sessions/:id/events)');
  return broker;
}
