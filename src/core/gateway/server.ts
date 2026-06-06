/**
 * gateway/server.ts
 *
 * Local HTTP gateway — SUDO-AI API server (127.0.0.1:18900).
 *
 * Routes /v1/chat/completions to the Brain's direct provider connections
 * (registered via server.on('request') in cli.ts). Serves local admin,
 * session, agent, federation, and static routes. No upstream proxying.
 *
 * Features:
 *   - Priority Queues: X-Priority header → user / normal / background lanes.
 *   - Response Cache (cache.ts): 60 s TTL, max 200 entries.
 *   - Progress Broadcaster (progress.ts): start/thinking/streaming/complete/error.
 *   - Enhanced /health with live stats.
 *
 * Environment:
 *   GATEWAY_PORT  Listen port         (default: 18900)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { progress } from './progress.js';
import { getCacheKey, cacheGet, cacheSet } from './cache.js';
import { scoreComplexity } from '../agent/complexity-scorer.js';

const log = createLogger('gateway');

const GATEWAY_PORT: number = parseInt(process.env['GATEWAY_PORT'] ?? '18900', 10);
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
  // Fall through to those listeners.
  const pathname = url.split('?')[0] ?? '/';
  if (
    pathname.startsWith('/v1/admin') ||
    pathname.startsWith('/v1/sessions') ||
    pathname.startsWith('/v1/agents') ||
    pathname.startsWith('/v1/files') ||
    pathname.startsWith('/v1/skills') ||
    pathname.startsWith('/v1/vaults') ||
    pathname.startsWith('/v1/registry') ||
    pathname.startsWith('/v1/federation/') ||   // Federation routes (registered via server.on('request'))
    pathname.startsWith('/.well-known') ||   // Wave 10 P1: agentskills.io discovery (public no-auth)
    pathname === '/v1/models' ||
    pathname === '/v1/chat/completions' ||    // Handled by http-api.ts via Brain's direct provider connections
    (pathname === '/chat' || pathname.startsWith('/chat/')) ||   // WebAdapter: GET /chat (HTML) and WS upgrade /chat/ws
    pathname.startsWith('/assets/') ||    // Vite built assets in dist/renderer/assets/
    pathname === '/api/message'        // WebAdapter: POST /api/message (REST inject)
  ) {
    return;
  }

  // No matching local route — return 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found', type: 'gateway_error' } }));
  return;
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
      log.info({ port: GATEWAY_PORT }, 'SUDO-AI gateway started');
      resolve(GATEWAY_PORT);
    });
  });
}

/** Return the gateway base URL (http://127.0.0.1:<GATEWAY_PORT>). */
export function getGatewayUrl(): string { return `http://127.0.0.1:${GATEWAY_PORT}`; }

// Re-export progress so callers can import it from one place
export { progress } from './progress.js';
