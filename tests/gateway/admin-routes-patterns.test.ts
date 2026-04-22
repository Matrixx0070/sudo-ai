/**
 * @file tests/gateway/admin-routes-patterns.test.ts
 * @description Wave 6K: GET /v1/admin/patterns endpoint tests.
 *
 * Tests:
 *   1. 200 with correct shape when recognizer present.
 *   2. 503 when recognizer absent.
 *   3. 401 when bearer token is missing/invalid.
 *   4. 400 when window param is out of range.
 *   5. 400 when minOccurrences param is out of range.
 *   6. 400 when limit param is out of range.
 *   7. Signatures truncated to ≤200 chars in response.
 *   8. limit param reduces returned patterns.
 *   9. 500 when analyze() throws.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-patterns-token-xyz';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

interface MockPattern {
  signatureHash: string;
  signature: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  tags: string[];
}

function makePattern(overrides: Partial<MockPattern> = {}): MockPattern {
  return {
    signatureHash: 'abc123',
    signature: 'test mistake pattern',
    occurrences: 3,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    tags: ['commitment-test'],
    ...overrides,
  };
}

function makeMockRecognizer(
  patterns: MockPattern[] = [makePattern()],
  totalMistakes = 10,
): NonNullable<AdminRoutesDeps['mistakePatternRecognizer']> {
  return {
    analyze: () => ({
      totalMistakes,
      uniquePatterns: patterns.length,
      recurringPatterns: patterns,
      windowDays: 30,
      analyzedAt: new Date().toISOString(),
    }),
  };
}

function buildBaseDeps(
  recognizer?: AdminRoutesDeps['mistakePatternRecognizer'],
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
    mistakePatternRecognizer: recognizer,
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

describe('GET /v1/admin/patterns', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  // -------------------------------------------------------------------------
  // 1. 200 with correct shape
  // -------------------------------------------------------------------------
  it('returns 200 with patterns/totalMistakes/uniquePatterns/window/analyzedAt when recognizer present', async () => {
    const recognizer = makeMockRecognizer([makePattern({ signatureHash: 'hash1', occurrences: 5 })], 15);
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as {
      ok: boolean;
      data: {
        patterns: MockPattern[];
        totalMistakes: number;
        uniquePatterns: number;
        window: number;
        analyzedAt: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.patterns)).toBe(true);
    expect(body.data.totalMistakes).toBe(15);
    expect(body.data.uniquePatterns).toBe(1);
    expect(body.data.window).toBe(30);
    expect(typeof body.data.analyzedAt).toBe('string');
    expect(body.data.patterns[0]?.occurrences).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 2. 503 when recognizer absent
  // -------------------------------------------------------------------------
  it('returns 503 when mistakePatternRecognizer is not configured', async () => {
    ts = await startServer(buildBaseDeps(/* no recognizer */), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns`, VALID_TOKEN);

    expect(status).toBe(503);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('mistake pattern recognizer not configured');
  });

  // -------------------------------------------------------------------------
  // 3. 401 when bearer token is missing
  // -------------------------------------------------------------------------
  it('returns 401 when bearer token is absent', async () => {
    const recognizer = makeMockRecognizer();
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/patterns`, /* no token */ null);
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 4. 400 window out of range
  // -------------------------------------------------------------------------
  it('returns 400 when window param is 0 (below min of 1)', async () => {
    const recognizer = makeMockRecognizer();
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns?window=0`, VALID_TOKEN);

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/window/);
  });

  it('returns 400 when window param exceeds 365', async () => {
    const recognizer = makeMockRecognizer();
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns?window=400`, VALID_TOKEN);

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/window/);
  });

  // -------------------------------------------------------------------------
  // 5. 400 minOccurrences out of range
  // -------------------------------------------------------------------------
  it('returns 400 when minOccurrences param is 0 (below min of 1)', async () => {
    const recognizer = makeMockRecognizer();
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns?minOccurrences=0`, VALID_TOKEN);

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/minOccurrences/);
  });

  it('returns 400 when minOccurrences param exceeds 100', async () => {
    const recognizer = makeMockRecognizer();
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns?minOccurrences=101`, VALID_TOKEN);

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/minOccurrences/);
  });

  // -------------------------------------------------------------------------
  // 6. 400 limit out of range
  // -------------------------------------------------------------------------
  it('returns 400 when limit param is 0 (below min of 1)', async () => {
    const recognizer = makeMockRecognizer();
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns?limit=0`, VALID_TOKEN);

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/limit/);
  });

  it('returns 400 when limit param exceeds 200', async () => {
    const recognizer = makeMockRecognizer();
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns?limit=201`, VALID_TOKEN);

    expect(status).toBe(400);
    const body = json as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/limit/);
  });

  // -------------------------------------------------------------------------
  // 7. Signatures truncated to ≤200 chars
  // -------------------------------------------------------------------------
  it('truncates signatures to 200 characters in the response', async () => {
    const longSig = 'a'.repeat(500);
    const recognizer = makeMockRecognizer([makePattern({ signature: longSig })]);
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { patterns: Array<{ signature: string }> } };
    expect(body.data.patterns[0]?.signature.length).toBeLessThanOrEqual(200);
  });

  // -------------------------------------------------------------------------
  // 8. limit param slices returned patterns
  // -------------------------------------------------------------------------
  it('respects the limit query param', async () => {
    const patterns = Array.from({ length: 10 }, (_, i) =>
      makePattern({ signatureHash: `hash${i}`, signature: `pattern ${i}` }),
    );
    const recognizer = makeMockRecognizer(patterns, 10);
    ts = await startServer(buildBaseDeps(recognizer), makeTokenBuf(VALID_TOKEN));
    const { status, json } = await doGet(`${ts.baseUrl}/v1/admin/patterns?limit=3`, VALID_TOKEN);

    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { patterns: unknown[] } };
    expect(body.data.patterns).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 9. 500 when analyze() throws
  // -------------------------------------------------------------------------
  it('returns 500 when analyze() throws', async () => {
    const throwingRecognizer: NonNullable<AdminRoutesDeps['mistakePatternRecognizer']> = {
      analyze: () => { throw new Error('DB error'); },
    };
    ts = await startServer(buildBaseDeps(throwingRecognizer), makeTokenBuf(VALID_TOKEN));
    const { status } = await doGet(`${ts.baseUrl}/v1/admin/patterns`, VALID_TOKEN);
    expect(status).toBe(500);
  });
});
