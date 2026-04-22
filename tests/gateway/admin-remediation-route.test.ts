/**
 * @file tests/gateway/admin-remediation-route.test.ts
 * @description Wave 8E: GET /v1/admin/remediation/stats endpoint tests.
 *
 * Tests:
 *   REM-ROUTE-1  200 with full stats data when remediator present
 *   REM-ROUTE-2  503 when alignmentAutoRemediator absent
 *   REM-ROUTE-3  401 when bearer token missing
 *   REM-ROUTE-4  401 when bearer token wrong
 *   REM-ROUTE-5  200 with no token required when tokenBuf is null
 *   REM-ROUTE-6  500 when getStats throws
 *   REM-ROUTE-7  Response shape has ok + data wrapper
 *   REM-ROUTE-8  lastRemediationAt is absent (undefined) when no remediation has fired
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-remediation-route-token';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

type RemediatorMock = NonNullable<AdminRoutesDeps['alignmentAutoRemediator']>;

function makeRemediatorStats(overrides?: Partial<ReturnType<RemediatorMock['getStats']>>): ReturnType<RemediatorMock['getStats']> {
  return {
    observationCount: 15,
    remediationsTriggered: 2,
    lastRemediationAt: 1_700_000_600_000,
    lastStatus: 'RED',
    inCooldown: true,
    ...overrides,
  };
}

function buildDeps(remediator?: RemediatorMock): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    alignmentAutoRemediator: remediator,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/remediation/stats', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-1: 200 with full data
  // -------------------------------------------------------------------------
  it('REM-ROUTE-1: returns 200 with full stats data when remediator is configured', async () => {
    const stats = makeRemediatorStats();
    const remediator: RemediatorMock = { getStats: () => stats };
    ts = await startServer(buildDeps(remediator), makeTokenBuf(VALID_TOKEN));

    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: ReturnType<RemediatorMock['getStats']> };
    expect(body.ok).toBe(true);
    expect(body.data.observationCount).toBe(15);
    expect(body.data.remediationsTriggered).toBe(2);
    expect(body.data.lastRemediationAt).toBe(1_700_000_600_000);
    expect(body.data.lastStatus).toBe('RED');
    expect(body.data.inCooldown).toBe(true);
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-2: 503 when remediator absent
  // -------------------------------------------------------------------------
  it('REM-ROUTE-2: returns 503 when alignmentAutoRemediator is not configured', async () => {
    ts = await startServer(buildDeps(/* no remediator */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-3: 401 when bearer token missing
  // -------------------------------------------------------------------------
  it('REM-ROUTE-3: returns 401 when bearer token is absent', async () => {
    const remediator: RemediatorMock = { getStats: () => makeRemediatorStats() };
    ts = await startServer(buildDeps(remediator), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`, null);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-4: 401 when bearer token wrong
  // -------------------------------------------------------------------------
  it('REM-ROUTE-4: returns 401 when bearer token is incorrect', async () => {
    const remediator: RemediatorMock = { getStats: () => makeRemediatorStats() };
    ts = await startServer(buildDeps(remediator), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`, 'wrong-token');
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-5: 200 with no token required (tokenBuf null)
  // -------------------------------------------------------------------------
  it('REM-ROUTE-5: returns 200 with no auth token when tokenBuf is null (open access)', async () => {
    const remediator: RemediatorMock = { getStats: () => makeRemediatorStats({ remediationsTriggered: 0 }) };
    ts = await startServer(buildDeps(remediator), null);

    // Request without any auth header
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: ReturnType<RemediatorMock['getStats']> };
    expect(body.ok).toBe(true);
    expect(body.data.remediationsTriggered).toBe(0);
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-6: 500 when getStats throws
  // -------------------------------------------------------------------------
  it('REM-ROUTE-6: returns 500 when getStats throws an error', async () => {
    const throwingRemediator: RemediatorMock = {
      getStats: () => { throw new Error('DB exploded in remediator'); },
    };
    ts = await startServer(buildDeps(throwingRemediator), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`, VALID_TOKEN);
    expect(status).toBe(500);
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-7: Response shape has ok + data wrapper
  // -------------------------------------------------------------------------
  it('REM-ROUTE-7: response always uses {ok, data} envelope', async () => {
    const stats = makeRemediatorStats({ inCooldown: false, remediationsTriggered: 5 });
    const remediator: RemediatorMock = { getStats: () => stats };
    ts = await startServer(buildDeps(remediator), null);

    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`);
    expect(status).toBe(200);

    const body = json as Record<string, unknown>;
    expect('ok' in body).toBe(true);
    expect('data' in body).toBe(true);
    expect(body['ok']).toBe(true);

    const data = body['data'] as Record<string, unknown>;
    expect('observationCount' in data).toBe(true);
    expect('remediationsTriggered' in data).toBe(true);
    expect('lastStatus' in data).toBe(true);
    expect('inCooldown' in data).toBe(true);
  });

  // -------------------------------------------------------------------------
  // REM-ROUTE-8: lastRemediationAt absent when no remediation fired
  // -------------------------------------------------------------------------
  it('REM-ROUTE-8: lastRemediationAt is undefined/absent when no remediation has fired', async () => {
    const stats = makeRemediatorStats({
      observationCount: 3,
      remediationsTriggered: 0,
      lastRemediationAt: undefined,
      lastStatus: 'GREEN',
      inCooldown: false,
    });
    const remediator: RemediatorMock = { getStats: () => stats };
    ts = await startServer(buildDeps(remediator), null);

    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/remediation/stats`);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: Record<string, unknown> };
    // JSON serializes undefined as absent key
    expect(body.ok).toBe(true);
    expect(body.data['remediationsTriggered']).toBe(0);
    expect(body.data['lastRemediationAt']).toBeUndefined();
  });
});
