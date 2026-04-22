/**
 * @file tests/gateway/admin-injection-stats-route.test.ts
 * @description Wave 6O: GET /v1/admin/injection/stats endpoint tests.
 *
 * Tests:
 *   INJ-ROUTE-1  200 with real data when tracker present and getOutcomeBreakdown returns data
 *   INJ-ROUTE-2  200 with zero counts when no injection-detected in breakdown
 *   INJ-ROUTE-3  503 when trustTierTracker absent
 *   INJ-ROUTE-4  503 when getOutcomeBreakdown absent on tracker
 *   INJ-ROUTE-5  401 when bearer token missing
 *   INJ-ROUTE-6  400 when window out of range
 *   INJ-ROUTE-7  500 when getOutcomeBreakdown throws
 *   INJ-ROUTE-8  Default window=7 when ?window not provided
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-injection-stats-token';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

type TrustTrackerMock = NonNullable<AdminRoutesDeps['trustTierTracker']>;

function buildBaseDeps(trustTierTracker?: TrustTrackerMock): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    trustTierTracker,
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

function makeTracker(breakdown: { kind: string; count: number; score: number }[]): TrustTrackerMock {
  return {
    getAuditSnapshot: () => ({
      tier: 'MEDIUM',
      score: 0.5,
      windowSizeDays: 7,
      lastAdjustedAt: new Date().toISOString(),
    }),
    getOutcomeBreakdown: () => breakdown,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/injection/stats', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-1: 200 with real data
  // -------------------------------------------------------------------------
  it('returns 200 with detection data when tracker has injection-detected row', async () => {
    const tracker = makeTracker([
      { kind: 'injection-detected', count: 5, score: -12.5 },
      { kind: 'success', count: 3, score: 3.0 },
    ]);
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as {
      ok: boolean;
      data: {
        detections: { kind: string; count: number; score: number } | null;
        totalCount: number;
        totalScore: number;
        windowDays: number;
        computedAt: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.totalCount).toBe(5);
    expect(body.data.totalScore).toBeCloseTo(-12.5);
    expect(body.data.windowDays).toBe(7);
    expect(typeof body.data.computedAt).toBe('string');
    expect(body.data.detections).not.toBeNull();
    expect(body.data.detections!.kind).toBe('injection-detected');
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-2: 200 with zero counts when no injection-detected row
  // -------------------------------------------------------------------------
  it('returns 200 with totalCount=0 when no injection-detected in breakdown', async () => {
    const tracker = makeTracker([
      { kind: 'success', count: 10, score: 10.0 },
    ]);
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { totalCount: number; totalScore: number; detections: null } };
    expect(body.ok).toBe(true);
    expect(body.data.totalCount).toBe(0);
    expect(body.data.totalScore).toBe(0);
    expect(body.data.detections).toBeNull();
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-3: 503 when trustTierTracker absent
  // -------------------------------------------------------------------------
  it('returns 503 when trustTierTracker is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no tracker */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-4: 503 when getOutcomeBreakdown absent on tracker
  // -------------------------------------------------------------------------
  it('returns 503 when getOutcomeBreakdown not present on tracker', async () => {
    const trackerWithoutBreakdown: TrustTrackerMock = {
      getAuditSnapshot: () => ({
        tier: 'MEDIUM',
        score: 0.5,
        windowSizeDays: 7,
        lastAdjustedAt: new Date().toISOString(),
      }),
      // getOutcomeBreakdown intentionally omitted
    };
    ts = await startServer(buildBaseDeps(trackerWithoutBreakdown), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats`, VALID_TOKEN);

    expect(status).toBe(503);
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-5: 401 when bearer token missing
  // -------------------------------------------------------------------------
  it('returns 401 when bearer token is absent', async () => {
    const tracker = makeTracker([]);
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats`, /* no token */ null);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-6: 400 when window out of range
  // -------------------------------------------------------------------------
  it('returns 400 when window param is out of range', async () => {
    const tracker = makeTracker([]);
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats?window=200`, VALID_TOKEN);

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('window must be between');
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-7: 500 when getOutcomeBreakdown throws
  // -------------------------------------------------------------------------
  it('returns 500 when getOutcomeBreakdown throws', async () => {
    const throwingTracker: TrustTrackerMock = {
      getAuditSnapshot: () => ({
        tier: 'MEDIUM',
        score: 0.5,
        windowSizeDays: 7,
        lastAdjustedAt: new Date().toISOString(),
      }),
      getOutcomeBreakdown: () => { throw new Error('DB exploded'); },
    };
    ts = await startServer(buildBaseDeps(throwingTracker), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats`, VALID_TOKEN);
    expect(status).toBe(500);
  });

  // -------------------------------------------------------------------------
  // INJ-ROUTE-8: Default window=7 when ?window not provided
  // -------------------------------------------------------------------------
  it('uses default window of 7 when not specified', async () => {
    let capturedOpts: { windowDays?: number } | undefined;
    const tracker: TrustTrackerMock = {
      getAuditSnapshot: () => ({
        tier: 'MEDIUM',
        score: 0.5,
        windowSizeDays: 7,
        lastAdjustedAt: new Date().toISOString(),
      }),
      getOutcomeBreakdown: (opts) => {
        capturedOpts = opts;
        return [];
      },
    };
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/injection/stats`, VALID_TOKEN);

    expect(status).toBe(200);
    expect(capturedOpts?.windowDays).toBe(7);
  });
});
