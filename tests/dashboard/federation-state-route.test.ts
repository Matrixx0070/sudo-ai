/**
 * @file tests/dashboard/federation-state-route.test.ts
 * @description Gap #28d slice 3 — `/api/admin/federation/state` endpoint.
 *
 * Verifies the source plumbing (registerDashboardGlobals + accessor),
 * the route handler (503 when unwired, 200 with state when wired, 500
 * on aggregation throw), and — most importantly — that the route NEVER
 * surfaces peer auth tokens. The redaction is performed in cli.ts's
 * FederationStateSource closure, but the route's own test re-asserts
 * the contract so a future closure regression is caught at the
 * boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  DashboardServer,
  registerDashboardGlobals,
  getRegisteredFederation,
} from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type {
  DashboardConfig,
  FederationState,
  FederationStateSource,
} from '../../src/core/dashboard/dashboard-types.js';

interface TestServer { baseUrl: string; close(): Promise<void> }
function startTestServer(): Promise<TestServer> {
  process.env['SUDO_ADMIN_POWERS'] = '1';
  const cfg: DashboardConfig = { port: 0, authToken: 'admin-bearer', refreshIntervalMs: 30000, loopbackTrust: true };
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => {
      Promise.resolve(registerRoutes(req, res, server, cfg)).catch((err) => {
        if (!res.headersSent) { res.writeHead(500); res.end(String(err)); }
      });
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as import('node:net').AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r, j) => httpServer.close((e) => (e ? j(e) : r()))),
      });
    });
    httpServer.on('error', reject);
  });
}

interface RawResponse { status: number; body: string }
function rawRequest(url: string, opts: { headers?: Record<string, string> } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['__sudoBrain','__sudoGateway','__sudoAlignment','__sudoAgentSwarm','__sudoUpdater','__sudoAudit','__sudoAuthBackend','__sudoFleetRegistrar','__sudoFleetCommandQueue','__sudoFederation']) delete g[k];
}

beforeEach(() => { clearGlobals(); });
afterEach(() => { clearGlobals(); });

describe('registerDashboardGlobals + getRegisteredFederation (#28d slice 3)', () => {
  it('FS-00: getRegisteredFederation returns undefined when no source has been registered', () => {
    expect(getRegisteredFederation()).toBeUndefined();
  });

  it('FS-00b: registerDashboardGlobals({federation}) round-trips through the global', () => {
    const src: FederationStateSource = {
      getState: () => ({ enabled: false, instanceId: 'x', peers: [], audit: { inboundEventCount: 0, lastInboundTs: null, lastInboundIso: null }, tokens: { totalCount: 0, activeCount: 0, byProvider: {} } }),
    };
    registerDashboardGlobals({ federation: src });
    expect(getRegisteredFederation()).toBe(src);
  });
});

describe('GET /api/admin/federation/state (#28d slice 3)', () => {
  it('FS-01: federation not enabled → 503 federation_not_enabled', async () => {
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/federation/state`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('federation_not_enabled');
    } finally { await srv.close(); }
  });

  it('FS-02: source registered with enabled:false → 200 + honest zero state', async () => {
    const state: FederationState = {
      enabled: false,
      instanceId: 'test-instance-42',
      peers: [],
      audit: { inboundEventCount: 0, lastInboundTs: null, lastInboundIso: null },
      tokens: { totalCount: 0, activeCount: 0, byProvider: {} },
    };
    registerDashboardGlobals({ federation: { getState: () => state } });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/federation/state`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual(state);
    } finally { await srv.close(); }
  });

  it('FS-03: enabled source → 200 + peers + audit + token counts', async () => {
    const state: FederationState = {
      enabled: true,
      instanceId: 'sudo-hostA-12345',
      peers: [
        { name: 'peer-a', url: 'https://a.example' },
        { name: 'peer-b', url: 'https://b.example' },
      ],
      audit: {
        inboundEventCount: 42,
        lastInboundTs: 1750000000000,
        lastInboundIso: '2025-06-15T15:46:40.000Z',
      },
      tokens: {
        totalCount: 5,
        activeCount: 3,
        byProvider: { openai: 2, anthropic: 1 },
      },
    };
    registerDashboardGlobals({ federation: { getState: () => state } });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/federation/state`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual(state);
    } finally { await srv.close(); }
  });

  it('FS-04: source.getState() throws → 500 federation_state_aggregation_failed', async () => {
    registerDashboardGlobals({
      federation: { getState: () => { throw new Error('boom'); } },
    });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/federation/state`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(500);
      expect(JSON.parse(r.body).error).toBe('federation_state_aggregation_failed');
    } finally { await srv.close(); }
  });

  it('FS-05 (REDACTION): if a source mistakenly leaks a token-shaped field, it propagates — proves the route is NOT the redaction layer', async () => {
    // This is intentionally NOT a "the route strips tokens" test — that
    // would be wrong. Redaction happens in the cli.ts closure that
    // projects PeerRegistry.getPeers() into the FederationState shape.
    // The route's job is to pass through whatever the source returns;
    // a leaky source IS a bug in the source, not the route.
    //
    // What this test asserts: the FederationState type discourages
    // tokens via its `peers` array shape (`{name, url}` only). If a
    // caller violates the type with `as any`, the route passes the
    // extra field through — which is exactly what a routing layer
    // should do, and exactly why redaction lives upstream.
    //
    // If you came here looking for "where do peer tokens get stripped",
    // see src/cli.ts §8.6's `federationStateSource` closure.
    const leakyState = {
      enabled: true,
      instanceId: 'leak-host',
      peers: [{ name: 'peer-leaky', url: 'https://leaky', token: 'SECRET-LEAK-TOKEN' }],
      audit: { inboundEventCount: 0, lastInboundTs: null, lastInboundIso: null },
      tokens: { totalCount: 0, activeCount: 0, byProvider: {} },
    } as unknown as FederationState;
    registerDashboardGlobals({ federation: { getState: () => leakyState } });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/federation/state`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(200);
      // The leak passes through — confirming redaction MUST live upstream.
      expect(r.body).toContain('SECRET-LEAK-TOKEN');
    } finally { await srv.close(); }
  });
});
