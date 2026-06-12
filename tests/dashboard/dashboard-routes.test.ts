/**
 * @file tests/dashboard/dashboard-routes.test.ts
 * @description Dashboard module tests for SUDO-AI v4 (Part 2: Routes tests).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardServer, initDashboard, shutdownDashboard, getDashboard, registerDashboardGlobals } from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type { DashboardConfig, DashboardHealth } from '../../src/core/dashboard/dashboard-types.js';

let testPortCounter = 19200;

function getTestConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  return { port: testPortCounter++, authToken: 'test-dashboard-auth-token-xyz', refreshIntervalMs: 30000, ...overrides };
}

interface TestServer { baseUrl: string; close(): Promise<void>; dashboardServer: DashboardServer; }

function startTestServer(config?: DashboardConfig): Promise<TestServer> {
  const cfg = config ?? getTestConfig();
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => registerRoutes(req, res, server, cfg));
    httpServer.listen(cfg.port, '127.0.0.1', () => {
      const addr = httpServer.address() as import('node:net').AddressInfo;
      const close = (): Promise<void> => new Promise((res, rej) => httpServer.close((err) => (err ? rej(err) : res())));
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close, dashboardServer: server });
    });
    httpServer.on('error', reject);
  });
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string; }

function rawGet(url: string, opts: { token?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, method: 'GET', headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('registerRoutes', () => {
  const servers: TestServer[] = [];
  afterEach(async () => { for (const s of servers) await s.close(); servers.length = 0; });

  it('DB-11: /api/health returns health data', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const { status, body } = await rawGet(`${testServer.baseUrl}/api/health`, { token: 'test-dashboard-auth-token-xyz' });
    expect(status).toBe(200);
    const json = JSON.parse(body) as DashboardHealth;
    expect(['healthy', 'degraded', 'down']).toContain(json.status);
    expect(Array.isArray(json.checks)).toBe(true);
  });

  it('DB-12: /api/metrics returns Prometheus text format', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const { status, body, headers } = await rawGet(`${testServer.baseUrl}/api/metrics`, { token: 'test-dashboard-auth-token-xyz' });
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('text/plain');
    expect(body).toContain('sudo_dashboard_');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('DB-13: /api/alignment returns alignment data', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const { status, body } = await rawGet(`${testServer.baseUrl}/api/alignment`, { token: 'test-dashboard-auth-token-xyz' });
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(typeof json.score).toBe('number');
    expect(typeof json.signals).toBe('object');
  });

  it('DB-14: /api/activity returns activity list', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const { status, body } = await rawGet(`${testServer.baseUrl}/api/activity?limit=5`, { token: 'test-dashboard-auth-token-xyz' });
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeLessThanOrEqual(5);
  });

  it('DB-15: Unknown routes return 404', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const { status } = await rawGet(`${testServer.baseUrl}/api/unknown`, { token: 'test-dashboard-auth-token-xyz' });
    expect(status).toBe(404);
  });

  it('DB-16: Non-GET methods return 405', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const token = 'test-dashboard-auth-token-xyz';
    const postRes = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(`${testServer.baseUrl}/api/stats`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(postRes.status).toBe(405);
  });
});

describe('initDashboard / shutdownDashboard', () => {
  afterEach(() => { shutdownDashboard(); });

  it('DB-17: initDashboard creates and starts server', () => {
    const config = getTestConfig();
    const server = initDashboard(config);
    expect(server).toBeDefined();
    expect(getDashboard()).toBe(server);
  });

  it('DB-18: shutdownDashboard clears singleton', () => {
    const config = getTestConfig();
    initDashboard(config);
    expect(getDashboard()).toBeDefined();
    shutdownDashboard();
    expect(getDashboard()).toBeNull();
  });
});

describe('registerDashboardGlobals', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g['__sudoBrain'];
    delete g['__sudoGateway'];
    delete g['__sudoAlignment'];
  });

  it('DB-19: unregistered subsystems report not detected and zero alignment', () => {
    const server = new DashboardServer(getTestConfig());
    const health = server.getHealth();
    expect(health.checks.find((c) => c.name === 'brain')?.status).toBe('warn');
    expect(health.checks.find((c) => c.name === 'gateway')?.status).toBe('warn');
    expect(health.checks.find((c) => c.name === 'alignment')?.status).toBe('warn');
    expect(server.getAlignment().score).toBe(0);
  });

  it('DB-20: registered subsystems report ok and alignment digest flows through', () => {
    registerDashboardGlobals({
      brain: { name: 'test-brain' },
      gateway: { name: 'test-gateway' },
      alignment: { getDigest: () => ({ overallScore: 0.87, signals: { discordance: 0.1 } }) },
    });
    const server = new DashboardServer(getTestConfig());
    const health = server.getHealth();
    expect(health.checks.find((c) => c.name === 'brain')?.status).toBe('ok');
    expect(health.checks.find((c) => c.name === 'gateway')?.status).toBe('ok');
    expect(health.checks.find((c) => c.name === 'alignment')?.status).toBe('ok');
    const alignment = server.getAlignment();
    expect(alignment.score).toBe(0.87);
    expect(alignment.signals['discordance']).toBe(0.1);
  });

  it('DB-21: getDigest returning undefined yields zero score and empty signals', () => {
    registerDashboardGlobals({ alignment: { getDigest: () => undefined } });
    const server = new DashboardServer(getTestConfig());
    const alignment = server.getAlignment();
    expect(alignment.score).toBe(0);
    expect(alignment.signals).toEqual({});
  });

  it('DB-22: omitted parts leave prior registrations untouched', () => {
    registerDashboardGlobals({ brain: { a: 1 } });
    registerDashboardGlobals({ gateway: { b: 2 } });
    const server = new DashboardServer(getTestConfig());
    const health = server.getHealth();
    expect(health.checks.find((c) => c.name === 'brain')?.status).toBe('ok');
    expect(health.checks.find((c) => c.name === 'gateway')?.status).toBe('ok');
  });
});
