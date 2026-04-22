/**
 * @file tests/gateway/admin-veto-threshold-route.test.ts
 * @description Wave 7C: GET /v1/admin/veto/threshold endpoint tests.
 *
 * Tests:
 *   VTR-1  200 with correct payload shape when tuner is present
 *   VTR-2  503 when autoThresholdTuner is absent
 *   VTR-3  401 when bearer token is missing/invalid
 *   VTR-4  Payload contains baseThreshold=0.5 (static constant)
 *   VTR-5  Payload adjustment is 0 when Brier <= 0.10
 *   VTR-6  Payload adjustment is non-zero when Brier is high
 *   VTR-7  500 when tuner.computeVetoThreshold throws
 *   VTR-8  effectiveThreshold is clamped to at least 0.30
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-veto-threshold-token-xyz';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

/** Build a mock tuner with given brier/samples/adjustment. */
function makeMockTuner(opts: {
  effectiveThreshold?: number;
  brierScore?: number;
  totalSamples?: number;
  adjustment?: number;
  throwOnCompute?: boolean;
}): NonNullable<AdminRoutesDeps['autoThresholdTuner']> {
  const {
    effectiveThreshold = 0.5,
    brierScore = 0.05,
    totalSamples = 20,
    adjustment = 0,
    throwOnCompute = false,
  } = opts;

  return {
    computeVetoThreshold: (_base: number) => {
      if (throwOnCompute) throw new Error('tuner exploded');
      return effectiveThreshold;
    },
    getLastComputation: () => {
      if (throwOnCompute) return null;
      return {
        baseThreshold: 0.5,
        effectiveThreshold,
        brierScore,
        totalSamples,
        adjustment,
        computedAt: new Date().toISOString(),
      };
    },
  };
}

function buildBaseDeps(
  tuner?: AdminRoutesDeps['autoThresholdTuner'],
): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    autoThresholdTuner: tuner,
  };
}

/** Make a request helper that closes the server after each test. */
function makeTestServer(deps: AdminRoutesDeps, tokenBuf: Buffer | null): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    registerAdminRoutes(server, deps, tokenBuf);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.close();
  }
});

async function getJSON(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          resolve({ status: res.statusCode ?? 0, body });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: null });
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /v1/admin/veto/threshold', () => {
  // VTR-1: 200 with correct payload shape
  it('VTR-1: returns 200 with correct payload shape when tuner is configured', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({ effectiveThreshold: 0.5, brierScore: 0.05, totalSamples: 20, adjustment: 0 })),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { status, body } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: `Bearer ${VALID_TOKEN}` },
    );

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['ok']).toBe(true);
    const data = b['data'] as Record<string, unknown>;
    expect(typeof data['baseThreshold']).toBe('number');
    expect(typeof data['effectiveThreshold']).toBe('number');
    expect(typeof data['brierScore']).toBe('number');
    expect(typeof data['totalSamples']).toBe('number');
    expect(typeof data['adjustment']).toBe('number');
    expect(typeof data['computedAt']).toBe('string');
  });

  // VTR-2: 503 when tuner absent
  it('VTR-2: returns 503 when autoThresholdTuner is absent', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(undefined),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { status } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: `Bearer ${VALID_TOKEN}` },
    );

    expect(status).toBe(503);
  });

  // VTR-3: 401 when missing/invalid token
  it('VTR-3: returns 401 when bearer token is missing', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({})),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { status } = await getJSON(`${url}/v1/admin/veto/threshold`);
    expect(status).toBe(401);
  });

  it('VTR-3b: returns 401 when bearer token is invalid', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({})),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { status } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: 'Bearer wrong-token' },
    );
    expect(status).toBe(401);
  });

  // VTR-4: baseThreshold is 0.5
  it('VTR-4: baseThreshold in payload is 0.5 (static constant)', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({ effectiveThreshold: 0.5, brierScore: 0.05, totalSamples: 20, adjustment: 0 })),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { status, body } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: `Bearer ${VALID_TOKEN}` },
    );

    expect(status).toBe(200);
    const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['baseThreshold']).toBe(0.5);
  });

  // VTR-5: adjustment is 0 when Brier <= 0.10
  it('VTR-5: adjustment is 0 when Brier is low (well-calibrated)', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({ effectiveThreshold: 0.5, brierScore: 0.05, totalSamples: 20, adjustment: 0 })),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { body } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: `Bearer ${VALID_TOKEN}` },
    );

    const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['adjustment']).toBe(0);
    expect(data['effectiveThreshold']).toBe(0.5);
  });

  // VTR-6: adjustment is non-zero when Brier is high
  it('VTR-6: adjustment is non-zero when Brier is high (drifting)', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({
        effectiveThreshold: 0.35,
        brierScore: 0.32,
        totalSamples: 50,
        adjustment: 0.15,
      })),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { body } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: `Bearer ${VALID_TOKEN}` },
    );

    const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['adjustment']).toBe(0.15);
    expect(data['effectiveThreshold']).toBe(0.35);
  });

  // VTR-7: 500 when tuner throws
  it('VTR-7: returns 500 when tuner.computeVetoThreshold throws', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({ throwOnCompute: true })),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { status } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: `Bearer ${VALID_TOKEN}` },
    );

    expect(status).toBe(500);
  });

  // VTR-8: effectiveThreshold is at least 0.30 (clamp lower bound)
  it('VTR-8: effectiveThreshold reflects clamped value (>= 0.30)', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({
        effectiveThreshold: 0.30, // clamped from 0.25
        brierScore: 0.99,
        totalSamples: 100,
        adjustment: 0.25,
      })),
      makeTokenBuf(VALID_TOKEN),
    );
    servers.push(server);

    const { body } = await getJSON(
      `${url}/v1/admin/veto/threshold`,
      { Authorization: `Bearer ${VALID_TOKEN}` },
    );

    const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['effectiveThreshold']).toBeGreaterThanOrEqual(0.30);
  });

  // VTR-9: No auth (tokenBuf null) → all requests are accepted
  it('VTR-9: no auth configured → request succeeds without token', async () => {
    const { url, server } = await makeTestServer(
      buildBaseDeps(makeMockTuner({})),
      null, // no token configured
    );
    servers.push(server);

    const { status } = await getJSON(`${url}/v1/admin/veto/threshold`);
    expect(status).toBe(200);
  });
});
