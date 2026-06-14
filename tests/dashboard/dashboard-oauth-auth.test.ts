/**
 * @file tests/dashboard/dashboard-oauth-auth.test.ts
 * @description #28b slice 4 — OAuth/JWT AuthBackend (Hermes nous/self-hosted
 * parity). Unit tests for the JWT verifier + integration tests through the
 * async route dispatcher, covering: valid HS256/RS256, expired/nbf/iat,
 * iss/aud mismatch, bad signature, alg-confusion defense, missing Bearer,
 * scope claim, promise-rejection-as-denial, the self-hosted no-iss
 * footgun guard, and the basic backend's untouched-on-sync path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import {
  DashboardServer,
  registerDashboardGlobals,
  createOAuthJwtBackend,
  createNousAuthBackend,
  createSelfHostedAuthBackend,
} from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type { DashboardConfig, AuthBackend } from '../../src/core/dashboard/dashboard-types.js';

// ---------------------------------------------------------------------------
// Test fixtures — sign tokens locally so the test is self-contained.
// ---------------------------------------------------------------------------

const HS_SECRET = 'shared-secret-for-tests';

const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RS_PUBLIC_PEM = RSA.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const RS_PRIVATE = RSA.privateKey;

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signHs256(payload: Record<string, unknown>, secret = HS_SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

function signRs256(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const sig = signer.sign(RS_PRIVATE);
  return `${h}.${p}.${b64url(sig)}`;
}

/** Build a fake IncomingMessage that satisfies the AuthBackend contract. */
function fakeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  // The backend reads `headers.authorization` only; the rest is ignored.
  return { headers } as unknown as http.IncomingMessage;
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
// Unit: createOAuthJwtBackend — HS256
// ---------------------------------------------------------------------------

describe('createOAuthJwtBackend (HS256)', () => {
  const baseOpts = {
    name: 'oauth-test',
    algorithm: 'HS256' as const,
    hmacSecret: HS_SECRET,
    expectedIssuer: 'https://idp.test',
    expectedAudience: 'sudo-ai',
    now: () => 1_000_000,
  };

  it('OA-01: rejects construction without hmacSecret', () => {
    expect(() => createOAuthJwtBackend({ ...baseOpts, hmacSecret: undefined })).toThrow();
  });

  it('OA-02: rejects construction with unsupported algorithm', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createOAuthJwtBackend({ ...baseOpts, algorithm: 'ES256' as any })).toThrow();
  });

  it('OA-03: valid HS256 token → ok + principal includes sub', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth:alice' });
  });

  it('OA-04: missing Bearer → missing_bearer_token', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const res = await be.authenticate(fakeReq({}), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'missing_bearer_token' });
  });

  it('OA-05: empty Bearer → empty_bearer_token', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const res = await be.authenticate(fakeReq({ authorization: 'Bearer    ' }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'empty_bearer_token' });
  });

  it('OA-06: malformed JWT (not three segments) → malformed_jwt', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const res = await be.authenticate(fakeReq({ authorization: 'Bearer not.a.jwt.really' }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'malformed_jwt' });
  });

  it('OA-07: alg=none → alg_mismatch (header alg checked strictly)', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256(
      { iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100 },
      HS_SECRET,
      { alg: 'none', typ: 'JWT' },
    );
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'alg_mismatch' });
  });

  it('OA-08: HS256 backend with RS256-headed token → alg_mismatch (alg-confusion defense)', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    // Forge an RS256-headed token with an HMAC signature using the secret.
    const tok = signHs256(
      { iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100 },
      HS_SECRET,
      { alg: 'RS256', typ: 'JWT' },
    );
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'alg_mismatch' });
  });

  it('OA-09: bad signature → bad_signature', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256(
      { iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100 },
      'wrong-secret',
    );
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('OA-10: iss mismatch → iss_mismatch', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256({ iss: 'https://evil.example', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'iss_mismatch' });
  });

  it('OA-11: aud mismatch (string) → aud_mismatch', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256({ iss: 'https://idp.test', aud: 'other-app', sub: 'alice', exp: 1_000_100 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'aud_mismatch' });
  });

  it('OA-12: aud as array including expected → ok', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256({ iss: 'https://idp.test', aud: ['other', 'sudo-ai'], sub: 'alice', exp: 1_000_100 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth:alice' });
  });

  it('OA-13: expired → expired (outside skew)', async () => {
    const be = createOAuthJwtBackend({ ...baseOpts, clockSkewSec: 0 });
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 999_999 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('OA-14: expired but within skew → ok', async () => {
    const be = createOAuthJwtBackend({ ...baseOpts, clockSkewSec: 60 });
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 999_950 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth:alice' });
  });

  it('OA-15: exp missing → exp_missing', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice' });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'exp_missing' });
  });

  it('OA-16: nbf in future → not_yet_valid', async () => {
    const be = createOAuthJwtBackend({ ...baseOpts, clockSkewSec: 0 });
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100, nbf: 1_000_500 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'not_yet_valid' });
  });

  it('OA-17: iat in future (outside skew) → iat_in_future', async () => {
    const be = createOAuthJwtBackend({ ...baseOpts, clockSkewSec: 0 });
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100, iat: 1_000_500 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'iat_in_future' });
  });

  it('OA-18: sub missing → sub_missing', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', exp: 1_000_100 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'sub_missing' });
  });

  it('OA-19: requiredScope present via `scope` string → ok', async () => {
    const be = createOAuthJwtBackend({ ...baseOpts, requiredScope: 'admin' });
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100, scope: 'read admin write' });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth:alice' });
  });

  it('OA-20: requiredScope present via `scp` array → ok', async () => {
    const be = createOAuthJwtBackend({ ...baseOpts, requiredScope: 'admin' });
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100, scp: ['read', 'admin'] });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth:alice' });
  });

  it('OA-21: requiredScope absent → scope_missing', async () => {
    const be = createOAuthJwtBackend({ ...baseOpts, requiredScope: 'admin' });
    const tok = signHs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'alice', exp: 1_000_100, scope: 'read write' });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'scope_missing' });
  });

  it('OA-22: ?token= query fallback is ignored (Bearer-only)', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    // No Authorization header — even with allowQueryToken=true the OAuth
    // backend must refuse (URLs leak JWTs into access logs).
    const res = await be.authenticate(fakeReq({}), { allowQueryToken: true });
    expect(res).toEqual({ ok: false, reason: 'missing_bearer_token' });
  });
});

// ---------------------------------------------------------------------------
// Unit: createOAuthJwtBackend — RS256
// ---------------------------------------------------------------------------

describe('createOAuthJwtBackend (RS256)', () => {
  const baseOpts = {
    name: 'oauth-rs',
    algorithm: 'RS256' as const,
    publicKeyPem: RS_PUBLIC_PEM,
    expectedIssuer: 'https://idp.test',
    expectedAudience: 'sudo-ai',
    now: () => 1_000_000,
  };

  it('OA-23: rejects construction without publicKeyPem', () => {
    expect(() => createOAuthJwtBackend({ ...baseOpts, publicKeyPem: undefined })).toThrow();
  });

  it('OA-24: rejects construction with malformed PEM', () => {
    expect(() => createOAuthJwtBackend({ ...baseOpts, publicKeyPem: 'not-a-pem' })).toThrow();
  });

  it('OA-25: valid RS256 token → ok', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    const tok = signRs256({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'bob', exp: 1_000_100 });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth:bob' });
  });

  it('OA-26: RS256 with wrong signing key → bad_signature', async () => {
    const be = createOAuthJwtBackend(baseOpts);
    // Sign with a DIFFERENT key pair.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ iss: 'https://idp.test', aud: 'sudo-ai', sub: 'bob', exp: 1_000_100 }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${h}.${p}`);
    const sig = signer.sign(other.privateKey);
    const tok = `${h}.${p}.${b64url(sig)}`;
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

// ---------------------------------------------------------------------------
// Unit: presets
// ---------------------------------------------------------------------------

describe('preset factories', () => {
  it('OA-27: createSelfHostedAuthBackend requires expectedIssuer (no-iss footgun guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createSelfHostedAuthBackend({ algorithm: 'HS256', hmacSecret: HS_SECRET } as any)).toThrow();
  });

  it('OA-28: createNousAuthBackend defaults issuer + audience + RS256', async () => {
    const be = createNousAuthBackend({ publicKeyPem: RS_PUBLIC_PEM });
    expect(be.name).toBe('oauth-nous');
    // Token with the wired-in defaults should authenticate.
    const tok = signRs256({
      iss: 'https://auth.nousresearch.com',
      aud: 'sudo-ai-dashboard',
      sub: 'carol',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth-nous:carol' });
  });

  it('OA-29: createSelfHostedAuthBackend uses self-hosted principal prefix', async () => {
    const be = createSelfHostedAuthBackend({
      algorithm: 'HS256',
      hmacSecret: HS_SECRET,
      expectedIssuer: 'https://my-keycloak.internal',
      expectedAudience: 'sudo-ai',
    });
    const tok = signHs256({
      iss: 'https://my-keycloak.internal',
      aud: 'sudo-ai',
      sub: 'dan',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const res = await be.authenticate(fakeReq({ authorization: `Bearer ${tok}` }), { allowQueryToken: false });
    expect(res).toEqual({ ok: true, principal: 'dashboard:oauth-self-hosted:dan' });
  });
});

// ---------------------------------------------------------------------------
// HTTP integration — async dispatcher exercises both sync (basic) and async
// (OAuth) backends through registerRoutes.
// ---------------------------------------------------------------------------

interface TestServer { baseUrl: string; close(): Promise<void> }

function startTestServer(authBackend?: AuthBackend, cfgOverrides: Partial<DashboardConfig> = {}): Promise<TestServer> {
  const cfg: DashboardConfig = {
    port: 0,
    authToken: 'fallback-bearer',
    refreshIntervalMs: 30000,
    // Non-loopback-trust so auth runs for every request.
    loopbackTrust: false,
    ...cfgOverrides,
  };
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => {
      // registerRoutes returns Promise<void> in slice 4 — catch rejections.
      Promise.resolve(registerRoutes(req, res, server, cfg)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'test_dispatch_error', message: String(err) }));
        }
      });
    });
    if (authBackend) registerDashboardGlobals({ authBackend });
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

interface RawResponse { status: number; body: string }

function rawGet(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
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

describe('HTTP integration — async dispatcher with OAuth backend', () => {
  beforeEach(clearGlobals);
  afterEach(clearGlobals);

  it('OA-30: valid JWT → 200 on /api/stats', async () => {
    const be = createOAuthJwtBackend({
      name: 'oauth-it',
      algorithm: 'HS256',
      hmacSecret: HS_SECRET,
      expectedIssuer: 'https://idp.test',
      expectedAudience: 'sudo-ai',
    });
    const srv = await startTestServer(be);
    try {
      const tok = signHs256({
        iss: 'https://idp.test',
        aud: 'sudo-ai',
        sub: 'integration-user',
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const r = await rawGet(`${srv.baseUrl}/api/stats`, { Authorization: `Bearer ${tok}` });
      expect(r.status).toBe(200);
    } finally { await srv.close(); }
  });

  it('OA-31: expired JWT → 401 on /api/stats', async () => {
    const be = createOAuthJwtBackend({
      name: 'oauth-it',
      algorithm: 'HS256',
      hmacSecret: HS_SECRET,
      expectedIssuer: 'https://idp.test',
      expectedAudience: 'sudo-ai',
      clockSkewSec: 0,
    });
    const srv = await startTestServer(be);
    try {
      const tok = signHs256({
        iss: 'https://idp.test',
        aud: 'sudo-ai',
        sub: 'integration-user',
        exp: Math.floor(Date.now() / 1000) - 3600,
      });
      const r = await rawGet(`${srv.baseUrl}/api/stats`, { Authorization: `Bearer ${tok}` });
      expect(r.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('OA-32: no Bearer → 401 on /api/stats (OAuth does not honor ?token=)', async () => {
    const be = createOAuthJwtBackend({
      name: 'oauth-it',
      algorithm: 'HS256',
      hmacSecret: HS_SECRET,
      expectedIssuer: 'https://idp.test',
      expectedAudience: 'sudo-ai',
    });
    const srv = await startTestServer(be);
    try {
      // ?token= would let the basic backend through; OAuth must NOT.
      const r = await rawGet(`${srv.baseUrl}/api/stats?token=fallback-bearer`);
      expect(r.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('OA-33: a backend whose authenticate() rejects → 401 (not 500)', async () => {
    const rejectingBackend: AuthBackend = {
      name: 'oauth-rejecting',
      authenticate(): Promise<never> {
        return Promise.reject(new Error('backend boom'));
      },
    };
    const srv = await startTestServer(rejectingBackend);
    try {
      const r = await rawGet(`${srv.baseUrl}/api/stats`, { Authorization: 'Bearer anything' });
      expect(r.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('OA-34: a backend whose authenticate() throws synchronously → 401', async () => {
    const throwingBackend: AuthBackend = {
      name: 'oauth-throwing',
      authenticate(): never {
        throw new Error('backend boom sync');
      },
    };
    const srv = await startTestServer(throwingBackend);
    try {
      const r = await rawGet(`${srv.baseUrl}/api/stats`, { Authorization: 'Bearer anything' });
      expect(r.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('OA-35: basic backend (sync AuthResult) still works through async dispatcher', async () => {
    // No backend registered → DashboardServer falls back to its built-in
    // BasicAuthBackend, which is a SYNC backend. The dispatcher must still
    // await it correctly.
    const srv = await startTestServer();
    try {
      const r = await rawGet(`${srv.baseUrl}/api/stats`, { Authorization: 'Bearer fallback-bearer' });
      expect(r.status).toBe(200);
    } finally { await srv.close(); }
  });
});
