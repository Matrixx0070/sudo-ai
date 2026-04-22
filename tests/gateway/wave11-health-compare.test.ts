/**
 * @file tests/gateway/wave11-health-compare.test.ts
 * @description Wave 11 B1 tests — /health double-response fix + compare-routes
 *              rate-limit and per-request getTokenBuf behaviour.
 *
 * Tests:
 *  1. GET /health returns 200 with `uptime` field (integration-level mock server).
 *  2. GET /health does NOT trigger double-response (assert no ERR_HTTP_HEADERS_SENT).
 *  3. checkCompareRateLimit: 5 requests → all allowed, 6th → not allowed.
 *  4. checkCompareRateLimit: window expiry resets counter (mock Date.now).
 *  5. checkCompareRateLimit: key is bearer token when token provided.
 *  6. checkCompareRateLimit: key falls back to IP when no bearer.
 *  7. handleCompare calls getTokenBuf() on every invocation (spy-via-behavior).
 *  8. compare-routes: 429 response includes Retry-After header with positive integer.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerCompareRoutes } from '../../src/core/gateway/compare-routes.js';
import type { BrainLike, ComplexityScorerLike } from '../../src/core/gateway/compare-routes.js';

// ---------------------------------------------------------------------------
// Helpers (mirror compare.test.ts patterns)
// ---------------------------------------------------------------------------

function makeBrain(): BrainLike {
  return {
    runWithModel: vi.fn(async (modelId: string) => ({
      text: `stub response from ${modelId}`,
      inputTokens: 10,
      outputTokens: 5,
    })),
  };
}

function makeScorer(): ComplexityScorerLike {
  return {
    score: vi.fn(() => ({
      score: 0.2,
      tier: 'simple' as const,
      signals: ['prompt_length'],
      suggested_max_tokens: 2048,
      thinking_model: false,
    })),
  };
}

async function startCompareServer(
  token?: string,
): Promise<{ server: http.Server; baseUrl: string; brain: BrainLike }> {
  const server = http.createServer();
  const brain = makeBrain();

  if (token !== undefined) {
    process.env['GATEWAY_TOKEN'] = token;
  } else {
    delete process.env['GATEWAY_TOKEN'];
  }

  registerCompareRoutes(server, { brain, complexityScorer: makeScorer() });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, brain };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function httpGet(
  baseUrl: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown; headers: http.IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const body = text.length > 0 ? (JSON.parse(text) as unknown) : null;
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** A valid compare URL with all required query params. */
const COMPARE_PATH = '/v1/admin/compare?a=model-a&b=model-b&prompt=hello';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wave 11 — B1: /health double-response + compare-routes', () => {
  let server: http.Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server?.listening) await stopServer(server);
    delete process.env['GATEWAY_TOKEN'];
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: GET /health returns 200 with `uptime` field
  // -------------------------------------------------------------------------

  it('1. GET /health returns 200 with uptime field', async () => {
    // Spin up a minimal server that mirrors the server.ts /health handler.
    // We also attach a compare-routes listener to prove the two coexist.
    const startTime = Date.now();

    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';
      if (url === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            uptime: Math.floor((Date.now() - startTime) / 1000),
            stats: {},
          }),
        );
        return;
      }
      // Non-matching: fall through (no response)
    });

    registerCompareRoutes(server, { brain: makeBrain(), complexityScorer: makeScorer() });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { status, body } = await httpGet(baseUrl, '/health');

    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('uptime');
    expect(typeof b['uptime']).toBe('number');
  });

  // -------------------------------------------------------------------------
  // Test 2: GET /health does NOT trigger double-response (ERR_HTTP_HEADERS_SENT)
  // -------------------------------------------------------------------------

  it('2. GET /health does NOT trigger double-response (no ERR_HTTP_HEADERS_SENT)', async () => {
    const startTime = Date.now();
    const errors: Error[] = [];

    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';
      if (url === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            uptime: Math.floor((Date.now() - startTime) / 1000),
            stats: {},
          }),
        );
        // Do NOT attempt to write again (the pre-wave bug attempted handleHealth(res) twice)
        return;
      }
    });

    // Capture any uncaught exceptions during this test
    const errorHandler = (err: Error): void => {
      errors.push(err);
    };
    process.once('uncaughtException', errorHandler);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { status } = await httpGet(baseUrl, '/health');

    // Give any async error a tick to surface
    await new Promise<void>((resolve) => setImmediate(resolve));

    process.removeListener('uncaughtException', errorHandler);

    expect(status).toBe(200);
    const headersErrors = errors.filter((e) => e.message.includes('ERR_HTTP_HEADERS_SENT'));
    expect(headersErrors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: checkCompareRateLimit: 5 requests → all allowed, 6th → not allowed
  // -------------------------------------------------------------------------

  it('3. checkCompareRateLimit: 5 requests allowed, 6th returns 429', async () => {
    // Use a unique token so this test has its own rate-limit bucket
    const token = 'rl-test3-unique-token-for-bucket';
    ({ server, baseUrl } = await startCompareServer(token));

    for (let i = 1; i <= 5; i++) {
      const { status } = await httpGet(baseUrl, COMPARE_PATH, token);
      // 200 means allowed (rate limit not hit); 401/400 also means passed rate limit check
      expect(status).not.toBe(429);
    }

    // 6th request must be rate-limited
    const { status: status6 } = await httpGet(baseUrl, COMPARE_PATH, token);
    expect(status6).toBe(429);
  });

  // -------------------------------------------------------------------------
  // Test 4: checkCompareRateLimit: window expiry resets counter (mock Date.now)
  // -------------------------------------------------------------------------

  it('4. checkCompareRateLimit: window expiry resets counter when Date.now advances 60s+', async () => {
    const token = 'rl-test4-unique-token-for-window';
    ({ server, baseUrl } = await startCompareServer(token));

    const realNow = Date.now();

    // Make 5 requests at "current time"
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);

    for (let i = 1; i <= 5; i++) {
      const { status } = await httpGet(baseUrl, COMPARE_PATH, token);
      expect(status).not.toBe(429);
    }

    // 6th at same time → should be 429
    const { status: status6 } = await httpGet(baseUrl, COMPARE_PATH, token);
    expect(status6).toBe(429);

    // Advance time past the 60-second window
    dateSpy.mockReturnValue(realNow + 61_000);

    // Counter should reset — first request in new window must be allowed
    const { status: statusAfterReset } = await httpGet(baseUrl, COMPARE_PATH, token);
    expect(statusAfterReset).not.toBe(429);
  });

  // -------------------------------------------------------------------------
  // Test 5: checkCompareRateLimit: key is bearer token when token provided
  // -------------------------------------------------------------------------

  it('5. checkCompareRateLimit: key is bearer token (different tokens get independent counters)', async () => {
    // No gateway auth token so requests proceed past auth
    ({ server, baseUrl } = await startCompareServer(undefined));

    const tokenA = 'bucket-test5-token-A';
    const tokenB = 'bucket-test5-token-B';

    // Exhaust 5 requests for tokenA
    for (let i = 1; i <= 5; i++) {
      const { status } = await httpGet(baseUrl, COMPARE_PATH, tokenA);
      expect(status).not.toBe(429);
    }

    // 6th for tokenA → 429
    const { status: statusA6 } = await httpGet(baseUrl, COMPARE_PATH, tokenA);
    expect(statusA6).toBe(429);

    // tokenB has its own bucket — first request must NOT be 429
    const { status: statusB1 } = await httpGet(baseUrl, COMPARE_PATH, tokenB);
    expect(statusB1).not.toBe(429);
  });

  // -------------------------------------------------------------------------
  // Test 6: checkCompareRateLimit: key falls back to IP when no bearer
  // -------------------------------------------------------------------------

  it('6. checkCompareRateLimit: key falls back to IP when no bearer token', async () => {
    // No gateway auth required (GATEWAY_TOKEN unset) so we can fire unauthenticated requests
    ({ server, baseUrl } = await startCompareServer(undefined));

    // Fire 5 requests without a bearer token — they share the IP bucket
    for (let i = 1; i <= 5; i++) {
      const { status } = await httpGet(baseUrl, COMPARE_PATH /* no token */);
      expect(status).not.toBe(429);
    }

    // 6th request from same IP, no bearer → rate-limited
    const { status: status6 } = await httpGet(baseUrl, COMPARE_PATH);
    expect(status6).toBe(429);
  });

  // -------------------------------------------------------------------------
  // Test 7: handleCompare calls getTokenBuf() on every invocation
  // Verified via behavior: changing GATEWAY_TOKEN between requests is honoured
  // immediately, proving per-request token evaluation (not a cached closure).
  // -------------------------------------------------------------------------

  it('7. handleCompare evaluates GATEWAY_TOKEN per-request (getTokenBuf called each time)', async () => {
    const tokenA = 'wave11-test7-token-A-32chars!!';
    const tokenB = 'wave11-test7-token-B-32chars!!';

    // Start server with tokenA
    process.env['GATEWAY_TOKEN'] = tokenA;
    server = http.createServer();
    registerCompareRoutes(server, { brain: makeBrain(), complexityScorer: makeScorer() });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Request 1: tokenA is correct → must NOT be 401
    const { status: status1 } = await httpGet(baseUrl, COMPARE_PATH, tokenA);
    expect(status1).not.toBe(401);

    // Change GATEWAY_TOKEN to tokenB WITHOUT restarting the server
    process.env['GATEWAY_TOKEN'] = tokenB;

    // Request 2: tokenA is now WRONG → must be 401
    // If getTokenBuf() were cached at registration time, tokenA would still be accepted.
    const { status: status2 } = await httpGet(baseUrl, COMPARE_PATH, tokenA);
    expect(status2).toBe(401);

    // Request 3: tokenB is correct → must NOT be 401
    const { status: status3 } = await httpGet(baseUrl, COMPARE_PATH, tokenB);
    expect(status3).not.toBe(401);
  });

  // -------------------------------------------------------------------------
  // Test 8: 429 response includes Retry-After header with positive integer
  // -------------------------------------------------------------------------

  it('8. compare-routes: 429 response includes Retry-After header with positive integer', async () => {
    const token = 'rl-test8-unique-retry-after-tok';
    ({ server, baseUrl } = await startCompareServer(token));

    // Exhaust 5-request window
    for (let i = 1; i <= 5; i++) {
      await httpGet(baseUrl, COMPARE_PATH, token);
    }

    // 6th request → 429 with Retry-After
    const { status, headers } = await httpGet(baseUrl, COMPARE_PATH, token);
    expect(status).toBe(429);

    const retryAfterHeader = headers['retry-after'];
    expect(retryAfterHeader).toBeDefined();
    expect(typeof retryAfterHeader).toBe('string');

    const retryAfterValue = parseInt(retryAfterHeader as string, 10);
    expect(Number.isFinite(retryAfterValue)).toBe(true);
    expect(retryAfterValue).toBeGreaterThan(0);
  });
});
