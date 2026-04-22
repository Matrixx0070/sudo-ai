/**
 * @file tests/gateway/admin-routes-trust.test.ts
 * @description Wave 6J: GET /v1/admin/trust endpoint tests.
 *
 * Tests:
 *   1. 200 with real tier/score/windowDays/computedAt when tracker is present.
 *   2. 503 {ok:false, error:'trust tier tracker not configured'} when tracker absent.
 *   3. 401 when bearer token is missing/invalid.
 *   4. 500 when tracker.getAuditSnapshot() throws.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-trust-token-xyz';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

function buildBaseDeps(trustTierTracker?: AdminRoutesDeps['trustTierTracker']): AdminRoutesDeps {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/trust', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // 1. 200 with real data
  // -------------------------------------------------------------------------
  it('returns 200 with tier/score/windowDays/computedAt when tracker present', async () => {
    const mockTracker: NonNullable<AdminRoutesDeps['trustTierTracker']> = {
      getAuditSnapshot: () => ({
        tier: 'HIGH',
        score: 0.85,
        windowSizeDays: 7,
        lastAdjustedAt: new Date().toISOString(),
      }),
    };
    ts = await startServer(buildBaseDeps(mockTracker), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/trust`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { tier: string; score: number; windowDays: number; computedAt: string } };
    expect(body.ok).toBe(true);
    expect(body.data.tier).toBe('HIGH');
    expect(body.data.score).toBe(0.85);
    expect(body.data.windowDays).toBe(7);
    expect(typeof body.data.computedAt).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 2. 503 when tracker is absent
  // -------------------------------------------------------------------------
  it('returns 503 when trustTierTracker is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no tracker */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/trust`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('trust tier tracker not configured');
  });

  // -------------------------------------------------------------------------
  // 3. 401 when bearer is missing
  // -------------------------------------------------------------------------
  it('returns 401 when bearer token is absent', async () => {
    const mockTracker: NonNullable<AdminRoutesDeps['trustTierTracker']> = {
      getAuditSnapshot: () => ({ tier: 'MEDIUM', score: 0.6, windowSizeDays: 7, lastAdjustedAt: new Date().toISOString() }),
    };
    ts = await startServer(buildBaseDeps(mockTracker), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/trust`, /* no token */ null);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 4. 500 when tracker.getAuditSnapshot() throws
  // -------------------------------------------------------------------------
  it('returns 500 when getAuditSnapshot() throws', async () => {
    const throwingTracker: NonNullable<AdminRoutesDeps['trustTierTracker']> = {
      getAuditSnapshot: () => { throw new Error('DB error'); },
    };
    ts = await startServer(buildBaseDeps(throwingTracker), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/trust`, VALID_TOKEN);
    expect(status).toBe(500);
  });
});
