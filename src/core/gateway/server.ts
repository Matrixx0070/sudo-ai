/**
 * gateway/server.ts
 *
 * Local HTTP gateway — SUDO-AI brain ↔ SUDOAPI upstream (127.0.0.1:18800).
 *
 * Features:
 *   - Race Engine (race.ts): 2-3 simultaneous model requests, first wins.
 *   - Priority Queues: X-Priority header → user / normal / background lanes.
 *   - Response Cache (cache.ts): 60 s TTL, max 200 entries.
 *   - Progress Broadcaster (progress.ts): start/thinking/streaming/complete/error.
 *   - Enhanced /health with live stats.
 *
 * Environment:
 *   SUDOAPI_URL   Upstream base URL  (default: https://sudoapi.shop)
 *   SUDOAPI_KEY   Bearer token        (default: sk-sudo-master)
 *   GATEWAY_PORT  Listen port         (default: 18800)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { progress } from './progress.js';
import { raceProviders } from './race.js';
import { getCacheKey, cacheGet, cacheSet } from './cache.js';
import { scoreComplexity } from '../agent/complexity-scorer.js';

const log = createLogger('gateway');

const SUDOAPI_UPSTREAM: string = process.env['SUDOAPI_URL'] ?? 'https://sudoapi.shop';
const SUDOAPI_KEY: string = process.env['SUDOAPI_KEY'] ?? '';
const GATEWAY_PORT: number = parseInt(process.env['GATEWAY_PORT'] ?? '18800', 10);

if (!SUDOAPI_KEY) {
  log.warn('SUDOAPI_KEY environment variable is not set — upstream requests will be unauthenticated');
}
const MAX_CONCURRENT = 6;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * The underlying http.Server created by startGateway().
 * Null until startGateway() has been called.
 * Exported so ws-server.ts (and tests) can attach WebSocket upgrades to it.
 */
export let gatewayServer: import('node:http').Server | null = null;

const startTime = Date.now();
const stats = {
  totalRequests: 0,
  raceWins: {} as Record<string, number>,
  latencySamples: [] as number[],
  cacheHits: 0,
  cacheMisses: 0,
  activeStreams: 0,
};

function recordLatency(ms: number): void {
  stats.latencySamples.push(ms);
  if (stats.latencySamples.length > 500) stats.latencySamples.shift();
}

function avgLatency(): number {
  if (stats.latencySamples.length === 0) return 0;
  return Math.round(stats.latencySamples.reduce((a, b) => a + b, 0) / stats.latencySamples.length);
}

// ---------------------------------------------------------------------------
// Priority Queue (3 lanes: user=1, normal=2, background=3)
// ---------------------------------------------------------------------------

const PRIORITY = { user: 1, normal: 2, background: 3 } as const;
type Priority = 1 | 2 | 3;

let activeRequests = 0;
const queues = new Map<Priority, Array<() => void>>([[1, []], [2, []], [3, []]]);

function processQueue(): void {
  if (activeRequests >= MAX_CONCURRENT) return;
  for (const lane of [1, 2, 3] as Priority[]) {
    const q = queues.get(lane)!;
    if (q.length > 0) { q.shift()!(); return; }
  }
}

function enqueue(p: Priority): Promise<void> {
  return new Promise<void>(resolve => { queues.get(p)!.push(resolve); processQueue(); });
}

function queueDepths(): Record<string, number> {
  return { user: queues.get(1)!.length, normal: queues.get(2)!.length, background: queues.get(3)!.length };
}

// ---------------------------------------------------------------------------
// Pass-through for non-completions endpoints
// ---------------------------------------------------------------------------

async function passThrough(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';

  // SSRF guard: only allow requests to paths starting with /v1/
  if (!/^\/v1\//.test(url)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Forbidden', type: 'gateway_error' } }));
    return;
  }

  try {
    const upstream = await fetch(`${SUDOAPI_UPSTREAM}${url}`, {
      method: req.method ?? 'GET',
      headers: { 'Authorization': `Bearer ${SUDOAPI_KEY}` },
    });
    const data = await upstream.text();
    if (!res.headersSent) res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, url }, 'Pass-through error');
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Gateway pass-through error', type: 'gateway_error' } }));
  }
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  log.info({ requestId, method, url, activeRequests }, 'Incoming request');

  // Health endpoint
  if (url === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      stats: { ...stats, avgLatencyMs: avgLatency(), queueDepths: queueDepths() },
    }));
    return;
  }

  // /v1/admin/* and /v1/sessions, /v1/agents, /v1/files, /v1/skills, /v1/vaults,
  // /v1/registry (public skill registry) are handled by local route listeners
  // (registered via server.on('request')).
  // Do not proxy these to SUDOAPI upstream — fall through to those listeners.
  const pathname = url.split('?')[0] ?? '/';
  if (
    pathname.startsWith('/v1/admin') ||
    pathname.startsWith('/v1/sessions') ||
    pathname.startsWith('/v1/agents') ||
    pathname.startsWith('/v1/files') ||
    pathname.startsWith('/v1/skills') ||
    pathname.startsWith('/v1/vaults') ||
    pathname.startsWith('/v1/registry') ||
    pathname.startsWith('/.well-known') ||   // Wave 10 P1: agentskills.io discovery (public no-auth)
    pathname === '/v1/models' ||
    (pathname === '/chat' || pathname.startsWith('/chat/')) ||   // WebAdapter: GET /chat (HTML) and WS upgrade /chat/ws
    pathname === '/api/message'        // WebAdapter: POST /api/message (REST inject)
  ) {
    return;
  }

  // Only POST /v1/chat/completions enters the race + cache pipeline
  if (method !== 'POST' || url !== '/v1/chat/completions') {
    await passThrough(req, res);
    return;
  }

  stats.totalRequests++;

  // Priority from X-Priority header
  const pKey = (typeof req.headers['x-priority'] === 'string' ? req.headers['x-priority'] : 'normal').toLowerCase();
  const priority: Priority =
    pKey === 'user' ? PRIORITY.user : pKey === 'background' ? PRIORITY.background : PRIORITY.normal;

  // Read body (max 1 MB)
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request body too large', type: 'gateway_error' } }));
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ requestId, err: msg }, 'Body read error');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to read request body', type: 'gateway_error' } }));
    return;
  }

  // Parse request — respect client's stream preference (don't force streaming)
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
    // Only set stream if client didn't specify — let client control this
    // The Vercel AI SDK sets stream=true when it wants streaming
    body = JSON.stringify(parsed);
  } catch {
    log.warn({ requestId }, 'Request body not valid JSON — forwarding raw');
  }

  // C2: Compute complexity from user messages and inject as response headers.
  // scoreComplexity is a pure synchronous heuristic (<2 ms). Headers are set
  // via res.setHeader() before writeHead so they survive both streaming and
  // non-streaming paths. For streaming SSE the body is piped directly and
  // cannot be rewritten — headers are the only safe injection point.
  try {
    const msgs = Array.isArray(parsed['messages']) ? (parsed['messages'] as unknown[]) : [];
    const userText = msgs
      .filter((m): m is { role: string; content: string } =>
        typeof m === 'object' && m !== null &&
        (m as Record<string, unknown>)['role'] === 'user' &&
        typeof (m as Record<string, unknown>)['content'] === 'string',
      )
      .map((m) => m.content)
      .join(' ');
    if (userText) {
      const modelName = typeof parsed['model'] === 'string' ? parsed['model'] : '';
      const cx = scoreComplexity({ prompt: userText, modelName });
      res.setHeader('X-Complexity-Score', String(cx.score));
      res.setHeader('X-Complexity-Tier', cx.tier);
      res.setHeader('X-Complexity-Suggested-Max-Tokens', String(cx.suggested_max_tokens));
    }
  } catch (cxErr) {
    // Non-fatal: complexity scoring failure must never block the request
    log.debug({ err: String(cxErr) }, 'Complexity scoring skipped');
  }

  // Session ID — caller sets X-Session-Id or we use the request ID
  const rawSession = req.headers['x-session-id'];
  const sessionId = (typeof rawSession === 'string' && rawSession.length > 0)
    ? rawSession.slice(0, 64) : requestId;

  progress.start(sessionId);

  // Cache check (skipped for user-priority — always real-time)
  const cacheKey = getCacheKey(body);
  if (priority !== PRIORITY.user) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      stats.cacheHits++;
      log.info({ requestId, cacheKey }, 'Cache hit — replaying');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Cache': 'HIT' });
      for (const line of cached.split('\n')) { res.write(line + '\n'); await new Promise<void>(r => setTimeout(r, 2)); }
      res.end();
      progress.complete(sessionId, 0);
      return;
    }
    stats.cacheMisses++;
  }

  // Priority queue gate
  if (activeRequests >= MAX_CONCURRENT) {
    log.info({ requestId, priority, queued: queueDepths() }, 'At capacity — queued');
    await enqueue(priority);
  }

  activeRequests++;
  stats.activeStreams++;
  const startMs = Date.now();

  // Intercept writes to accumulate SSE output for caching
  const chunks: string[] = [];
  const origWrite = res.write.bind(res) as typeof res.write;
  (res as ServerResponse).write = (data: Parameters<typeof origWrite>[0]) => {
    chunks.push(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString() : String(data));
    return origWrite(data);
  };

  try {
    const clientWantsStream = parsed['stream'] === true;
    const requestedModel = typeof parsed['model'] === 'string' ? parsed['model'] : 'sudo';

    if (clientWantsStream) {
      // Streaming: use race engine (multiple providers, fastest wins)
      const models = requestedModel === 'sudo' ? ['sudo', 'grok'] : [requestedModel, 'sudo'];
      await raceProviders(body, models, res, sessionId, {
        upstreamUrl: SUDOAPI_UPSTREAM,
        apiKey: SUDOAPI_KEY,
        onWin: (model) => { stats.raceWins[model] = (stats.raceWins[model] ?? 0) + 1; },
      });
    } else {
      // Non-streaming: simple forward to SUDOAPI (no racing needed)
      progress.thinking(sessionId);
      const upstream = await fetch(`${SUDOAPI_UPSTREAM}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUDOAPI_KEY}` },
        body,
      });
      let data = await upstream.text();

      // Merge fragmented tool_calls — SUDOAPI may return streaming-style chunks
      // even for non-streaming requests where arguments are split across entries
      try {
        const parsed2 = JSON.parse(data);
        const msg = parsed2?.choices?.[0]?.message;
        if (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 1) {
          const merged: Record<number, { id: string; type: string; function: { name: string; arguments: string } }> = {};
          for (const tc of msg.tool_calls) {
            const idx = tc.index ?? 0;
            if (!merged[idx]) {
              merged[idx] = {
                id: tc.id ?? `call_${idx}`,
                type: tc.type ?? 'function',
                function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
              };
            } else {
              // Merge: append arguments, update name if present
              if (tc.function?.name) merged[idx].function.name = tc.function.name;
              if (tc.function?.arguments) merged[idx].function.arguments += tc.function.arguments;
              if (tc.id) merged[idx].id = tc.id;
            }
          }
          msg.tool_calls = Object.values(merged);
          log.info({ mergedCount: msg.tool_calls.length, tools: msg.tool_calls.map((t: any) => t.function?.name) }, 'Merged fragmented tool_calls');
          data = JSON.stringify(parsed2);
        }
      } catch { /* not JSON or no tool_calls — forward as-is */ }

      if (!res.headersSent) res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(data);
      stats.raceWins[requestedModel] = (stats.raceWins[requestedModel] ?? 0) + 1;
    }

    if (chunks.length > 0 && priority !== PRIORITY.user) cacheSet(cacheKey, chunks.join(''));

    const durationMs = Date.now() - startMs;
    recordLatency(durationMs);
    progress.complete(sessionId, durationMs);
    log.info({ requestId, durationMs, priority }, 'Request completed');

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ requestId, err: msg }, 'Unhandled error in race');
    progress.error(sessionId, msg.slice(0, 200));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Internal gateway error', type: 'gateway_error' } }));
    }
  } finally {
    activeRequests--;
    stats.activeStreams--;
    processQueue();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Start the local gateway server. Returns the port once listening. */
export function startGateway(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, 'Unhandled exception in handleRequest');
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        try { res.end(JSON.stringify({ error: { message: 'Internal gateway error', type: 'gateway_error' } })); }
        catch { /* already ended */ }
      });
    });
    server.setMaxListeners(25);
    server.on('error', (err) => { log.error({ err: err.message, port: GATEWAY_PORT }, 'Gateway server error'); reject(err); });
    server.listen(GATEWAY_PORT, '127.0.0.1', () => {
      gatewayServer = server;
      log.info({ port: GATEWAY_PORT, upstream: SUDOAPI_UPSTREAM }, 'SUDO-AI gateway started');
      resolve(GATEWAY_PORT);
    });
  });
}

/** Return the gateway base URL (http://127.0.0.1:<GATEWAY_PORT>). */
export function getGatewayUrl(): string { return `http://127.0.0.1:${GATEWAY_PORT}`; }

// Re-export progress so callers can import it from one place
export { progress } from './progress.js';
