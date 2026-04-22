/**
 * @file tests/gateway/admin-reanchor-route.test.ts
 * @description Wave 6P: GET /v1/admin/reanchor/stats and GET /v1/admin/reanchor/recent endpoint tests.
 *
 * Tests (stats):
 *   REANCHOR-ROUTE-1  200 with real data from getStats
 *   REANCHOR-ROUTE-2  503 when reanchorMonitor absent
 *   REANCHOR-ROUTE-3  401 when bearer token missing
 *   REANCHOR-ROUTE-4  400 when window out of range [1,365]
 *   REANCHOR-ROUTE-5  Default window=30 used when not specified
 *   REANCHOR-ROUTE-6  500 when getStats throws
 *
 * Tests (recent):
 *   REANCHOR-ROUTE-7  200 with events from getRecent
 *   REANCHOR-ROUTE-8  503 when reanchorMonitor absent
 *   REANCHOR-ROUTE-9  400 when limit out of range [1,500]
 *   REANCHOR-ROUTE-10 Default window=30 and limit=50 when not specified
 *   REANCHOR-ROUTE-11 400 when window out of range
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-reanchor-route-token';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

type ReanchorMonitorMock = NonNullable<AdminRoutesDeps['reanchorMonitor']>;

interface ReAnchorEvent {
  id: string;
  ts: number;
  trigger: string;
  snippet: string;
}

function buildBaseDeps(reanchorMonitor?: ReanchorMonitorMock): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    reanchorMonitor,
  };
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

function startServer(deps: AdminRoutesDeps, tokenBuf: Buffer | null): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    registerAdminRoutes(server, deps, tokenBuf);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const close = (): Promise<void> =>
        new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
      resolve({ baseUrl, close });
    });
    server.on('error', reject);
  });
}

async function doGet(url: string, token?: string | null): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (token != null) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { method: 'GET', headers });
  const body = await resp.text();
  return { status: resp.status, json: JSON.parse(body) };
}

function makeMonitor(
  stats?: {
    total: number;
    byTrigger: Record<string, number>;
    windowDays: number;
    computedAt: string;
    lastReAnchorAt?: number;
  },
  recentEvents?: ReAnchorEvent[],
): ReanchorMonitorMock {
  return {
    getStats: () => stats ?? {
      total: 5,
      byTrigger: { explicit: 2, 'post-veto': 3 },
      windowDays: 30,
      computedAt: new Date().toISOString(),
      lastReAnchorAt: Date.now() - 1000,
    },
    getRecent: () => recentEvents ?? [
      { id: 'abc1', ts: Date.now() - 500, trigger: 'explicit', snippet: 're-anchor on login' },
      { id: 'abc2', ts: Date.now() - 2000, trigger: 'post-veto', snippet: 'identity-anchor after veto' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests: GET /v1/admin/reanchor/stats
// ---------------------------------------------------------------------------

describe('GET /v1/admin/reanchor/stats', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-1: 200 with real data
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-1: returns 200 with stats data when monitor is present', async () => {
    const lastTs = Date.now() - 3000;
    const monitor = makeMonitor({
      total: 7,
      byTrigger: { explicit: 4, 'post-veto': 3 },
      windowDays: 30,
      computedAt: new Date().toISOString(),
      lastReAnchorAt: lastTs,
    });
    ts = await startServer(buildBaseDeps(monitor), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/stats`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { total: number; byTrigger: Record<string, number>; windowDays: number; computedAt: string; lastReAnchorAt?: number } };
    expect(body.ok).toBe(true);
    expect(body.data.total).toBe(7);
    expect(body.data.byTrigger).toEqual({ explicit: 4, 'post-veto': 3 });
    expect(body.data.windowDays).toBe(30);
    expect(typeof body.data.computedAt).toBe('string');
    expect(body.data.lastReAnchorAt).toBe(lastTs);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-2: 503 when monitor absent
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-2: returns 503 when reanchorMonitor is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no monitor */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/stats`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-3: 401 when bearer token missing
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-3: returns 401 when bearer token is absent', async () => {
    ts = await startServer(buildBaseDeps(makeMonitor()), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/stats`, /* no token */ null);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-4: 400 when window out of range
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-4: returns 400 when window param is out of range', async () => {
    ts = await startServer(buildBaseDeps(makeMonitor()), makeTokenBuf(VALID_TOKEN));

    // Above max 365
    const { status: s1, json: j1 } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/stats?window=400`, VALID_TOKEN);
    expect(s1).toBe(400);
    expect((j1 as { error: string }).error).toContain('window must be between');

    // Below min 1
    const { status: s2 } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/stats?window=0`, VALID_TOKEN);
    expect(s2).toBe(400);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-5: Default window=30 when not specified
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-5: uses default window=30 and passes it to getStats', async () => {
    let capturedOpts: { windowDays?: number } | undefined;
    const monitor: ReanchorMonitorMock = {
      getStats: (opts) => {
        capturedOpts = opts;
        return { total: 0, byTrigger: {}, windowDays: 30, computedAt: new Date().toISOString() };
      },
      getRecent: () => [],
    };
    ts = await startServer(buildBaseDeps(monitor), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/stats`, VALID_TOKEN);

    expect(status).toBe(200);
    expect(capturedOpts?.windowDays).toBe(30);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-6: 500 when getStats throws
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-6: returns 500 when getStats throws', async () => {
    const throwingMonitor: ReanchorMonitorMock = {
      getStats: () => { throw new Error('DB exploded in reanchor monitor'); },
      getRecent: () => [],
    };
    ts = await startServer(buildBaseDeps(throwingMonitor), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/stats`, VALID_TOKEN);
    expect(status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /v1/admin/reanchor/recent
// ---------------------------------------------------------------------------

describe('GET /v1/admin/reanchor/recent', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-7: 200 with events
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-7: returns 200 with events array and metadata', async () => {
    const events: ReAnchorEvent[] = [
      { id: 'id1', ts: Date.now() - 100, trigger: 'explicit', snippet: 'explicit re-anchor on login' },
      { id: 'id2', ts: Date.now() - 500, trigger: 'post-veto', snippet: 'identity-anchor after veto' },
    ];
    ts = await startServer(buildBaseDeps(makeMonitor(undefined, events)), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/recent`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { events: ReAnchorEvent[]; count: number; windowDays: number; computedAt: string } };
    expect(body.ok).toBe(true);
    expect(body.data.count).toBe(2);
    expect(body.data.events).toHaveLength(2);
    expect(body.data.events[0]?.id).toBe('id1');
    expect(body.data.events[0]?.trigger).toBe('explicit');
    expect(body.data.windowDays).toBe(30);
    expect(typeof body.data.computedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-8: 503 when monitor absent
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-8: returns 503 when reanchorMonitor is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no monitor */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/recent`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-9: 400 when limit out of range
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-9: returns 400 when limit param is out of range', async () => {
    ts = await startServer(buildBaseDeps(makeMonitor()), makeTokenBuf(VALID_TOKEN));

    // Above max 500
    const { status: s1, json: j1 } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/recent?limit=600`, VALID_TOKEN);
    expect(s1).toBe(400);
    expect((j1 as { error: string }).error).toContain('limit must be between');

    // Below min 1
    const { status: s2 } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/recent?limit=0`, VALID_TOKEN);
    expect(s2).toBe(400);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-10: Default window=30 limit=50
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-10: uses default window=30 and limit=50 when not specified', async () => {
    let capturedOpts: { windowDays?: number; limit?: number } | undefined;
    const monitor: ReanchorMonitorMock = {
      getStats: () => ({ total: 0, byTrigger: {}, windowDays: 30, computedAt: new Date().toISOString() }),
      getRecent: (opts) => {
        capturedOpts = opts;
        return [];
      },
    };
    ts = await startServer(buildBaseDeps(monitor), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/recent`, VALID_TOKEN);

    expect(status).toBe(200);
    expect(capturedOpts?.windowDays).toBe(30);
    expect(capturedOpts?.limit).toBe(50);
  });

  // -------------------------------------------------------------------------
  // REANCHOR-ROUTE-11: 400 when window out of range
  // -------------------------------------------------------------------------
  it('REANCHOR-ROUTE-11: returns 400 when window param is out of range for /recent', async () => {
    ts = await startServer(buildBaseDeps(makeMonitor()), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/reanchor/recent?window=500`, VALID_TOKEN);
    expect(status).toBe(400);
    expect((json as { error: string }).error).toContain('window must be between');
  });
});
