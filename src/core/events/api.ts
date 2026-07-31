/**
 * @file api.ts
 * @description REST surface for the unified event system, attached to the
 * gateway http.Server as a sibling 'request' listener (same pattern as
 * webhook-routes.ts). Auth: gateway token / loopback via gateway/auth.ts —
 * BOTH path prefixes must be in server.ts's fall-through allowlist and
 * http-api.ts's generic-guard defer list.
 *
 *   GET    /v1/events                       list event log (?type=&limit=&since_ms=)
 *   GET    /v1/events/types                 event catalog
 *   GET    /v1/events/stats                 counters for the dashboard
 *   GET    /v1/events/dashboard             self-contained HTML dashboard
 *   GET    /v1/events/deliveries/:id        delivery detail + attempt log
 *   POST   /v1/events/deliveries/:id/replay re-arm a delivery (DLQ replay)
 *   GET    /v1/events/:id                   one event
 *   GET    /v1/webhook-endpoints            list (secrets masked)
 *   POST   /v1/webhook-endpoints            create (returns secret ONCE)
 *   GET    /v1/webhook-endpoints/:id        read (secret masked)
 *   PATCH  /v1/webhook-endpoints/:id        update name/url/description/events/retry/enabled
 *   DELETE /v1/webhook-endpoints/:id        delete endpoint + its deliveries
 *   POST   /v1/webhook-endpoints/:id/rotate-secret   new secret (returned once; old co-signs 24h)
 *   POST   /v1/webhook-endpoints/:id/test   enqueue + immediately deliver a test event
 *   GET    /v1/webhook-endpoints/:id/deliveries      delivery log (?status=&limit=)
 */

import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { authenticateToken } from '../gateway/auth.js';
import { isValidSubscriptionPattern, persistentEventTypes, EVENT_CATALOG } from './catalog.js';
import type { DeliveryWorker } from './worker.js';
import type { DeliveryStatus, EventStore, WebhookEndpointRow } from './store.js';
import { newEventId } from './types.js';
import { dashboardHtml } from './dashboard-html.js';

const log = createLogger('events:api');

const MAX_BODY = 256 * 1024;

export interface EventsApiDeps {
  store: EventStore;
  worker: DeliveryWorker;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function err(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, code: status } });
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []; let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/**
 * Bearer header ONLY — deliberately no ?token= fallback: the gateway logs the
 * URL of every incoming request, so a query-string credential would end up in
 * the logs.
 */
function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  const h = Array.isArray(auth) ? auth[0] : auth;
  const m = /^Bearer\s+(.+)$/i.exec((h ?? '').trim());
  return m?.[1] ?? null;
}

/** Public (masked) endpoint shape. `secret` only rides on create/rotate. */
function endpointJson(ep: WebhookEndpointRow, opts: { revealSecret?: boolean } = {}): Record<string, unknown> {
  return {
    id: ep.id,
    name: ep.name,
    description: ep.description,
    url: ep.url,
    enabled: ep.enabled === 1,
    event_types: ep.eventTypes,
    retry_max: ep.retryMax,
    secret: opts.revealSecret ? ep.secret : `whsec_…${ep.secret.slice(-4)}`,
    secret_rotation_grace_until: ep.secretPrevExpiresAt ? new Date(ep.secretPrevExpiresAt).toISOString() : null,
    created_at: ep.createdAt,
    updated_at: ep.updatedAt,
  };
}

interface EndpointInput {
  name?: unknown; url?: unknown; description?: unknown;
  event_types?: unknown; retry_max?: unknown; enabled?: unknown;
}

function validateEndpointInput(raw: EndpointInput, partial: boolean): { ok: true; value: {
  name?: string; url?: string; description?: string; eventTypes?: string[]; retryMax?: number; enabled?: boolean;
} } | { ok: false; message: string } {
  const out: { name?: string; url?: string; description?: string; eventTypes?: string[]; retryMax?: number; enabled?: boolean } = {};
  if (raw.name !== undefined || !partial) {
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120) return { ok: false, message: 'name: 1-120 chars required' };
    out.name = raw.name.trim();
  }
  if (raw.url !== undefined || !partial) {
    if (typeof raw.url !== 'string') return { ok: false, message: 'url required' };
    let u: URL;
    try { u = new URL(raw.url); } catch { return { ok: false, message: 'url: invalid URL' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, message: 'url: must be http(s)' };
    if (u.username || u.password) return { ok: false, message: 'url: credentials not allowed' };
    out.url = raw.url;
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 1000) return { ok: false, message: 'description: string ≤1000 chars' };
    out.description = raw.description;
  }
  if (raw.event_types !== undefined || !partial) {
    if (!Array.isArray(raw.event_types) || raw.event_types.length === 0) return { ok: false, message: 'event_types: non-empty array required (["*"] for all)' };
    const types = raw.event_types.filter((t): t is string => typeof t === 'string');
    if (types.length !== raw.event_types.length) return { ok: false, message: 'event_types: strings only' };
    const bad = types.find((t) => !isValidSubscriptionPattern(t));
    if (bad) return { ok: false, message: `event_types: unknown type/pattern "${bad}" (see GET /v1/events/types)` };
    out.eventTypes = types;
  }
  if (raw.retry_max !== undefined) {
    const n = Number(raw.retry_max);
    if (!Number.isInteger(n) || n < 0 || n > 10) return { ok: false, message: 'retry_max: integer 0-10' };
    out.retryMax = n;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, message: 'enabled: boolean' };
    out.enabled = raw.enabled;
  }
  return { ok: true, value: out };
}

const DELIVERY_STATUSES: ReadonlySet<string> = new Set(['pending', 'delivering', 'succeeded', 'dead']);

export function registerEventsApi(server: HttpServer, deps: EventsApiDeps): void {
  const { store, worker } = deps;

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/v1/webhook-endpoints') && !p.startsWith('/v1/events')) return;
    const method = req.method ?? 'GET';

    // Dashboard HTML is served without a token (loopback-bound server); every
    // data call it makes goes through the token gate below.
    if (p === '/v1/events/dashboard' && method === 'GET') {
      const html = dashboardHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    const principal = authenticateToken(bearerToken(req), req, {});
    if (!principal.ok) { err(res, 401, `unauthorized: ${principal.reason ?? 'bad token'}`); return; }

    handle(req, res, method, p, url).catch((e: unknown) => {
      log.error({ p, err: String(e) }, 'events api: unhandled');
      err(res, 500, 'internal error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse, method: string, p: string, url: URL): Promise<void> {
    // ----- /v1/events ------------------------------------------------------
    if (p === '/v1/events' && method === 'GET') {
      const events = store.listEvents({
        ...(url.searchParams.get('type') ? { type: url.searchParams.get('type')! } : {}),
        limit: Number(url.searchParams.get('limit') ?? '50'),
        ...(url.searchParams.get('since_ms') ? { sinceMs: Number(url.searchParams.get('since_ms')) } : {}),
      });
      sendJson(res, 200, { events });
      return;
    }
    if (p === '/v1/events/types' && method === 'GET') {
      sendJson(res, 200, { types: EVENT_CATALOG, webhook_eligible: persistentEventTypes() });
      return;
    }
    if (p === '/v1/events/stats' && method === 'GET') {
      sendJson(res, 200, store.stats());
      return;
    }
    const replayM = /^\/v1\/events\/deliveries\/([^/]+)\/replay$/.exec(p);
    if (replayM && method === 'POST') {
      const d = store.replay(decodeURIComponent(replayM[1]!));
      if (!d) { err(res, 404, 'delivery not found'); return; }
      void worker.tick();
      sendJson(res, 200, { ok: true, delivery: d });
      return;
    }
    const delM = /^\/v1\/events\/deliveries\/([^/]+)$/.exec(p);
    if (delM && method === 'GET') {
      const d = store.getDelivery(decodeURIComponent(delM[1]!));
      if (!d) { err(res, 404, 'delivery not found'); return; }
      sendJson(res, 200, { delivery: d, attempts: store.listAttempts(d.id), event: store.getEvent(d.eventId) });
      return;
    }
    const evtM = /^\/v1\/events\/([^/]+)$/.exec(p);
    if (evtM && method === 'GET') {
      const e = store.getEvent(decodeURIComponent(evtM[1]!));
      if (!e) { err(res, 404, 'event not found'); return; }
      sendJson(res, 200, { event: e });
      return;
    }

    // ----- /v1/webhook-endpoints ------------------------------------------
    if (p === '/v1/webhook-endpoints' && method === 'GET') {
      sendJson(res, 200, { endpoints: store.listEndpoints().map((e) => endpointJson(e)) });
      return;
    }
    if (p === '/v1/webhook-endpoints' && method === 'POST') {
      const body = await readBody(req);
      if (body === null) { err(res, 413, 'payload too large'); return; }
      let raw: EndpointInput;
      try { raw = JSON.parse(body || '{}') as EndpointInput; } catch { err(res, 400, 'invalid JSON'); return; }
      const v = validateEndpointInput(raw, false);
      if (!v.ok) { err(res, 400, v.message); return; }
      const ep = store.createEndpoint(v.value as { name: string; url: string; description?: string; eventTypes: string[]; retryMax?: number; enabled?: boolean });
      // Log the host only — webhook URLs commonly embed credentials in the path.
      log.info({ id: ep.id, urlHost: new URL(ep.url).host, eventTypes: ep.eventTypes }, 'webhook endpoint created');
      // The ONLY time the full secret is returned — store it now.
      sendJson(res, 201, { endpoint: endpointJson(ep, { revealSecret: true }) });
      return;
    }

    const epM = /^\/v1\/webhook-endpoints\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
    if (!epM) { err(res, 404, 'not found'); return; }
    const id = decodeURIComponent(epM[1]!);
    const sub = epM[2];
    const ep = store.getEndpoint(id);
    if (!ep) { err(res, 404, 'endpoint not found'); return; }

    if (!sub && method === 'GET') { sendJson(res, 200, { endpoint: endpointJson(ep) }); return; }
    if (!sub && method === 'PATCH') {
      const body = await readBody(req);
      if (body === null) { err(res, 413, 'payload too large'); return; }
      let raw: EndpointInput;
      try { raw = JSON.parse(body || '{}') as EndpointInput; } catch { err(res, 400, 'invalid JSON'); return; }
      const v = validateEndpointInput(raw, true);
      if (!v.ok) { err(res, 400, v.message); return; }
      const updated = store.updateEndpoint(id, v.value)!;
      log.info({ id }, 'webhook endpoint updated');
      sendJson(res, 200, { endpoint: endpointJson(updated) });
      return;
    }
    if (!sub && method === 'DELETE') {
      store.deleteEndpoint(id);
      log.info({ id }, 'webhook endpoint deleted');
      sendJson(res, 200, { ok: true });
      return;
    }
    if (sub === 'rotate-secret' && method === 'POST') {
      const rotated = store.rotateSecret(id)!;
      log.info({ id }, 'webhook endpoint secret rotated (24h grace for previous)');
      sendJson(res, 200, { endpoint: endpointJson(rotated, { revealSecret: true }) });
      return;
    }
    if (sub === 'test' && method === 'POST') {
      // A synthetic event enqueued for THIS endpoint only (no bus fan-out),
      // then delivered on an immediate worker tick.
      const evt = {
        id: newEventId(),
        type: 'notification',
        version: 1,
        createdAt: new Date().toISOString(),
        idempotencyKey: newEventId(), // unique per test-fire — never deduped
        channels: [],
        data: { kind: 'webhook_test', endpoint_id: id, message: 'Test delivery from Sudo AI' },
      };
      store.insertEvent(evt);
      const d = store.enqueueDirect(ep, evt);
      await worker.tick();
      const settled = d ? store.getDelivery(d.id) : null;
      sendJson(res, 200, { ok: true, event_id: evt.id, delivery: settled });
      return;
    }
    if (sub === 'deliveries' && method === 'GET') {
      const statusQ = url.searchParams.get('status');
      const status = statusQ && DELIVERY_STATUSES.has(statusQ) ? (statusQ as DeliveryStatus) : undefined;
      const deliveries = store.listDeliveries({ endpointId: id, ...(status ? { status } : {}), limit: Number(url.searchParams.get('limit') ?? '50') });
      sendJson(res, 200, { deliveries });
      return;
    }
    err(res, 404, 'not found');
  }

  log.info('Events API registered (/v1/events, /v1/webhook-endpoints)');
}
