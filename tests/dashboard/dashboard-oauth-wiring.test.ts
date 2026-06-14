/**
 * @file tests/dashboard/dashboard-oauth-wiring.test.ts
 * @description #28b slice 4 — env-driven backend selector + end-to-end
 * activation. Proves the OAuth path actually FIRES from a real boot env
 * (not behind any feature flag): when SUDO_DASHBOARD_AUTH=nous and a key
 * is provided, an HTTP request with a valid JWT is authorized through the
 * full dispatcher; without the env, the basic Bearer backend is the one
 * making the call.
 *
 * **Hard-fail semantics:** explicit OAuth opt-in with missing/invalid
 * config MUST throw, not silently downgrade to basic. Tested below.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { selectDashboardAuthBackend } from '../../src/core/dashboard/select-auth-backend.js';
import {
  DashboardServer,
  registerDashboardGlobals,
} from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type { DashboardConfig } from '../../src/core/dashboard/dashboard-types.js';

const HS_SECRET = 'wire-test-secret';
const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RS_PUBLIC_PEM = RSA.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const RS_PRIVATE = RSA.privateKey;

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signHs256(payload: Record<string, unknown>, secret = HS_SECRET): string {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

function signRs256(payload: Record<string, unknown>): string {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const sig = signer.sign(RS_PRIVATE);
  return `${h}.${p}.${b64url(sig)}`;
}

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  delete g['__sudoBrain'];
  delete g['__sudoGateway'];
  delete g['__sudoAlignment'];
  delete g['__sudoAgentSwarm'];
  delete g['__sudoUpdater'];
  delete g['__sudoAudit'];
  delete g['__sudoAuthBackend'];
}

// ---------------------------------------------------------------------------
// selectDashboardAuthBackend — env-driven selector unit tests
// ---------------------------------------------------------------------------

describe('selectDashboardAuthBackend (env wiring)', () => {
  it('OW-01: env unset → undefined (caller wires default basic Bearer)', () => {
    expect(selectDashboardAuthBackend({})).toBeUndefined();
  });

  it('OW-02: SUDO_DASHBOARD_AUTH=basic → undefined', () => {
    expect(selectDashboardAuthBackend({ SUDO_DASHBOARD_AUTH: 'basic' })).toBeUndefined();
  });

  it('OW-03: case-insensitive — BASIC also returns undefined', () => {
    expect(selectDashboardAuthBackend({ SUDO_DASHBOARD_AUTH: 'BASIC' })).toBeUndefined();
  });

  it('OW-04: unknown auth mode → throws (operator typo, not silent fallback)', () => {
    expect(() => selectDashboardAuthBackend({ SUDO_DASHBOARD_AUTH: 'okta' })).toThrow(/not recognized/);
  });

  it('OW-05: SUDO_DASHBOARD_AUTH=nous + RS256 + PEM → live AuthBackend named oauth-nous', () => {
    const be = selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'RS256',
      SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM: RS_PUBLIC_PEM,
    });
    expect(be).toBeDefined();
    expect(be!.name).toBe('oauth-nous');
  });

  it('OW-06: SUDO_DASHBOARD_AUTH=nous WITHOUT a key → throws (hard-fail, not silent basic)', () => {
    expect(() => selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'RS256',
      // no PEM, no HMAC secret
    })).toThrow();
  });

  it('OW-07: SUDO_DASHBOARD_AUTH=self-hosted requires SUDO_DASHBOARD_OAUTH_ISSUER (env-named error)', () => {
    expect(() => selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'self-hosted',
      SUDO_DASHBOARD_OAUTH_ALG: 'HS256',
      SUDO_DASHBOARD_OAUTH_HMAC_SECRET: HS_SECRET,
      SUDO_DASHBOARD_OAUTH_AUDIENCE: 'sudo-ai',
    })).toThrow(/SUDO_DASHBOARD_OAUTH_ISSUER/);
  });

  it('OW-08: SUDO_DASHBOARD_AUTH=self-hosted with all required envs → live oauth-self-hosted backend', () => {
    const be = selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'self-hosted',
      SUDO_DASHBOARD_OAUTH_ALG: 'HS256',
      SUDO_DASHBOARD_OAUTH_HMAC_SECRET: HS_SECRET,
      SUDO_DASHBOARD_OAUTH_ISSUER: 'https://my-idp.test',
      SUDO_DASHBOARD_OAUTH_AUDIENCE: 'sudo-ai',
    });
    expect(be).toBeDefined();
    expect(be!.name).toBe('oauth-self-hosted');
  });

  it('OW-09: snake-case `self_hosted` is accepted (Hermes plugin path convention)', () => {
    const be = selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'self_hosted',
      SUDO_DASHBOARD_OAUTH_ALG: 'HS256',
      SUDO_DASHBOARD_OAUTH_HMAC_SECRET: HS_SECRET,
      SUDO_DASHBOARD_OAUTH_ISSUER: 'https://my-idp.test',
    });
    expect(be).toBeDefined();
    expect(be!.name).toBe('oauth-self-hosted');
  });

  it('OW-10: unsupported algorithm → throws', () => {
    expect(() => selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'ES256',
      SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM: RS_PUBLIC_PEM,
    })).toThrow(/ES256/);
  });

  it('OW-11: `\\n`-escaped PEM (docker-compose style) is normalized before construction', () => {
    const oneLine = RS_PUBLIC_PEM.replace(/\n/g, '\\n');
    expect(oneLine).not.toContain('\n');
    const be = selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'RS256',
      SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM: oneLine,
    });
    expect(be).toBeDefined();
    expect(be!.name).toBe('oauth-nous');
  });

  it('OW-12: HS256 selected + secret present → live backend (no PEM needed)', () => {
    const be = selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'HS256',
      SUDO_DASHBOARD_OAUTH_HMAC_SECRET: HS_SECRET,
    });
    expect(be).toBeDefined();
    expect(be!.name).toBe('oauth-nous');
  });

  it('OW-13: SUDO_DASHBOARD_AUTH set to empty string → undefined (same as unset)', () => {
    expect(selectDashboardAuthBackend({ SUDO_DASHBOARD_AUTH: '' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end activation — env → selector → registerDashboardGlobals →
// dispatcher → real HTTP request. Proves the OAuth path is wired through
// the real `DashboardServer.getAuthBackend()` lookup chain, NOT behind any
// flag beyond the env selector itself.
// ---------------------------------------------------------------------------

interface TestServer { baseUrl: string; close(): Promise<void> }

function startTestServer(): Promise<TestServer> {
  const cfg: DashboardConfig = {
    port: 0,
    authToken: 'should-not-be-used-by-oauth-test',
    refreshIntervalMs: 30000,
    loopbackTrust: false,
  };
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => {
      Promise.resolve(registerRoutes(req, res, server, cfg)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'test_dispatch_error', message: String(err) }));
        }
      });
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as import('node:net').AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: (): Promise<void> => new Promise((r, j) => httpServer.close((e) => (e ? j(e) : r()))),
      });
    });
    httpServer.on('error', reject);
  });
}

function rawGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('OAuth activation — env → selector → live dispatcher', () => {
  beforeEach(clearGlobals);
  afterEach(clearGlobals);

  it('OW-14: nous + RS256 env → JWT signed by configured key authorizes /api/stats (real activation, no flag)', async () => {
    const env: NodeJS.ProcessEnv = {
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'RS256',
      SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM: RS_PUBLIC_PEM,
      SUDO_DASHBOARD_OAUTH_ISSUER: 'https://auth.nousresearch.com',
      SUDO_DASHBOARD_OAUTH_AUDIENCE: 'sudo-ai-dashboard',
    };
    const backend = selectDashboardAuthBackend(env);
    expect(backend).toBeDefined();
    expect(backend!.name).toBe('oauth-nous');
    registerDashboardGlobals({ authBackend: backend });

    const srv = await startTestServer();
    try {
      const tok = signRs256({
        iss: 'https://auth.nousresearch.com',
        aud: 'sudo-ai-dashboard',
        sub: 'operator-1',
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const ok = await rawGet(`${srv.baseUrl}/api/stats`, { Authorization: `Bearer ${tok}` });
      expect(ok.status).toBe(200);

      // Sanity: the default Bearer token MUST NOT work — OAuth replaces it.
      const bearer = await rawGet(`${srv.baseUrl}/api/stats`, {
        Authorization: 'Bearer should-not-be-used-by-oauth-test',
      });
      expect(bearer.status).toBe(401);

      // Sanity: ?token= fallback also rejected (Bearer-only for OAuth).
      const query = await rawGet(`${srv.baseUrl}/api/stats?token=should-not-be-used-by-oauth-test`);
      expect(query.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('OW-15: self-hosted + HS256 env → HMAC-signed JWT authorizes /api/stats', async () => {
    const env: NodeJS.ProcessEnv = {
      SUDO_DASHBOARD_AUTH: 'self-hosted',
      SUDO_DASHBOARD_OAUTH_ALG: 'HS256',
      SUDO_DASHBOARD_OAUTH_HMAC_SECRET: HS_SECRET,
      SUDO_DASHBOARD_OAUTH_ISSUER: 'https://internal-idp.test',
      SUDO_DASHBOARD_OAUTH_AUDIENCE: 'sudo-ai',
    };
    const backend = selectDashboardAuthBackend(env);
    expect(backend!.name).toBe('oauth-self-hosted');
    registerDashboardGlobals({ authBackend: backend });

    const srv = await startTestServer();
    try {
      const tok = signHs256({
        iss: 'https://internal-idp.test',
        aud: 'sudo-ai',
        sub: 'operator-2',
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const r = await rawGet(`${srv.baseUrl}/api/stats`, { Authorization: `Bearer ${tok}` });
      expect(r.status).toBe(200);
    } finally { await srv.close(); }
  });

  it('OW-16: env unset → basic backend serves requests as before (regression guard)', async () => {
    const backend = selectDashboardAuthBackend({});
    expect(backend).toBeUndefined();
    // No registerDashboardGlobals call — the default BasicAuthBackend
    // constructed in DashboardServer's constructor handles auth.

    const srv = await startTestServer();
    try {
      const r = await rawGet(`${srv.baseUrl}/api/stats`, {
        Authorization: 'Bearer should-not-be-used-by-oauth-test',
      });
      expect(r.status).toBe(200);
    } finally { await srv.close(); }
  });

  it('OW-17: hard-fail — operator opts into nous but forgets the key → throws, no silent basic', () => {
    expect(() => selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'RS256',
      // forgot PEM
    })).toThrow();
  });

  it('OW-18: hard-fail — operator opts into self-hosted but forgets issuer → throws with env-named error', () => {
    expect(() => selectDashboardAuthBackend({
      SUDO_DASHBOARD_AUTH: 'self-hosted',
      SUDO_DASHBOARD_OAUTH_ALG: 'HS256',
      SUDO_DASHBOARD_OAUTH_HMAC_SECRET: HS_SECRET,
      // forgot SUDO_DASHBOARD_OAUTH_ISSUER
    })).toThrow(/SUDO_DASHBOARD_OAUTH_ISSUER/);
  });

  it('OW-19: PRODUCTION CHAIN — selectDashboardAuthBackend → registerDashboardGlobals → initDashboard → real JWT round-trip on /api/stats', async () => {
    // This is the EXACT call sequence src/cli.ts:2614-2654 + 2656 uses at
    // boot. If this test passes, the OAuth path is wired end-to-end through
    // the production entry point — not behind a feature flag, not behind a
    // build flag, not behind a config switch beyond the env vars themselves.
    const { initDashboard, shutdownDashboard } = await import('../../src/core/dashboard/dashboard-server.js');

    const env: NodeJS.ProcessEnv = {
      SUDO_DASHBOARD_AUTH: 'nous',
      SUDO_DASHBOARD_OAUTH_ALG: 'RS256',
      SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM: RS_PUBLIC_PEM,
      SUDO_DASHBOARD_OAUTH_ISSUER: 'https://auth.nousresearch.com',
      SUDO_DASHBOARD_OAUTH_AUDIENCE: 'sudo-ai-dashboard',
    };
    const oauthBackend = selectDashboardAuthBackend(env);
    expect(oauthBackend).toBeDefined();
    registerDashboardGlobals({ authBackend: oauthBackend });

    initDashboard({
      // Port 0 means OS-assigned; we then read it from the listener.
      port: 0,
      authToken: 'should-not-be-used-by-oauth-test',
      refreshIntervalMs: 30000,
      bindAddress: '127.0.0.1',
      loopbackTrust: false, // force auth on every request
    });

    // Find the actual bound port. `initDashboard` stashes the DashboardServer
    // singleton on the module; getDashboard() returns it.
    const { getDashboard } = await import('../../src/core/dashboard/dashboard-server.js');
    const ds = getDashboard();
    expect(ds).toBeDefined();
    // The HTTP server inside DashboardServer is private; we need its bound
    // port. Reach through `[server]` cast — same as the tests of slices 1/2.
    // `server.listen(0)` is async; poll briefly for the bound address.
    const internalServer = (ds as unknown as { server: http.Server | null }).server;
    expect(internalServer).not.toBeNull();
    let addr: import('node:net').AddressInfo | null = null;
    for (let i = 0; i < 50; i++) {
      const a = internalServer!.address();
      if (a && typeof a === 'object') { addr = a; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(addr).not.toBeNull();
    const baseUrl = `http://127.0.0.1:${addr!.port}`;

    try {
      const tok = signRs256({
        iss: 'https://auth.nousresearch.com',
        aud: 'sudo-ai-dashboard',
        sub: 'production-op',
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const ok = await rawGet(`${baseUrl}/api/stats`, { Authorization: `Bearer ${tok}` });
      expect(ok.status).toBe(200);

      // The "fallback Bearer" token MUST NOT authorize — proving OAuth is
      // actually replacing basic auth on the live dispatcher.
      const wrongBearer = await rawGet(`${baseUrl}/api/stats`, {
        Authorization: 'Bearer should-not-be-used-by-oauth-test',
      });
      expect(wrongBearer.status).toBe(401);
    } finally {
      shutdownDashboard();
    }
  });
});
