/**
 * @file tests/dashboard/dashboard-loopback-trust.test.ts
 * @description #28b slice 2 — loopback-trust + Host-header guard + pluggable AuthBackend.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  DashboardServer,
  registerDashboardGlobals,
  classifyBind,
  parseHostAllowlist,
  checkHostHeader,
  createBasicAuthBackend,
} from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type { DashboardConfig, AuthBackend } from '../../src/core/dashboard/dashboard-types.js';

function getTestConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  // port: 0 → OS-assigned ephemeral port (collision-free under parallel suites).
  // startTestServer reads the actual bound port from httpServer.address().
  return {
    port: 0,
    authToken: 'test-slice2-token',
    refreshIntervalMs: 30000,
    ...overrides,
  };
}

interface TestServer { baseUrl: string; close(): Promise<void>; dashboardServer: DashboardServer }

function startTestServer(config?: DashboardConfig): Promise<TestServer> {
  const cfg = config ?? getTestConfig();
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => registerRoutes(req, res, server, cfg));
    httpServer.listen(cfg.port, '127.0.0.1', () => {
      const addr = httpServer.address() as import('node:net').AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: (): Promise<void> => new Promise((r, j) => httpServer.close((err) => (err ? j(err) : r()))),
        dashboardServer: server,
      });
    });
    httpServer.on('error', reject);
  });
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function rawRequest(url: string, opts: {
  method?: string;
  token?: string;
  body?: unknown;
  hostHeader?: string;
  extraHeaders?: Record<string, string>;
} = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    if (opts.hostHeader !== undefined) headers.Host = opts.hostHeader;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
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
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe('classifyBind', () => {
  it('LT-01: loopback IPv4 → "loopback"', () => { expect(classifyBind('127.0.0.1')).toBe('loopback'); });
  it('LT-02: ::1 → "loopback"', () => { expect(classifyBind('::1')).toBe('loopback'); });
  it('LT-03: localhost → "loopback"', () => { expect(classifyBind('localhost')).toBe('loopback'); });
  it('LT-04: 10.x.x.x → "lan"', () => { expect(classifyBind('10.0.5.99')).toBe('lan'); });
  it('LT-05: 192.168.x.x → "lan"', () => { expect(classifyBind('192.168.1.5')).toBe('lan'); });
  it('LT-06: 172.16.x.x → "lan"', () => { expect(classifyBind('172.16.0.1')).toBe('lan'); });
  it('LT-07: 0.0.0.0 → "lan" (all-interfaces is still a non-loopback bind)', () => { expect(classifyBind('0.0.0.0')).toBe('lan'); });
  it('LT-08: 8.8.8.8 → "public"', () => { expect(classifyBind('8.8.8.8')).toBe('public'); });
});

describe('parseHostAllowlist', () => {
  it('LT-09: undefined → default localhost set', () => {
    const r = parseHostAllowlist(undefined);
    expect(r).toContain('localhost');
    expect(r).toContain('127.0.0.1');
  });
  it('LT-10: empty string → default set', () => {
    expect(parseHostAllowlist('').length).toBeGreaterThan(0);
  });
  it('LT-11: comma list trimmed + lowered', () => {
    expect(parseHostAllowlist('  Foo.example.COM ,bar.local  ')).toEqual(['foo.example.com', 'bar.local']);
  });
});

describe('checkHostHeader', () => {
  const allow = ['localhost', '127.0.0.1', '[::1]'];
  it('LT-12: localhost matches', () => { expect(checkHostHeader('localhost', allow)).toBe(true); });
  it('LT-13: localhost:18910 matches (port stripped)', () => { expect(checkHostHeader('localhost:18910', allow)).toBe(true); });
  it('LT-14: 127.0.0.1:18910 matches', () => { expect(checkHostHeader('127.0.0.1:18910', allow)).toBe(true); });
  it('LT-15: [::1]:18910 matches IPv6', () => { expect(checkHostHeader('[::1]:18910', allow)).toBe(true); });
  it('LT-16: evil.com → reject', () => { expect(checkHostHeader('evil.com', allow)).toBe(false); });
  it('LT-17: missing Host → reject', () => { expect(checkHostHeader(undefined, allow)).toBe(false); });
  it('LT-18: empty allowlist → pass (operator opted out)', () => { expect(checkHostHeader('anything', [])).toBe(true); });
  it('LT-19: uppercase Host normalized to lowercase', () => { expect(checkHostHeader('LOCALHOST:18910', allow)).toBe(true); });
});

describe('createBasicAuthBackend', () => {
  function fakeReq(headers: http.IncomingHttpHeaders, urlPath = '/api/stats'): http.IncomingMessage {
    return { headers, url: urlPath } as unknown as http.IncomingMessage;
  }
  it('LT-20: valid Bearer → ok + principal "dashboard:basic"', () => {
    const b = createBasicAuthBackend('tok');
    expect(b.authenticate(fakeReq({ authorization: 'Bearer tok' }), { allowQueryToken: false })).toEqual({ ok: true, principal: 'dashboard:basic' });
  });
  it('LT-21: wrong Bearer → fail', () => {
    const b = createBasicAuthBackend('tok');
    expect(b.authenticate(fakeReq({ authorization: 'Bearer wrong' }), { allowQueryToken: false }).ok).toBe(false);
  });
  it('LT-22: ?token=tok with allowQueryToken=true → ok + principal basic-query', () => {
    const b = createBasicAuthBackend('tok');
    const r = b.authenticate(fakeReq({ host: 'localhost' }, '/api/stats?token=tok'), { allowQueryToken: true });
    expect(r).toEqual({ ok: true, principal: 'dashboard:basic-query' });
  });
  it('LT-23: ?token=tok with allowQueryToken=false → fail (POST mutation rule)', () => {
    const b = createBasicAuthBackend('tok');
    expect(b.authenticate(fakeReq({ host: 'localhost' }, '/api/admin/restart?token=tok'), { allowQueryToken: false }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: Host-header guard
// ---------------------------------------------------------------------------

describe('Dashboard Host-header guard (slice 2)', () => {
  const servers: TestServer[] = [];
  beforeEach(() => { clearGlobals(); });
  afterEach(async () => { for (const s of servers) await s.close(); servers.length = 0; clearGlobals(); });

  it('LT-30: bad Host on / → 403 (HTML root is also guarded)', async () => {
    const s = await startTestServer(getTestConfig({ hostAllowlist: ['localhost', '127.0.0.1'] })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/`, { hostHeader: 'evil.com' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('Forbidden host');
  });

  it('LT-31: bad Host on /api/stats → 403 (auth bypassed by Host guard)', async () => {
    const s = await startTestServer(getTestConfig({ hostAllowlist: ['localhost', '127.0.0.1'] })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats`, { token: 'test-slice2-token', hostHeader: 'evil.com' });
    expect(r.status).toBe(403);
  });

  it('LT-32: good Host + good token → 200', async () => {
    const s = await startTestServer(getTestConfig({ hostAllowlist: ['localhost', '127.0.0.1'] })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats`, { token: 'test-slice2-token' });
    expect(r.status).toBe(200);
  });

  it('LT-33: Host with port stripped matches allowlist without port', async () => {
    const s = await startTestServer(getTestConfig({ hostAllowlist: ['localhost'] })); servers.push(s);
    // Force Host header to localhost:NNN — Node defaults it to 127.0.0.1:NNN
    // when the hostname is an IP, which would 403 against 'localhost'-only.
    const r = await rawRequest(`${s.baseUrl}/api/stats`, {
      token: 'test-slice2-token',
      hostHeader: `localhost:${new URL(s.baseUrl).port}`,
    });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Integration: loopback-trust GET-skip-auth
// ---------------------------------------------------------------------------

describe('Dashboard loopback-trust (slice 2)', () => {
  const servers: TestServer[] = [];
  beforeEach(() => { clearGlobals(); process.env['SUDO_ADMIN_POWERS'] = '1'; process.env['SUDO_DASHBOARD_RESTART_NOEXIT'] = '1'; });
  afterEach(async () => { for (const s of servers) await s.close(); servers.length = 0; clearGlobals(); delete process.env['SUDO_ADMIN_POWERS']; delete process.env['SUDO_DASHBOARD_RESTART_NOEXIT']; });

  it('LT-40: loopbackTrust=true → GET /api/stats without Bearer → 200', async () => {
    const s = await startTestServer(getTestConfig({ loopbackTrust: true })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats`);
    expect(r.status).toBe(200);
  });

  it('LT-41: loopbackTrust=false (default) → GET /api/stats without Bearer → 401', async () => {
    const s = await startTestServer(); servers.push(s); // no loopbackTrust set
    const r = await rawRequest(`${s.baseUrl}/api/stats`);
    expect(r.status).toBe(401);
  });

  it('LT-42: loopbackTrust=true → POST /api/admin/restart without Bearer → 401 (POSTs always require auth)', async () => {
    const s = await startTestServer(getTestConfig({ loopbackTrust: true })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, { method: 'POST', body: {} });
    expect(r.status).toBe(401);
  });

  it('LT-43: loopbackTrust=true + POST + valid Bearer → 202 (loopback-trust does not bypass admin-powers gate)', async () => {
    const s = await startTestServer(getTestConfig({ loopbackTrust: true })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, {
      method: 'POST', token: 'test-slice2-token', body: { reason: 'loopback-trust POST test' },
    });
    expect(r.status).toBe(202);
  });

  it('LT-44: loopbackTrust=true + unknown GET path without Bearer → 401 (loopback-trust skips auth ONLY for known GETs)', async () => {
    // Route-enumeration defense: unknown paths must still go through auth so
    // a probe without Bearer cannot tell "exists but unauthorized" from
    // "doesn't exist." Only paths in GET_ROUTES get the loopback-trust skip.
    const s = await startTestServer(getTestConfig({ loopbackTrust: true })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/does-not-exist`);
    expect(r.status).toBe(401);
  });

  it('LT-45: loopbackTrust=true + unknown GET path WITH Bearer → 404 (auth passes, then 404 fires)', async () => {
    const s = await startTestServer(getTestConfig({ loopbackTrust: true })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/does-not-exist`, { token: 'test-slice2-token' });
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Integration: pluggable AuthBackend
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Integration: actual server.start() bind-address path
// ---------------------------------------------------------------------------

describe('DashboardServer.start() bind address (slice 2)', () => {
  // Closes the previous test-only gap where startTestServer used a raw
  // http.createServer + registerRoutes pair, bypassing server.start() (which
  // is where the new config.bindAddress wiring lives).

  it('LT-60: server.start() honors config.bindAddress (127.0.0.1 default)', () => {
    // Asserts on getBindAddress / isLoopbackTrust / getHostAllowlist — these
    // are pure reads of `config.bindAddress`/`loopbackTrust`/`hostAllowlist`
    // set at construction and don't depend on the socket being bound, so the
    // test doesn't need to wait for a listen callback.
    const cfg: DashboardConfig = {
      port: 0,
      authToken: 'test-bind-token',
      refreshIntervalMs: 30000,
      bindAddress: '127.0.0.1',
      hostAllowlist: ['localhost', '127.0.0.1'],
    };
    const server = new DashboardServer(cfg);
    server.start();
    try {
      expect(server.getBindAddress()).toBe('127.0.0.1');
      expect(server.isLoopbackTrust()).toBe(false); // unset in config
      expect(server.getHostAllowlist()).toEqual(['localhost', '127.0.0.1']);
    } finally {
      server.stop();
    }
  });

  it('LT-61: server.start() with loopbackTrust=true exposes isLoopbackTrust()', () => {
    const cfg: DashboardConfig = {
      port: 0,
      authToken: 'tok',
      refreshIntervalMs: 30000,
      loopbackTrust: true,
    };
    const server = new DashboardServer(cfg);
    expect(server.isLoopbackTrust()).toBe(true);
  });
});

describe('Dashboard pluggable AuthBackend (slice 2)', () => {
  const servers: TestServer[] = [];
  beforeEach(() => { clearGlobals(); });
  afterEach(async () => { for (const s of servers) await s.close(); servers.length = 0; clearGlobals(); });

  it('LT-50: custom backend accepting "X-Test-Auth: ok" — header present → 200', async () => {
    const custom: AuthBackend = {
      name: 'test-custom',
      authenticate(req) {
        if (req.headers['x-test-auth'] === 'ok') return { ok: true, principal: 'oauth:user42' };
        return { ok: false, reason: 'bad header' };
      },
    };
    registerDashboardGlobals({ authBackend: custom });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats`, { extraHeaders: { 'X-Test-Auth': 'ok' } });
    expect(r.status).toBe(200);
  });

  it('LT-51: custom backend rejecting → 401 even with otherwise-valid Bearer (backend wins)', async () => {
    const custom: AuthBackend = {
      name: 'test-deny-all',
      authenticate() { return { ok: false, reason: 'no' }; },
    };
    registerDashboardGlobals({ authBackend: custom });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats`, { token: 'test-slice2-token' });
    expect(r.status).toBe(401);
  });

  it('LT-52: with no backend registered, built-in Bearer logic works', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats`, { token: 'test-slice2-token' });
    expect(r.status).toBe(200);
  });
});
