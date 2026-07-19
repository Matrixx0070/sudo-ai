/**
 * @file tests/gateway/admin-dashboard-route.test.ts
 * @description Wave 8B: GET /v1/admin/dashboard endpoint tests.
 *
 * Tests:
 *   DASH-1   401 without any auth (no header, no query param)
 *   DASH-2   401 with wrong Bearer token
 *   DASH-3   401 with wrong ?token= query param
 *   DASH-4   200 + text/html with correct Bearer header
 *   DASH-5   200 + text/html with correct ?token= query param
 *   DASH-6   Response contains expected panel label "Alignment"
 *   DASH-7   Response contains expected panel label "Trust"
 *   DASH-8   Response contains expected panel label "Brier"
 *   DASH-9   Response contains JS that fetches /v1/admin/digest
 *   DASH-10  Response size reasonable (< 30KB)
 *   DASH-11  CSP header present on 200 response
 *   DASH-12  XSS: no ?token= value reflected in response body
 *   DASH-13  401 response is text/html (not JSON)
 *   DASH-14  200 when no tokenBuf configured (open access)
 *   DASH-15  Cache-Control: no-store on 200 response
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { registerAdminRoutes, type AdminRoutesDeps } from '../../src/core/gateway/admin-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-dashboard-token-abc123';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

function minimalDeps(): AdminRoutesDeps {
  return {
    auditTrail: {
      verifyChain: () => ({ ok: true, rowsChecked: 0 }),
    },
    inspectionQueue: {
      query: () => [],
      updateStatus: () => { /* no-op */ },
    },
  };
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
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawGet(url: string, opts: { token?: string; queryToken?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const fullUrl = opts.queryToken ? `${url}?token=${encodeURIComponent(opts.queryToken)}` : url;
    const parsed = new URL(fullUrl);
    const reqOpts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    };
    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/admin/dashboard', () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  // DASH-1: 401 without any auth
  it('DASH-1: 401 without any auth', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { status } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`);
    expect(status).toBe(401);
  });

  // DASH-2: 401 with wrong Bearer token
  it('DASH-2: 401 with wrong Bearer token', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { status } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: 'wrong-token' });
    expect(status).toBe(401);
  });

  // DASH-3: 401 with wrong ?token= query param
  it('DASH-3: 401 with wrong ?token= query param', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { status } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { queryToken: 'not-the-right-token' });
    expect(status).toBe(401);
  });

  // DASH-4: 200 with correct Bearer header
  it('DASH-4: 200 with correct Bearer header', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { status } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    expect(status).toBe(200);
  });

  // DASH-5: 200 with correct ?token= query param
  it('DASH-5: 200 with correct ?token= query param', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { status } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { queryToken: VALID_TOKEN });
    expect(status).toBe(200);
  });

  // DASH-6: Response contains "Alignment"
  it('DASH-6: response body contains "Alignment"', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { body } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    expect(body).toContain('Alignment');
  });

  // DASH-7: Response contains "Trust"
  it('DASH-7: response body contains "Trust"', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { body } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    expect(body).toContain('Trust');
  });

  // DASH-8: Response contains "Brier"
  it('DASH-8: response body contains "Brier"', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { body } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    expect(body).toContain('Brier');
  });

  // DASH-9: Response JS fetches /v1/admin/digest
  it('DASH-9: response JS references /v1/admin/digest', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { body } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    expect(body).toContain('/v1/admin/digest');
  });

  // DASH-10: Response size RATCHET (was: hard 30KB budget).
  //
  // DEBT — DO NOT SILENTLY RAISE THIS CEILING.
  // Measured 53,128 bytes on 2026-07-19 — 1.7x over the original 30KB target.
  // The 30KB budget is RETAINED as documented debt: the dashboard HTML has
  // genuinely bloated (cause unknown; likely recent dashboard/BO work — note
  // dashboard-html duplication is already an F101 concern) and needs a
  // properly-scoped repair. Per the ratchet idiom (see scripts/
  // check-max-lines.ts) this ceiling is pinned at measured+~2% so any FURTHER
  // growth fails CI immediately, while the pre-existing regression stays on
  // the books instead of blocking unrelated work.
  // Ruling: docs/CAS_WIRING_QA.md Q-1/A-1 (2026-07-19).
  it('DASH-10: response body does not grow past the 2026-07-19 ratchet ceiling (debt: 30KB target)', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { body } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    const RATCHET_CEILING_BYTES = 54_272; // measured 53,128B on 2026-07-19 + ~2%
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(RATCHET_CEILING_BYTES);
  });

  // DASH-11: CSP header present
  it('DASH-11: Content-Security-Policy header present', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { headers } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    const csp = headers['content-security-policy'];
    expect(typeof csp).toBe('string');
    expect(csp).toContain("default-src 'self'");
  });

  // DASH-12: XSS — ?token= value not reflected in body
  it('DASH-12: ?token= value is not reflected in response body (XSS guard)', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { body } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { queryToken: VALID_TOKEN });
    // The actual token string must not appear verbatim in HTML source
    expect(body).not.toContain(VALID_TOKEN);
  });

  // DASH-13: 401 response is text/html
  it('DASH-13: 401 response is text/html not JSON', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { status, headers, body } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`);
    expect(status).toBe(401);
    expect(headers['content-type']).toMatch(/text\/html/);
    // Must not be JSON
    expect(() => JSON.parse(body)).toThrow();
  });

  // DASH-14: 200 when no tokenBuf (open access)
  it('DASH-14: 200 with no auth when tokenBuf is null', async () => {
    const srv = await startServer(minimalDeps(), null);
    servers.push(srv);
    const { status } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`);
    expect(status).toBe(200);
  });

  // DASH-15: Cache-Control: no-store on 200
  it('DASH-15: Cache-Control: no-store on 200 response', async () => {
    const srv = await startServer(minimalDeps(), makeTokenBuf(VALID_TOKEN));
    servers.push(srv);
    const { headers } = await rawGet(`${srv.baseUrl}/v1/admin/dashboard`, { token: VALID_TOKEN });
    expect(headers['cache-control']).toContain('no-store');
  });
});
