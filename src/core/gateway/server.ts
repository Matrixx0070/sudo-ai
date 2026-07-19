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
import { isHostGateEnabled, isHostAllowed } from './host-gate.js';
import { getPromptCacheStats } from '../shared/prompt-cache-telemetry.js';
import { progress } from './progress.js';
import { cacheStats } from './cache.js';
import { scoreComplexity } from '../agent/complexity-scorer.js';

const log = createLogger('gateway');

const GATEWAY_PORT: number = parseInt(process.env['GATEWAY_PORT'] ?? '18900', 10);
const MAX_CONCURRENT = 6;

// Opt-in admin REST API (/api/admin/*), mounted by api/admin/register.ts behind
// a fail-closed Bearer gate. When off (default), the OR term below is dead and
// /api/admin still falls through to the 404 — byte-identical to prior behavior.
const ADMIN_API_ON: boolean = process.env['SUDO_ADMIN_API'] === '1';

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * The underlying http.Server created by startGateway().
 * Null until startGateway() has been called.
 * Exported so ws-server.ts (and tests) can attach WebSocket upgrades to it.
 */
export let gatewayServer: import('node:http').Server | null = null;

/**
 * Route owners that registered a sibling `server.on('request')` listener.
 * handleRequest's fall-through allowlist consults this before leaving a
 * request unanswered: if the owner never attached (e.g. web chat disabled or
 * its boot failed), falling through would leave the socket open forever —
 * curl reports 000, the message is silently dropped, and nothing persists.
 */
const attachedRouteOwners = new Set<string>();

/** Called by a sibling route listener (e.g. WebAdapter.attach) once attached. */
export function markGatewayRouteOwnerAttached(owner: string): void {
  attachedRouteOwners.add(owner);
}

/** Called on detach (e.g. WebAdapter.stop) so the guard fails fast again. */
export function markGatewayRouteOwnerDetached(owner: string): void {
  attachedRouteOwners.delete(owner);
}

/** True once the named route owner has attached its request listener. */
export function isGatewayRouteOwnerAttached(owner: string): boolean {
  return attachedRouteOwners.has(owner);
}

const startTime = Date.now();
const stats = {
  totalRequests: 0,
  raceWins: {} as Record<string, number>,
  latencySamples: [] as number[],
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

  // SSRF / DNS-rebind defense: reject requests whose Host header doesn't
  // resolve to a hostname in the allowlist. Default ON; SUDO_SSRF_HOST_GATE=0
  // disables. Socket is destroyed after the 403 so any sibling listeners
  // registered via server.on('request', ...) fail fast instead of trying to
  // serve the attack request.
  if (isHostGateEnabled() && !isHostAllowed(req.headers.host)) {
    log.warn(
      { requestId, host: req.headers.host, url, remote: req.socket.remoteAddress },
      'Rejecting request with disallowed Host header (SSRF/DNS-rebind defense)',
    );
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Forbidden', type: 'gateway_error' } }));
    req.socket.destroy();
    return;
  }

  // Health endpoint
  if (url === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      stats: { ...stats, ...cacheStats(), ...getPromptCacheStats(), avgLatencyMs: avgLatency(), queueDepths: queueDepths() },
    }));
    return;
  }

  // /v1/admin/* and /v1/sessions, /v1/agents, /v1/files, /v1/skills, /v1/vaults,
  // /v1/registry (public skill registry) are handled by local route listeners
  // (registered via server.on('request')).
  // Fall through to those listeners.
  const pathname = url.split('?')[0] ?? '/';

  // WebAdapter routes: GET /chat (+SPA assets) and POST /api/message are served
  // by a sibling 'request' listener that only exists when the web channel is
  // attached (WEB_CHAT_ENABLED=true in config/.env). Without this guard, a
  // request to these paths on a daemon whose web adapter never attached fell
  // through to... nothing: no listener ever wrote a response, the socket hung
  // until client timeout (curl: 000), and the message was silently dropped
  // (no session, no persisted user message). Answer with an actionable 503
  // instead so a fresh `sudo-ai quickstart` install fails loudly, not silently.
  if (
    pathname === '/chat' || pathname.startsWith('/chat/') ||
    pathname === '/api/message' || pathname.startsWith('/assets/') ||
    pathname === '/api/directory' || pathname.startsWith('/api/directory/')
  ) {
    if (isGatewayRouteOwnerAttached('web')) return; // WebAdapter listener responds
    log.warn({ requestId, url }, 'Web route requested but web adapter is not attached (WEB_CHAT_ENABLED != true)');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'Web chat is not enabled on this daemon. Set WEB_CHAT_ENABLED=true (and WEB_CHAT_TOKEN) in config/.env, then restart with `sudo-ai restart`.',
        type: 'gateway_error',
      },
    }));
    return;
  }

  if (
    pathname.startsWith('/v1/admin') ||
    pathname.startsWith('/v1/sessions') ||
    pathname.startsWith('/v1/agents') ||
    pathname.startsWith('/v1/files') ||
    pathname.startsWith('/v1/skills') ||
    pathname.startsWith('/v1/vaults') ||
    pathname.startsWith('/v1/registry') ||
    pathname.startsWith('/v1/canvas') ||   // A2UI canvas event route (registered via server.on('request'))
    pathname.startsWith('/v1/hooks') ||    // Inbound webhooks (Spec 4, per-hook secret; registered via server.on('request'))
    (ADMIN_API_ON && pathname.startsWith('/api/admin')) ||   // opt-in admin REST API (SUDO_ADMIN_API=1), token-gated by api/admin/register.ts
    pathname.startsWith('/v1/federation/') ||   // Federation routes (registered via server.on('request'))
    pathname.startsWith('/.well-known') ||   // agentskills.io discovery (public no-auth)
    pathname.startsWith('/__dashboard__') ||   // Dashboard folded onto 18900 (Slice D/3, SUDO_GATEWAY_UI_ON_MAIN)
    pathname === '/v1/models' ||
    pathname === '/v1/chat/completions'    // Handled by http-api.ts via Brain's direct provider connections
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
    // Every sibling route-owner (web, admin register, webhook, federation, …)
    // attaches its own 'request' listener; 26 attached in prod tripped Node's
    // default 25-listener leak warning. Real fan-out, not a leak — raise the cap.
    server.setMaxListeners(40);
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
