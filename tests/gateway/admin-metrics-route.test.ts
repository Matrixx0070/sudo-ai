/**
 * @file tests/gateway/admin-metrics-route.test.ts
 * @description Wave 7F: GET /v1/admin/metrics (Prometheus text format) endpoint tests.
 *
 * Tests:
 *   MET-1  200 with text/plain content-type and sudo_alignment_score line
 *   MET-2  401 when bearer token missing
 *   MET-3  401 when bearer token wrong
 *   MET-4  text/plain; version=0.0.4 content-type is set
 *   MET-5  missing deps emit up=0 lines (scrape-friendly)
 *   MET-6  response ends with newline (Prometheus convention)
 *   MET-7  window param is accepted without error (soft clamp)
 *   MET-8  all subsystem _up metrics present in full-deps response
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-metrics-token-7f';

function makeTokenBuf(): Buffer {
  return Buffer.from(VALID_TOKEN, 'utf8');
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

interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function doGetRaw(url: string, token?: string | null): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
  });
}

function makeMinimalDeps(): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
      recordTriple: () => { /* no-op */ },
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
      recordTriple: () => { /* no-op */ },
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
    confidenceCalibrationTracker: {
      getReport: () => ({
        totalSamples: 10,
        brierScore: 0.337,
        overallAvgPredicted: 0.75,
        overallSuccessRate: 0.80,
        buckets: [],
        windowDays: 7,
        computedAt: new Date().toISOString(),
      }),
    },
    commitmentAuditor: {
      getExpiringCommitments: (_w: number) => [],
      getExpiredCommitments: () => [],
    },
    epistemicGate: {
      listDecisions: () => [],
      getStats: () => ({
        total: 10,
        byTag: {} as Record<string, number>,
        byDecision: { PASS: 8, BLOCK: 2, UNCERTAIN: 0 } as Record<string, number>,
        blockRate: 0.2,
        window: { sinceMs: 0, untilMs: Date.now() },
      }),
    },
    mistakePatternRecognizer: {
      analyze: () => ({
        totalMistakes: 5,
        uniquePatterns: 2,
        recurringPatterns: [
          { signatureHash: 'abc', signature: 's', occurrences: 3, firstSeenAt: '', lastSeenAt: '', tags: [] },
        ],
        windowDays: 7,
        analyzedAt: new Date().toISOString(),
      }),
    },
    crossSignalDiagnostics: {
      analyze: () => ({
        windowDays: 7,
        trustSpikes: [],
        epistemicBlockSpikes: [],
        vetoSpikes: [],
        commitmentExpirySpikes: [],
        correlations: [],
        analyzedAt: new Date().toISOString(),
        totalEventsScanned: 50,
      }),
    },
    reanchorMonitor: {
      getStats: () => ({
        total: 3,
        byTrigger: { startup: 3 },
        windowDays: 7,
        computedAt: new Date().toISOString(),
        lastReAnchorAt: 1744502400000,
      }),
      getRecent: () => [],
    },
    commitmentResolutionTracker: {
      resolve: () => null,
      isResolved: () => false,
      getStats: () => ({
        total: 5,
        honored: 4,
        abandoned: 1,
        expiredAcknowledged: 0,
        honorRate: 0.8,
        windowDays: 7,
        computedAt: new Date().toISOString(),
      }),
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

describe('GET /v1/admin/metrics', () => {
  it('MET-1 200 with sudo_alignment_score in body when deps provided', async () => {
    const server = await getServer(makeFullDeps(), makeTokenBuf());
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics`, VALID_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toContain('sudo_alignment_score');
    expect(res.body).toContain('0.823');
  });

  it('MET-2 401 when no bearer token', async () => {
    const server = await getServer(makeMinimalDeps(), makeTokenBuf());
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics`);
    expect(res.status).toBe(401);
  });

  it('MET-3 401 when wrong bearer token', async () => {
    const server = await getServer(makeMinimalDeps(), makeTokenBuf());
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics`, 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('MET-4 content-type is text/plain with version param', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics`);
    expect(res.status).toBe(200);
    const ct = res.headers['content-type'] ?? '';
    expect(ct).toContain('text/plain');
    expect(ct).toContain('version=0.0.4');
  });

  it('MET-5 missing deps emit up=0 lines (scrape-friendly)', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('sudo_alignment_up 0');
    expect(res.body).toContain('sudo_trust_up 0');
    expect(res.body).toContain('sudo_calibration_up 0');
  });

  it('MET-6 response ends with newline', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.endsWith('\n')).toBe(true);
  });

  it('MET-7 window param is accepted without error', async () => {
    const server = await getServer(makeMinimalDeps(), null);
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics?window=14`);
    expect(res.status).toBe(200);
  });

  it('MET-8 all subsystem _up metrics present in full-deps response', async () => {
    const server = await getServer(makeFullDeps(), null);
    const res = await doGetRaw(`${server.baseUrl}/v1/admin/metrics`);
    expect(res.status).toBe(200);
    const subsystems = ['alignment', 'trust', 'calibration', 'commitments', 'epistemic', 'patterns', 'diagnostics', 'reanchor', 'resolutions'];
    for (const name of subsystems) {
      expect(res.body).toContain(`sudo_${name}_up 1`);
    }
  });
});
