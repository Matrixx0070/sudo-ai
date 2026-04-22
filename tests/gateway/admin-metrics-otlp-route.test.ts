/**
 * @file tests/gateway/admin-metrics-otlp-route.test.ts
 * @description Wave 7F: GET /v1/admin/metrics/otlp (OTLP JSON format) endpoint tests.
 *
 * Tests:
 *   OTLP-ROUTE-1  200 application/json with resourceMetrics key
 *   OTLP-ROUTE-2  401 when bearer token missing
 *   OTLP-ROUTE-3  401 when bearer token wrong
 *   OTLP-ROUTE-4  response has scopeMetrics with correct scope name
 *   OTLP-ROUTE-5  alignment score appears in dataPoints
 *   OTLP-ROUTE-6  resource has service.name attribute = sudo-ai-v5
 *   OTLP-ROUTE-7  no-deps snapshot returns empty metrics array (not 500)
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-otlp-route-token-7f';

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

interface JsonResponse {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

function doGetJson(url: string, token?: string | null): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

function makeMinimalDeps(): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
  };
}

function makeFullDeps(): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    alignmentAggregator: {
      getLastReport: () => ({
        score: 0.823,
        level: 'GREEN' as const,
        diagnosis: 'ok',
        failedOpen: false,
        evaluatedAt: new Date().toISOString(),
        signals: {
          outcomeDelta: 0.5,
          commitmentDrift: 0.1,
          trustTier: 0.9,
          injectionRate: 0.0,
          recoveryPending: 0,
          reAnchor: 0,
          discordanceScore: 0.1,
        },
        contributingSignals: [],
      }),
    },
    trustTierTracker: {
      getAuditSnapshot: () => ({
        tier: 'HIGH',
        score: 0.91,
        windowSizeDays: 30,
        lastAdjustedAt: new Date().toISOString(),
      }),
      getOutcomeBreakdown: () => ([]),
    },
    reanchorMonitor: {
      getStats: () => ({
        total: 2,
        byTrigger: { startup: 1, 'post-veto': 1 },
        windowDays: 7,
        computedAt: new Date().toISOString(),
        lastReAnchorAt: 1744502400000,
      }),
      getRecent: () => [],
    },
  };
}

const servers: TestServer[] = [];

async function getServer(deps: AdminRoutesDeps, tokenBuf: Buffer | null): Promise<TestServer> {
  const s = await startServer(deps, tokenBuf);
  servers.push(s);
  return s;
}

afterEach(async () => {
  for (const s of servers) {
    try { await s.close(); } catch { /* ignore */ }
  }
  servers.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/metrics/otlp', () => {
  it('OTLP-ROUTE-1 200 application/json with resourceMetrics key', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetJson(`${server.baseUrl}/v1/admin/metrics/otlp`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.body as Record<string, unknown>;
    expect(body).toHaveProperty('resourceMetrics');
    expect(Array.isArray(body['resourceMetrics'])).toBe(true);
  });

  it('OTLP-ROUTE-2 401 when bearer token missing', async () => {
    const server = await getServer(makeMinimalDeps(), Buffer.from(VALID_TOKEN, 'utf8'));
    const res = await doGetJson(`${server.baseUrl}/v1/admin/metrics/otlp`);
    expect(res.status).toBe(401);
  });

  it('OTLP-ROUTE-3 401 when bearer token wrong', async () => {
    const server = await getServer(makeMinimalDeps(), Buffer.from(VALID_TOKEN, 'utf8'));
    const res = await doGetJson(`${server.baseUrl}/v1/admin/metrics/otlp`, 'bad-token');
    expect(res.status).toBe(401);
  });

  it('OTLP-ROUTE-4 scopeMetrics has correct scope name', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetJson(`${server.baseUrl}/v1/admin/metrics/otlp`);
    expect(res.status).toBe(200);
    const body = res.body as { resourceMetrics: Array<{ scopeMetrics: Array<{ scope: { name: string; version: string } }> }> };
    const scope = body.resourceMetrics[0]?.scopeMetrics[0]?.scope;
    expect(scope?.name).toBe('sudo-ai-alignment');
    expect(scope?.version).toBe('7F');
  });

  it('OTLP-ROUTE-5 alignment score appears in dataPoints', async () => {
    const server = await getServer(makeFullDeps(), null);
    const res = await doGetJson(`${server.baseUrl}/v1/admin/metrics/otlp`);
    expect(res.status).toBe(200);
    const body = res.body as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string; gauge?: { dataPoints: Array<{ asDouble: number }> } }> }> }> };
    const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
    const scoreMetric = metrics.find(m => m.name === 'sudo.alignment.score');
    expect(scoreMetric).toBeDefined();
    expect(scoreMetric!.gauge!.dataPoints[0]!.asDouble).toBeCloseTo(0.823);
  });

  it('OTLP-ROUTE-6 resource has service.name = sudo-ai-v5', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetJson(`${server.baseUrl}/v1/admin/metrics/otlp`);
    expect(res.status).toBe(200);
    const body = res.body as { resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }> };
    const attrs = body.resourceMetrics[0]?.resource?.attributes ?? [];
    const serviceNameAttr = attrs.find(a => a.key === 'service.name');
    expect(serviceNameAttr?.value?.stringValue).toBe('sudo-ai-v5');
  });

  it('OTLP-ROUTE-7 no-deps snapshot returns empty metrics array (not 500)', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetJson(`${server.baseUrl}/v1/admin/metrics/otlp`);
    expect(res.status).toBe(200);
    const body = res.body as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: unknown[] }> }> };
    const metrics = body.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
    expect(Array.isArray(metrics)).toBe(true);
    expect(metrics.length).toBe(0);
  });
});
