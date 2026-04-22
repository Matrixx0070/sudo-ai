/**
 * @file tests/gateway/admin-calibration-route.test.ts
 * @description Wave 6L: GET /v1/admin/calibration endpoint tests.
 *
 * Tests:
 *   CAL-R-1  200 with correct report shape when tracker is present.
 *   CAL-R-2  503 when confidenceCalibrationTracker is absent.
 *   CAL-R-3  401 when bearer token is missing/invalid.
 *   CAL-R-4  400 when window param is out of range (0 or 366).
 *   CAL-R-5  window param default is 30 when omitted.
 *   CAL-R-6  tag param is forwarded to getReport().
 *   CAL-R-7  500 when getReport() throws.
 *   CAL-R-8  tag param sanitizes control characters and truncates to 40 chars.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-calibration-token-xyz';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

interface MockBucket {
  bucket: string;
  rangeLow: number;
  rangeHigh: number;
  count: number;
  avgPredicted: number;
  actualSuccessRate: number;
  calibrationError: number;
}

function makeMockReport(windowDays = 30, totalSamples = 42) {
  const buckets: MockBucket[] = [
    { bucket: 'VERY_LOW', rangeLow: 0, rangeHigh: 0.2, count: 5, avgPredicted: 0.15, actualSuccessRate: 0.2, calibrationError: -0.05 },
    { bucket: 'LOW',      rangeLow: 0.2, rangeHigh: 0.4, count: 8, avgPredicted: 0.3, actualSuccessRate: 0.25, calibrationError: 0.05 },
    { bucket: 'MEDIUM',   rangeLow: 0.4, rangeHigh: 0.6, count: 10, avgPredicted: 0.5, actualSuccessRate: 0.5, calibrationError: 0 },
    { bucket: 'HIGH',     rangeLow: 0.6, rangeHigh: 0.8, count: 12, avgPredicted: 0.7, actualSuccessRate: 0.65, calibrationError: 0.05 },
    { bucket: 'VERY_HIGH', rangeLow: 0.8, rangeHigh: 1.0, count: 7, avgPredicted: 0.9, actualSuccessRate: 0.86, calibrationError: 0.04 },
  ];
  return {
    totalSamples,
    brierScore: 0.15,
    overallAvgPredicted: 0.63,
    overallSuccessRate: 0.6,
    buckets,
    windowDays,
    computedAt: new Date().toISOString(),
  };
}

function makeMockTracker(
  opts: { throwOnGetReport?: boolean; capturedOpts?: Array<Parameters<NonNullable<AdminRoutesDeps['confidenceCalibrationTracker']>['getReport']>[0]> } = {},
): NonNullable<AdminRoutesDeps['confidenceCalibrationTracker']> {
  return {
    getReport: (reportOpts) => {
      if (opts.capturedOpts) opts.capturedOpts.push(reportOpts);
      if (opts.throwOnGetReport) throw new Error('DB error');
      return makeMockReport(reportOpts?.windowDays ?? 30);
    },
  };
}

function buildBaseDeps(
  tracker?: AdminRoutesDeps['confidenceCalibrationTracker'],
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
    confidenceCalibrationTracker: tracker,
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

describe('GET /v1/admin/calibration', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // CAL-R-1: 200 with correct shape
  // -------------------------------------------------------------------------
  it('CAL-R-1: returns 200 with correct calibration report shape when tracker present', async () => {
    ts = await startServer(buildBaseDeps(makeMockTracker()), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/calibration`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as {
      ok: boolean;
      data: {
        totalSamples: number;
        brierScore: number;
        overallAvgPredicted: number;
        overallSuccessRate: number;
        buckets: MockBucket[];
        windowDays: number;
        computedAt: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.totalSamples).toBe(42);
    expect(typeof body.data.brierScore).toBe('number');
    expect(typeof body.data.overallAvgPredicted).toBe('number');
    expect(typeof body.data.overallSuccessRate).toBe('number');
    expect(Array.isArray(body.data.buckets)).toBe(true);
    expect(body.data.buckets.length).toBe(5);
    expect(body.data.windowDays).toBe(30);
    expect(typeof body.data.computedAt).toBe('string');
    // Verify bucket shape
    const firstBucket = body.data.buckets[0]!;
    expect(firstBucket.bucket).toBe('VERY_LOW');
    expect(typeof firstBucket.rangeLow).toBe('number');
    expect(typeof firstBucket.rangeHigh).toBe('number');
  });

  // -------------------------------------------------------------------------
  // CAL-R-2: 503 when tracker absent
  // -------------------------------------------------------------------------
  it('CAL-R-2: returns 503 when confidenceCalibrationTracker is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no tracker */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/calibration`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('confidence calibration tracker not configured');
  });

  // -------------------------------------------------------------------------
  // CAL-R-3: 401 when bearer is missing
  // -------------------------------------------------------------------------
  it('CAL-R-3: returns 401 when bearer token is absent', async () => {
    ts = await startServer(buildBaseDeps(makeMockTracker()), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/calibration`, /* no token */ null);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // CAL-R-4: 400 when window param is out of range
  // -------------------------------------------------------------------------
  it('CAL-R-4a: returns 400 when window=0 (below minimum)', async () => {
    ts = await startServer(buildBaseDeps(makeMockTracker()), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/calibration?window=0`, VALID_TOKEN);
    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/window/i);
  });

  it('CAL-R-4b: returns 400 when window=366 (above maximum)', async () => {
    ts = await startServer(buildBaseDeps(makeMockTracker()), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/calibration?window=366`, VALID_TOKEN);
    expect(status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // CAL-R-5: default window is 30
  // -------------------------------------------------------------------------
  it('CAL-R-5: uses window=30 when param is omitted', async () => {
    const capturedOpts: Parameters<NonNullable<AdminRoutesDeps['confidenceCalibrationTracker']>['getReport']>[0][] = [];
    const tracker = makeMockTracker({ capturedOpts });
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    await doGet(`${ts.baseUrl}/v1/admin/calibration`, VALID_TOKEN);

    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0]?.windowDays).toBe(30);
  });

  // -------------------------------------------------------------------------
  // CAL-R-6: tag param is forwarded to getReport
  // -------------------------------------------------------------------------
  it('CAL-R-6: forwards tag param to getReport()', async () => {
    const capturedOpts: Parameters<NonNullable<AdminRoutesDeps['confidenceCalibrationTracker']>['getReport']>[0][] = [];
    const tracker = makeMockTracker({ capturedOpts });
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    await doGet(`${ts.baseUrl}/v1/admin/calibration?tag=CERTAIN`, VALID_TOKEN);

    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0]?.tag).toBe('CERTAIN');
  });

  // -------------------------------------------------------------------------
  // CAL-R-7: 500 when getReport throws
  // -------------------------------------------------------------------------
  it('CAL-R-7: returns 500 when getReport() throws', async () => {
    const tracker = makeMockTracker({ throwOnGetReport: true });
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/calibration`, VALID_TOKEN);
    expect(status).toBe(500);
  });

  // -------------------------------------------------------------------------
  // CAL-R-8: tag sanitizes control chars and truncates to ≤40 chars
  // -------------------------------------------------------------------------
  it('CAL-R-8: tag sanitizes control characters and truncates to 40 chars', async () => {
    const capturedOpts: Parameters<NonNullable<AdminRoutesDeps['confidenceCalibrationTracker']>['getReport']>[0][] = [];
    const tracker = makeMockTracker({ capturedOpts });
    ts = await startServer(buildBaseDeps(tracker), makeTokenBuf(VALID_TOKEN));

    // 50-char tag with a control char embedded
    const longTag = 'A'.repeat(45) + '\x01' + 'B'.repeat(5);
    const encodedTag = encodeURIComponent(longTag);
    await doGet(`${ts.baseUrl}/v1/admin/calibration?tag=${encodedTag}`, VALID_TOKEN);

    expect(capturedOpts.length).toBe(1);
    const forwarded = capturedOpts[0]?.tag ?? '';
    // Should be truncated to ≤40 chars (after control char removal)
    expect(forwarded.length).toBeLessThanOrEqual(40);
    // Control char should be gone
    expect(forwarded).not.toMatch(/[\u0000-\u001F\u007F]/);
  });
});
