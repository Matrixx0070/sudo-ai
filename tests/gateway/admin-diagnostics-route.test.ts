/**
 * @file tests/gateway/admin-diagnostics-route.test.ts
 * @description Wave 6M: GET /v1/admin/diagnostics endpoint tests.
 *
 * Tests:
 *   DIAG-R-1  200 with correct DiagnosticsReport shape when dep is present.
 *   DIAG-R-2  503 when crossSignalDiagnostics is absent.
 *   DIAG-R-3  401 when bearer token is missing/invalid.
 *   DIAG-R-4  400 when window param is out of range (0 or 91).
 *   DIAG-R-5  400 when bucket param is out of range (0 or 121).
 *   DIAG-R-6  400 when corrWindow param is out of range (0 or 241).
 *   DIAG-R-7  Default params used when query params omitted: window=7, bucket=15, corrWindow=30.
 *   DIAG-R-8  500 when analyze() throws.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-diagnostics-token-xyz';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

type DiagDep = NonNullable<AdminRoutesDeps['crossSignalDiagnostics']>;
type DiagReport = ReturnType<DiagDep['analyze']>;

function makeMockReport(windowDays = 7): DiagReport {
  return {
    windowDays,
    trustSpikes: [
      { source: 'trust', kind: 'trust-failure', ts: Date.now() - 60000, count: 4 },
    ],
    epistemicBlockSpikes: [],
    vetoSpikes: [],
    commitmentExpirySpikes: [],
    correlations: [
      {
        leadingSpike: { source: 'trust', kind: 'trust-failure', ts: Date.now() - 60000, count: 4 },
        trailingSpike: { source: 'epistemic', kind: 'epistemic-block', ts: Date.now() - 30000, count: 3 },
        deltaMs: 30000,
        confidence: 0.72,
      },
    ],
    analyzedAt: new Date().toISOString(),
    totalEventsScanned: 42,
  };
}

function makeMockDep(
  opts: {
    throwOnAnalyze?: boolean;
    capturedOpts?: Array<Parameters<DiagDep['analyze']>[0]>;
  } = {},
): DiagDep {
  return {
    analyze: (analyzeOpts) => {
      if (opts.capturedOpts) opts.capturedOpts.push(analyzeOpts);
      if (opts.throwOnAnalyze) throw new Error('DB error in diagnostics');
      return makeMockReport(analyzeOpts?.windowDays ?? 7);
    },
  };
}

function buildBaseDeps(dep?: AdminRoutesDeps['crossSignalDiagnostics']): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
    crossSignalDiagnostics: dep,
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

describe('GET /v1/admin/diagnostics', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // DIAG-R-1: 200 with correct shape
  // -------------------------------------------------------------------------
  it('DIAG-R-1: returns 200 with correct DiagnosticsReport shape when dep present', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as {
      ok: boolean;
      data: DiagReport;
    };
    expect(body.ok).toBe(true);
    expect(body.data.windowDays).toBe(7);
    expect(typeof body.data.analyzedAt).toBe('string');
    expect(typeof body.data.totalEventsScanned).toBe('number');
    expect(Array.isArray(body.data.trustSpikes)).toBe(true);
    expect(Array.isArray(body.data.epistemicBlockSpikes)).toBe(true);
    expect(Array.isArray(body.data.vetoSpikes)).toBe(true);
    expect(Array.isArray(body.data.commitmentExpirySpikes)).toBe(true);
    expect(Array.isArray(body.data.correlations)).toBe(true);
    // Verify spike shape
    const spike = body.data.trustSpikes[0];
    if (spike) {
      expect(typeof spike.source).toBe('string');
      expect(typeof spike.kind).toBe('string');
      expect(typeof spike.ts).toBe('number');
      expect(typeof spike.count).toBe('number');
    }
    // Verify correlation shape
    const corr = body.data.correlations[0];
    if (corr) {
      expect(typeof corr.leadingSpike.kind).toBe('string');
      expect(typeof corr.trailingSpike.kind).toBe('string');
      expect(typeof corr.deltaMs).toBe('number');
      expect(typeof corr.confidence).toBe('number');
    }
  });

  // -------------------------------------------------------------------------
  // DIAG-R-2: 503 when dep absent
  // -------------------------------------------------------------------------
  it('DIAG-R-2: returns 503 when crossSignalDiagnostics is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no dep */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not configured/i);
  });

  // -------------------------------------------------------------------------
  // DIAG-R-3: 401 when bearer is missing
  // -------------------------------------------------------------------------
  it('DIAG-R-3: returns 401 when bearer token is absent', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics`, /* no token */ null);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // DIAG-R-4: 400 when window param is out of range
  // -------------------------------------------------------------------------
  it('DIAG-R-4a: returns 400 when window=0 (below minimum 1)', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics?window=0`, VALID_TOKEN);
    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/window/i);
  });

  it('DIAG-R-4b: returns 400 when window=91 (above maximum 90)', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics?window=91`, VALID_TOKEN);
    expect(status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // DIAG-R-5: 400 when bucket param is out of range
  // -------------------------------------------------------------------------
  it('DIAG-R-5a: returns 400 when bucket=0 (below minimum 1)', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics?bucket=0`, VALID_TOKEN);
    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/bucket/i);
  });

  it('DIAG-R-5b: returns 400 when bucket=121 (above maximum 120)', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics?bucket=121`, VALID_TOKEN);
    expect(status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // DIAG-R-6: 400 when corrWindow param is out of range
  // -------------------------------------------------------------------------
  it('DIAG-R-6a: returns 400 when corrWindow=0 (below minimum 1)', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics?corrWindow=0`, VALID_TOKEN);
    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/corrWindow/i);
  });

  it('DIAG-R-6b: returns 400 when corrWindow=241 (above maximum 240)', async () => {
    ts = await startServer(buildBaseDeps(makeMockDep()), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics?corrWindow=241`, VALID_TOKEN);
    expect(status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // DIAG-R-7: Default params used when query params omitted
  // -------------------------------------------------------------------------
  it('DIAG-R-7: uses defaults window=7, bucket=15, corrWindow=30 when params omitted', async () => {
    const capturedOpts: Array<Parameters<DiagDep['analyze']>[0]> = [];
    const dep = makeMockDep({ capturedOpts });
    ts = await startServer(buildBaseDeps(dep), makeTokenBuf(VALID_TOKEN));
    await doGet(`${ts.baseUrl}/v1/admin/diagnostics`, VALID_TOKEN);

    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0]?.windowDays).toBe(7);
    expect(capturedOpts[0]?.spikeBucketMinutes).toBe(15);
    expect(capturedOpts[0]?.correlationWindowMinutes).toBe(30);
  });

  // -------------------------------------------------------------------------
  // DIAG-R-8: 500 when analyze() throws
  // -------------------------------------------------------------------------
  it('DIAG-R-8: returns 500 when analyze() throws', async () => {
    const dep = makeMockDep({ throwOnAnalyze: true });
    ts = await startServer(buildBaseDeps(dep), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/diagnostics`, VALID_TOKEN);
    expect(status).toBe(500);
  });
});
