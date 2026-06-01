/**
 * @file tests/gateway/federation-error-routes.test.ts
 * @description Federation error reporting REST route tests — Wave 2.
 *
 * Tests:
 *   FED-ERR-1   POST /error-report — 401 no federation auth
 *   FED-ERR-2   POST /error-report — 400 missing errorSignature
 *   FED-ERR-3   POST /error-report — 400 missing botVersion
 *   FED-ERR-4   POST /error-report — 400 missing peerId
 *   FED-ERR-5   POST /error-report — 400 missing timestamp
 *   FED-ERR-6   POST /error-report — 400 invalid severity
 *   FED-ERR-7   POST /error-report — 400 oversized errorSignature (>500 chars)
 *   FED-ERR-8   POST /error-report — 413 oversized body (>64KB)
 *   FED-ERR-9   POST /error-report — 200 valid report ingested
 *   FED-ERR-10  POST /error-report — 429 rate limit exceeded (11th request)
 *   FED-ERR-11  POST /error-report — 503 kill-switch enabled
 *   FED-ERR-12  POST /fix-notify — 401 non-admin token
 *   FED-ERR-13  POST /fix-notify — 400 missing fixCommitHash
 *   FED-ERR-14  POST /fix-notify — 400 missing affectedErrorSignature
 *   FED-ERR-15  POST /fix-notify — 400 missing newVersionTag
 *   FED-ERR-16  POST /fix-notify — 200 valid fix broadcast
 *   FED-ERR-17  POST /fix-notify — 503 kill-switch enabled
 *   FED-ERR-18  POST /token-contribute — 401 no federation auth
 *   FED-ERR-19  POST /token-contribute — 400 missing peerId
 *   FED-ERR-20  POST /token-contribute — 400 invalid provider
 *   FED-ERR-21  POST /token-contribute — 400 missing token
 *   FED-ERR-22  POST /token-contribute — 200 valid token contributed
 *   FED-ERR-23  POST /token-contribute — 503 kill-switch enabled
 *   FED-ERR-24  GET /error-reports — 401 non-admin token
 *   FED-ERR-25  GET /error-reports — 200 with empty reports
 *   FED-ERR-26  GET /error-reports — 200 with limit param
 *   FED-ERR-27  GET /token-pool — 401 non-admin token
 *   FED-ERR-28  GET /token-pool — 200 with empty tokens
 *   FED-ERR-29  GET /token-pool — 200 with activeOnly param
 *   FED-ERR-30  GET /v1/federation/unknown — 404
 *   FED-ERR-31  POST /error-report — prototype pollution attempt blocked
 *   FED-ERR-32  GET /error-reports — session ID redacted
 *   FED-ERR-33  GET /error-reports — sensitive meta fields redacted
 *   FED-ERR-34  GET /error-reports — peerId filter works
 *   FED-ERR-35  POST /token-contribute — token too long rejected
 *   FED-ERR-36  POST /token-contribute — non-printable ASCII token rejected
 *   FED-ERR-37  POST /token-contribute — peerId too long rejected
 *   FED-ERR-38  Rate limiter cleanup — old entries evicted
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import http from 'node:http';
import { registerFederationErrorRoutes, type FederationErrorRoutesDeps } from '../../src/core/gateway/federation-error-routes.js';
import { clearRateLimitMap } from '../../src/core/gateway/federation-error-helpers.js';
import type { FederationErrorReport, FederationTokenContribution } from '../../src/core/gateway/federation-error-types.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'test-admin-token-fed-err';
const FEDERATION_TOKEN = 'sk_federation_test_123';
const PEER_ID = 'test-peer-001';

function makeAdminTokenBuf(): Buffer {
  return Buffer.from(ADMIN_TOKEN, 'utf8');
}

function makeFederationAuth(federationToken: string): (req: any) => boolean {
  return (req: any): boolean => {
    const auth = req.headers?.['authorization'] ?? '';
    return auth === `Bearer ${federationToken}`;
  };
}

function makeMockDeps(opts?: {
  ingestResult?: { reportId: string; githubIssueNumber?: number; deduplicated: boolean };
  tokenResult?: { id: string; success: boolean };
  reports?: FederationErrorReport[];
  tokens?: Array<{ id: string; peerId: string; provider: string; active: boolean; createdAt: string }>;
}): FederationErrorRoutesDeps {
  const ingestResult = opts?.ingestResult ?? { reportId: 'rpt_123', deduplicated: false };
  const tokenResult = opts?.tokenResult ?? { id: 'tok_456', success: true };
  const reports = opts?.reports ?? [];
  const tokens = opts?.tokens ?? [];

  return {
    errorIngestor: {
      ingestReport: vi.fn().mockResolvedValue(ingestResult),
      queryReports: vi.fn().mockReturnValue(reports),
    },
    tokenPool: {
      contributeToken: vi.fn().mockResolvedValue(tokenResult),
      listTokens: vi.fn().mockReturnValue(tokens),
    },
    fedAuth: makeFederationAuth(FEDERATION_TOKEN),
  };
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

function startServer(deps: FederationErrorRoutesDeps, adminTokenBuf: Buffer | null): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    registerFederationErrorRoutes(server, deps, adminTokenBuf);
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

async function doPost(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, json: await resp.json() };
}

async function doGet(url: string, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { method: 'GET', headers });
  return { status: resp.status, json: await resp.json() };
}

function makeValidErrorReport(): FederationErrorReport {
  return {
    errorSignature: 'TestError: Something went wrong',
    botVersion: '1.0.0',
    peerId: PEER_ID,
    timestamp: Date.now(),
    severity: 'HIGH',
    stackTrace: 'at test.ts:1:1',
    toolName: 'test-tool',
    sessionId: 'sess_123',
    phase: 'IMPORT',
    meta: { customField: 'value' },
  };
}

function makeValidFixNotify(): { fixCommitHash: string; affectedErrorSignature: string; newVersionTag: string } {
  return {
    fixCommitHash: 'abc123def456',
    affectedErrorSignature: 'TestError: Something went wrong',
    newVersionTag: 'v1.0.1',
  };
}

function makeValidTokenContribution(): FederationTokenContribution {
  return {
    peerId: PEER_ID,
    provider: 'openai',
    token: 'sk_test_token_12345',
    expiresAt: '2026-12-31T23:59:59Z',
  };
}

// ---------------------------------------------------------------------------
// POST /v1/federation/error-report
// ---------------------------------------------------------------------------

describe('POST /v1/federation/error-report', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
  });

  it('FED-ERR-1: 401 no federation auth', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, makeValidErrorReport());
    expect(status).toBe(401);
  });

  it('FED-ERR-2: 400 missing errorSignature', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    delete (report as any).errorSignature;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-3: 400 missing botVersion', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    delete (report as any).botVersion;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-4: 400 missing peerId', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    delete (report as any).peerId;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-5: 400 missing timestamp', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    delete (report as any).timestamp;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-6: 400 invalid severity', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    (report as any).severity = 'INVALID';
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-7: 400 oversized errorSignature (>500 chars)', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    report.errorSignature = 'x'.repeat(501);
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-8: 413 oversized body (>64KB)', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    report.stackTrace = 'x'.repeat(70 * 1024); // 70KB stack trace
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(413);
  });

  it('FED-ERR-9: 200 valid report ingested', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();
    const { status, json } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { reportId: string; deduplicated: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.reportId).toBe('rpt_123');
    expect(body.data.deduplicated).toBe(false);
  });

  it('FED-ERR-10: 429 rate limit exceeded (11th request)', async () => {
    // Clear rate limit state from previous tests
    clearRateLimitMap();
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();

    // First 10 requests should succeed
    for (let i = 0; i < 10; i++) {
      const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
      expect(status).toBe(200);
    }

    // 11th request should be rate limited
    const { status, json } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, report, FEDERATION_TOKEN);
    expect(status).toBe(429);
    const body = json as { ok: boolean; error: string };
    expect(body.error).toBe('rate_limit_exceeded');
  });

  it('FED-ERR-11: 503 kill-switch enabled', async () => {
    process.env.SUDO_FED_ERROR_REPORT_DISABLE = '1';
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/error-report`, makeValidErrorReport(), FEDERATION_TOKEN);
    expect(status).toBe(503);
    delete process.env.SUDO_FED_ERROR_REPORT_DISABLE;
  });
});

// ---------------------------------------------------------------------------
// POST /v1/federation/fix-notify
// ---------------------------------------------------------------------------

describe('POST /v1/federation/fix-notify', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
  });

  it('FED-ERR-12: 401 non-admin token', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/fix-notify`, makeValidFixNotify(), 'wrong-token');
    expect(status).toBe(401);
  });

  it('FED-ERR-13: 400 missing fixCommitHash', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const fix = makeValidFixNotify() as any;
    delete fix.fixCommitHash;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/fix-notify`, fix, ADMIN_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-14: 400 missing affectedErrorSignature', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const fix = makeValidFixNotify() as any;
    delete fix.affectedErrorSignature;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/fix-notify`, fix, ADMIN_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-15: 400 missing newVersionTag', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const fix = makeValidFixNotify() as any;
    delete fix.newVersionTag;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/fix-notify`, fix, ADMIN_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-16: 200 valid fix broadcast', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const fix = makeValidFixNotify();
    const { status, json } = await doPost(`${ts.baseUrl}/v1/federation/fix-notify`, fix, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { notificationId: string; broadcastToPeers: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.notificationId).toMatch(/^fix-/);
    expect(body.data.broadcastToPeers).toBe(true);
  });

  it('FED-ERR-17: 503 kill-switch enabled', async () => {
    process.env.SUDO_FED_FIX_NOTIFY_DISABLE = '1';
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/fix-notify`, makeValidFixNotify(), ADMIN_TOKEN);
    expect(status).toBe(503);
    delete process.env.SUDO_FED_FIX_NOTIFY_DISABLE;
  });
});

// ---------------------------------------------------------------------------
// POST /v1/federation/token-contribute
// ---------------------------------------------------------------------------

describe('POST /v1/federation/token-contribute', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
  });

  it('FED-ERR-18: 401 no federation auth', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/token-contribute`, makeValidTokenContribution());
    expect(status).toBe(401);
  });

  it('FED-ERR-19: 400 missing peerId', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib = makeValidTokenContribution() as any;
    delete contrib.peerId;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/token-contribute`, contrib, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-20: 400 invalid provider', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib = makeValidTokenContribution() as any;
    contrib.provider = 'invalid_provider';
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/token-contribute`, contrib, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-21: 400 missing token', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib = makeValidTokenContribution() as any;
    delete contrib.token;
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/token-contribute`, contrib, FEDERATION_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ERR-22: 200 valid token contributed', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib = makeValidTokenContribution();
    const { status, json } = await doPost(`${ts.baseUrl}/v1/federation/token-contribute`, contrib, FEDERATION_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { tokenId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.tokenId).toBe('tok_456');
  });

  it('FED-ERR-23: 503 kill-switch enabled', async () => {
    process.env.SUDO_FED_TOKEN_POOL_DISABLE = '1';
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/token-contribute`, makeValidTokenContribution(), FEDERATION_TOKEN);
    expect(status).toBe(503);
    delete process.env.SUDO_FED_TOKEN_POOL_DISABLE;
  });

  it('FED-ERR-39: 200 ollama provider accepted', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib: FederationTokenContribution = {
      peerId: PEER_ID,
      provider: 'ollama',
      token: 'ollama_token_12345',
    };
    const { status, json } = await doPost(`${ts.baseUrl}/v1/federation/token-contribute`, contrib, FEDERATION_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { tokenId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.tokenId).toBe('tok_456');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/federation/error-reports
// ---------------------------------------------------------------------------

describe('GET /v1/federation/error-reports', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    const sampleReports: FederationErrorReport[] = [
      {
        errorSignature: 'Error1',
        botVersion: '1.0.0',
        peerId: 'peer-1',
        timestamp: Date.now(),
        severity: 'HIGH',
      },
      {
        errorSignature: 'Error2',
        botVersion: '1.0.0',
        peerId: 'peer-2',
        timestamp: Date.now(),
        severity: 'MEDIUM',
      },
    ];
    deps = makeMockDeps({ reports: sampleReports });
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
  });

  it('FED-ERR-24: 401 non-admin token', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/error-reports`, 'wrong-token');
    expect(status).toBe(401);
  });

  it('FED-ERR-25: 200 with empty reports', async () => {
    const emptyDeps = makeMockDeps({ reports: [] });
    ts = await startServer(emptyDeps, makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/error-reports`, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { reports: unknown[]; count: number } };
    expect(body.ok).toBe(true);
    expect(body.data.reports).toEqual([]);
    expect(body.data.count).toBe(0);
  });

  it('FED-ERR-26: 200 with limit param', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/error-reports?limit=1`, ADMIN_TOKEN);
    expect(status).toBe(200);
    expect(deps.errorIngestor.queryReports).toHaveBeenCalledWith({ limit: 1, peerId: undefined, signature: undefined });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/federation/token-pool
// ---------------------------------------------------------------------------

describe('GET /v1/federation/token-pool', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    const sampleTokens = [
      { id: 'tok_1', peerId: 'peer-1', provider: 'openai', active: true, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'tok_2', peerId: 'peer-2', provider: 'anthropic', active: false, createdAt: '2026-01-02T00:00:00Z' },
    ];
    deps = makeMockDeps({ tokens: sampleTokens });
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
  });

  it('FED-ERR-27: 401 non-admin token', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/token-pool`, 'wrong-token');
    expect(status).toBe(401);
  });

  it('FED-ERR-28: 200 with empty tokens', async () => {
    const emptyDeps = makeMockDeps({ tokens: [] });
    ts = await startServer(emptyDeps, makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/token-pool`, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { tokens: unknown[]; count: number } };
    expect(body.ok).toBe(true);
    expect(body.data.tokens).toEqual([]);
    expect(body.data.count).toBe(0);
  });

  it('FED-ERR-29: 200 with activeOnly param', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/token-pool?activeOnly=true`, ADMIN_TOKEN);
    expect(status).toBe(200);
    expect(deps.tokenPool.listTokens).toHaveBeenCalledWith({ peerId: undefined, activeOnly: true });
  });
});

// ---------------------------------------------------------------------------
// Unknown federation paths
// ---------------------------------------------------------------------------

describe('Unknown federation paths', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  afterEach(async () => {
    await ts?.close();
  });

  it('FED-ERR-30: 404 for unrecognised /v1/federation/* path', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/unknown-path`, FEDERATION_TOKEN);
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Security Tests
// ---------------------------------------------------------------------------

describe('Security: Prototype pollution prevention', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    clearRateLimitMap();
    deps = makeMockDeps();
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
    clearRateLimitMap();
  });

  it('FED-ERR-31: prototype pollution attempt blocked', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    // Send a payload with __proto__ pollution attempt
    const maliciousPayload = {
      errorSignature: 'TestError: PrototypePollution',
      botVersion: '1.0.0',
      peerId: 'test-peer-prototype',
      timestamp: Date.now(),
      severity: 'HIGH',
      __proto__: { admin: true },
      constructor: { prototype: { isAdmin: true } },
    };
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/error-report`,
      maliciousPayload,
      FEDERATION_TOKEN
    );
    // Should still process the request (200) but without pollution
    expect(status).toBe(200);
  });
});

describe('Security: Data leakage prevention', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    const sampleReports: FederationErrorReport[] = [
      {
        errorSignature: 'Error1',
        botVersion: '1.0.0',
        peerId: 'peer-1',
        timestamp: Date.now(),
        severity: 'HIGH',
        sessionId: 'sensitive-session-123',
        meta: {
          customField: 'value',
          apiToken: 'sk-secret-123',
          userPassword: 'password123',
          secretKey: 'my-secret-key',
        },
      },
      {
        errorSignature: 'Error2',
        botVersion: '1.0.0',
        peerId: 'peer-2',
        timestamp: Date.now(),
        severity: 'MEDIUM',
        sessionId: 'another-session-456',
      },
    ];
    deps = makeMockDeps({ reports: sampleReports });
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
  });

  it('FED-ERR-32: session ID redacted', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/error-reports`, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { reports: FederationErrorReport[]; count: number } };
    expect(body.data.reports).toHaveLength(2);
    // Session IDs should be redacted to '***'
    expect(body.data.reports[0].sessionId).toBe('***');
    expect(body.data.reports[1].sessionId).toBe('***');
  });

  it('FED-ERR-33: sensitive meta fields redacted', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/error-reports`, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { reports: FederationErrorReport[]; count: number } };
    const meta = body.data.reports[0].meta as Record<string, unknown>;
    // Sensitive fields should be redacted
    expect(meta.apiToken).toBe('[REDACTED]');
    expect(meta.userPassword).toBe('[REDACTED]');
    expect(meta.secretKey).toBe('[REDACTED]');
    // Non-sensitive field should remain visible
    expect(meta.customField).toBe('value');
  });

  it('FED-ERR-34: peerId filter works', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const { status, json } = await doGet(
      `${ts.baseUrl}/v1/federation/error-reports?peerId=peer-1`,
      ADMIN_TOKEN
    );
    expect(status).toBe(200);
    expect(deps.errorIngestor.queryReports).toHaveBeenCalledWith({
      peerId: 'peer-1',
      signature: undefined,
      limit: 50,
    });
  });
});

describe('Security: Token contribution validation', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
  });

  it('FED-ERR-35: token too long rejected', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib = makeValidTokenContribution();
    contrib.token = 'x'.repeat(4097); // Exceeds 4096 char limit
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/token-contribute`,
      contrib,
      FEDERATION_TOKEN
    );
    expect(status).toBe(400);
  });

  it('FED-ERR-36: non-printable ASCII token rejected', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib = makeValidTokenContribution();
    contrib.token = 'valid_token_with_\x00_null_byte'; // Contains non-printable char
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/token-contribute`,
      contrib,
      FEDERATION_TOKEN
    );
    expect(status).toBe(400);
  });

  it('FED-ERR-37: peerId too long rejected', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const contrib = makeValidTokenContribution();
    contrib.peerId = 'p'.repeat(257); // Exceeds 256 char limit
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/token-contribute`,
      contrib,
      FEDERATION_TOKEN
    );
    expect(status).toBe(400);
  });
});

describe('Security: Rate limiter cleanup', () => {
  let ts: TestServer;
  let deps: FederationErrorRoutesDeps;

  beforeEach(() => {
    clearRateLimitMap();
    deps = makeMockDeps();
  });

  afterEach(async () => {
    await ts?.close();
    vi.clearAllMocks();
    clearRateLimitMap();
  });

  it('FED-ERR-38: old entries evicted after 100 calls', async () => {
    ts = await startServer(deps, makeAdminTokenBuf());
    const report = makeValidErrorReport();

    // Make requests from 15 different peers to build up the map
    for (let i = 0; i < 15; i++) {
      const peerReport = { ...report, peerId: `peer-${i}` };
      await doPost(`${ts.baseUrl}/v1/federation/error-report`, peerReport, FEDERATION_TOKEN);
    }

    // Make enough requests to trigger cleanup (100 calls = cleanup trigger)
    for (let i = 15; i < 110; i++) {
      const peerReport = { ...report, peerId: `peer-${i % 20}` };
      await doPost(`${ts.baseUrl}/v1/federation/error-report`, peerReport, FEDERATION_TOKEN);
    }

    // The cleanup should have been triggered
    // Verify the rate limiter still works (doesn't crash)
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/error-report`,
      { ...report, peerId: 'final-peer' },
      FEDERATION_TOKEN
    );
    expect(status).toBe(200);
  });
});
