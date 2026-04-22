/**
 * @file tests/gateway/admin-digest-route.test.ts
 * @description Wave 6Q: GET /v1/admin/digest endpoint tests.
 *
 * Tests:
 *   DIG-1  200 with correct shape and all keys present when all deps provided
 *   DIG-2  401 when bearer token missing or invalid
 *   DIG-3  400 when window param is out of range (0 or 91)
 *   DIG-4  missing deps gracefully return null for their slice
 *   DIG-5  window param is forwarded to each dep call
 *   DIG-6  per-slice isolation: one dep throwing does not 500 the whole digest
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-digest-token-xyz';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
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

function getJson(url: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode ?? 0, body });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Full mock deps factory
// ---------------------------------------------------------------------------

function makeFullDeps(overrides: Partial<AdminRoutesDeps> = {}): AdminRoutesDeps {
  const base: AdminRoutesDeps = {
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
        score: 0.82,
        level: 'GREEN' as const,
        diagnosis: 'LEVEL=GREEN SCORE=0.820 — owner-loyalty continuity check.',
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
        score: 0.95,
        windowSizeDays: 7,
        lastAdjustedAt: new Date().toISOString(),
      }),
      getOutcomeBreakdown: () => [
        { kind: 'injection-detected', count: 2, score: -0.5 },
        { kind: 'commitment-honored', count: 5, score: 1.0 },
      ],
    },
    confidenceCalibrationTracker: {
      getReport: (opts) => ({
        totalSamples: 20,
        brierScore: 0.12,
        overallAvgPredicted: 0.65,
        overallSuccessRate: 0.63,
        buckets: [],
        windowDays: opts?.windowDays ?? 7,
        computedAt: new Date().toISOString(),
      }),
    },
    commitmentAuditor: {
      getExpiringCommitments: () => [],
      getExpiredCommitments: () => [],
    },
    epistemicGate: {
      listDecisions: () => [],
      getStats: (opts) => ({
        total: 10,
        byTag: { CERTAIN: 5, PROBABLE: 3, CONJECTURE: 1, UNKNOWN: 1 },
        byDecision: { PASS: 8, BLOCK: 1, UNCERTAIN: 1 },
        blockRate: 0.1,
        window: { sinceMs: opts?.sinceMs ?? 0, untilMs: Date.now() },
      }),
    },
    mistakePatternRecognizer: {
      analyze: (opts) => ({
        totalMistakes: 3,
        uniquePatterns: 2,
        recurringPatterns: [],
        windowDays: opts?.windowDays ?? 7,
        analyzedAt: new Date().toISOString(),
      }),
    },
    crossSignalDiagnostics: {
      analyze: (opts) => ({
        windowDays: opts?.windowDays ?? 7,
        trustSpikes: [],
        epistemicBlockSpikes: [],
        vetoSpikes: [],
        commitmentExpirySpikes: [],
        correlations: [],
        analyzedAt: new Date().toISOString(),
        totalEventsScanned: 42,
      }),
    },
    reanchorMonitor: {
      getStats: (opts) => ({
        total: 1,
        byTrigger: { manual: 1 },
        windowDays: opts?.windowDays ?? 7,
        computedAt: new Date().toISOString(),
      }),
      getRecent: () => [],
    },
    commitmentResolutionTracker: {
      resolve: () => null,
      isResolved: () => false,
      getStats: (opts) => ({
        total: 5,
        honored: 4,
        abandoned: 1,
        expiredAcknowledged: 0,
        honorRate: 0.8,
        windowDays: opts?.windowDays ?? 7,
        computedAt: new Date().toISOString(),
      }),
    },
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/digest', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  // DIG-1: 200 with correct shape and all keys present when all deps provided
  it('DIG-1: 200 with all top-level data keys when all deps provided', async () => {
    const srv = await startServer(makeFullDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status, body } = await getJson(`${srv.baseUrl}/v1/admin/digest`, VALID_TOKEN);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['ok']).toBe(true);
    const data = b['data'] as Record<string, unknown>;
    expect(typeof data['windowDays']).toBe('number');
    expect(typeof data['computedAt']).toBe('string');
    // All required slice keys must be present
    expect(Object.keys(data)).toContain('alignment');
    expect(Object.keys(data)).toContain('trust');
    expect(Object.keys(data)).toContain('calibration');
    expect(Object.keys(data)).toContain('commitments');
    expect(Object.keys(data)).toContain('epistemic');
    expect(Object.keys(data)).toContain('patterns');
    expect(Object.keys(data)).toContain('diagnostics');
    expect(Object.keys(data)).toContain('injection');
    expect(Object.keys(data)).toContain('reanchor');
    expect(Object.keys(data)).toContain('resolutions');

    // calibration should be summary subset (no buckets)
    const cal = data['calibration'] as Record<string, unknown>;
    expect(typeof cal['totalSamples']).toBe('number');
    expect(typeof cal['brierScore']).toBe('number');
    expect(cal['buckets']).toBeUndefined();

    // patterns should be summary subset (no recurringPatterns)
    const pat = data['patterns'] as Record<string, unknown>;
    expect(typeof pat['totalMistakes']).toBe('number');
    expect(typeof pat['recurringCount']).toBe('number');
    expect(pat['recurringPatterns']).toBeUndefined();

    // diagnostics should be summary subset (no spike arrays)
    const diag = data['diagnostics'] as Record<string, unknown>;
    expect(typeof diag['totalEventsScanned']).toBe('number');
    expect(typeof diag['correlationCount']).toBe('number');
    expect(diag['trustSpikes']).toBeUndefined();

    // injection should be the matched row or null
    // (full deps provides injection-detected row)
    expect(data['injection']).not.toBeNull();

    // resolutions should have honorRate
    const res = data['resolutions'] as Record<string, unknown>;
    expect(typeof res['honorRate']).toBe('number');
  });

  // DIG-2: 401 when bearer token missing or invalid
  it('DIG-2: 401 without token', async () => {
    const srv = await startServer(makeFullDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status } = await getJson(`${srv.baseUrl}/v1/admin/digest`);
    expect(status).toBe(401);
  });

  it('DIG-2b: 401 with wrong token', async () => {
    const srv = await startServer(makeFullDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status } = await getJson(`${srv.baseUrl}/v1/admin/digest`, 'wrong-token');
    expect(status).toBe(401);
  });

  // DIG-3: 400 when window param is out of range
  it('DIG-3a: 400 when window=0', async () => {
    const srv = await startServer(makeFullDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status, body } = await getJson(`${srv.baseUrl}/v1/admin/digest?window=0`, VALID_TOKEN);
    expect(status).toBe(400);
    expect((body as Record<string, unknown>)['ok']).toBe(false);
  });

  it('DIG-3b: 400 when window=91', async () => {
    const srv = await startServer(makeFullDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status } = await getJson(`${srv.baseUrl}/v1/admin/digest?window=91`, VALID_TOKEN);
    expect(status).toBe(400);
  });

  it('DIG-3c: default window=7 when omitted', async () => {
    const srv = await startServer(makeFullDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status, body } = await getJson(`${srv.baseUrl}/v1/admin/digest`, VALID_TOKEN);
    expect(status).toBe(200);
    const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['windowDays']).toBe(7);
  });

  // DIG-4: missing deps gracefully return null for their slice
  it('DIG-4: all optional deps absent → all slices null except shape keys', async () => {
    const minDeps: AdminRoutesDeps = {
      auditTrail: { verifyChain: () => ({ ok: true, rowsChecked: 0 }) },
      inspectionQueue: { query: () => [], updateStatus: () => { /* no-op */ } },
    };
    const srv = await startServer(minDeps, makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status, body } = await getJson(`${srv.baseUrl}/v1/admin/digest`, VALID_TOKEN);
    expect(status).toBe(200);
    const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['alignment']).toBeNull();
    expect(data['trust']).toBeNull();
    expect(data['calibration']).toBeNull();
    expect(data['commitments']).toBeNull();
    expect(data['epistemic']).toBeNull();
    expect(data['patterns']).toBeNull();
    expect(data['diagnostics']).toBeNull();
    expect(data['injection']).toBeNull();
    expect(data['reanchor']).toBeNull();
    expect(data['resolutions']).toBeNull();
  });

  // DIG-5: window param forwarded to deps
  it('DIG-5: window=14 is forwarded to calibration and patterns', async () => {
    const capturedCalibrationWindow: number[] = [];
    const capturedPatternsWindow: number[] = [];

    const deps = makeFullDeps({
      confidenceCalibrationTracker: {
        getReport: (opts) => {
          capturedCalibrationWindow.push(opts?.windowDays ?? -1);
          return {
            totalSamples: 5,
            brierScore: 0.1,
            overallAvgPredicted: 0.5,
            overallSuccessRate: 0.5,
            buckets: [],
            windowDays: opts?.windowDays ?? 7,
            computedAt: new Date().toISOString(),
          };
        },
      },
      mistakePatternRecognizer: {
        analyze: (opts) => {
          capturedPatternsWindow.push(opts?.windowDays ?? -1);
          return {
            totalMistakes: 0,
            uniquePatterns: 0,
            recurringPatterns: [],
            windowDays: opts?.windowDays ?? 7,
            analyzedAt: new Date().toISOString(),
          };
        },
      },
    });

    const srv = await startServer(deps, makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    await getJson(`${srv.baseUrl}/v1/admin/digest?window=14`, VALID_TOKEN);
    expect(capturedCalibrationWindow).toContain(14);
    expect(capturedPatternsWindow).toContain(14);
  });

  // DIG-6: per-slice isolation — one dep throwing does not 500 the whole digest
  it('DIG-6: one dep throwing returns null for that slice, rest still populated', async () => {
    const deps = makeFullDeps({
      confidenceCalibrationTracker: {
        getReport: () => { throw new Error('calibration DB down'); },
      },
    });

    const srv = await startServer(deps, makeTokenBuf(VALID_TOKEN));
    servers.push(srv);

    const { status, body } = await getJson(`${srv.baseUrl}/v1/admin/digest`, VALID_TOKEN);
    expect(status).toBe(200);
    const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
    // calibration threw → null
    expect(data['calibration']).toBeNull();
    // alignment still populated
    expect(data['alignment']).not.toBeNull();
    // trust still populated
    expect(data['trust']).not.toBeNull();
  });
});
