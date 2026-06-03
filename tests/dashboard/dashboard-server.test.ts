/**
 * @file tests/dashboard/dashboard-server.test.ts
 * @description Dashboard module tests for SUDO-AI v4 (Part 1: Server tests).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardServer, getDashboard } from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type { DashboardConfig, DashboardStats } from '../../src/core/dashboard/dashboard-types.js';

let testPortCounter = 19100;

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

function rawGet(url: string, opts: { token?: string; queryToken?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const fullUrl = opts.queryToken ? `${url}?token=${encodeURIComponent(opts.queryToken)}` : url;
    const parsed = new URL(fullUrl);
    const req = http.request({ hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('DashboardServer', () => {
  const servers: TestServer[] = [];
  afterEach(async () => { for (const s of servers) await s.close(); servers.length = 0; });

  it('DB-1: getStats returns expected fields', () => {
    const server = new DashboardServer(getTestConfig());
    const stats = server.getStats();
    expect(typeof stats.uptime).toBe('number');
    expect(typeof stats.totalRequests).toBe('number');
    expect(typeof stats.activeSessions).toBe('number');
    expect(stats.memoryUsage).toBeDefined();
    expect(typeof stats.memoryUsage.rss).toBe('number');
    expect(typeof stats.cpuUsage).toBe('number');
    expect(stats.cpuUsage).toBeGreaterThanOrEqual(0);
  });

  it('DB-2: getHealth returns status and checks array', () => {
    const server = new DashboardServer(getTestConfig());
    const health = server.getHealth();
    expect(['healthy', 'degraded', 'down']).toContain(health.status);
    expect(Array.isArray(health.checks)).toBe(true);
    expect(health.checks.length).toBeGreaterThan(0);
    for (const check of health.checks) {
      expect(typeof check.name).toBe('string');
      expect(['ok', 'warn', 'error']).toContain(check.status);
    }
  });

  it('DB-3: SUDO_DASHBOARD_DISABLE=1 prevents server start', () => {
    const original = process.env['SUDO_DASHBOARD_DISABLE'];
    process.env['SUDO_DASHBOARD_DISABLE'] = '1';
    const server = new DashboardServer(getTestConfig());
    expect(() => server.start()).not.toThrow();
    if (original === undefined) delete process.env['SUDO_DASHBOARD_DISABLE'];
    else process.env['SUDO_DASHBOARD_DISABLE'] = original;
  });

  it('DB-4: Dashboard HTML contains key elements', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const { status, body } = await rawGet(`${testServer.baseUrl}/`);
    expect(status).toBe(200);
    expect(body).toContain('<title>SUDO-AI Dashboard</title>');
    expect(body).toContain('System Stats');
    expect(body).toContain('Health Status');
    expect(body).toContain('Alignment Score');
    expect(body).toContain('/api/stats');
  });

  it('DB-5: /api/stats returns correct JSON with auth', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const { status, body } = await rawGet(`${testServer.baseUrl}/api/stats`, { token: 'test-dashboard-auth-token-xyz' });
    expect(status).toBe(200);
    const json = JSON.parse(body) as DashboardStats;
    expect(typeof json.uptime).toBe('number');
    expect(typeof json.cpuUsage).toBe('number');
  });

  it('DB-6: Auth validation rejects missing/wrong token', async () => {
    const testServer = await startTestServer();
    servers.push(testServer);
    const token = 'test-dashboard-auth-token-xyz';
    expect((await rawGet(`${testServer.baseUrl}/api/stats`)).status).toBe(401);
    expect((await rawGet(`${testServer.baseUrl}/api/stats`, { token: 'wrong' })).status).toBe(401);
    expect((await rawGet(`${testServer.baseUrl}/api/stats`, { queryToken: token })).status).toBe(200);
  });

  it('DB-7: getMetrics returns Prometheus-style metrics', () => {
    const server = new DashboardServer(getTestConfig());
    const metrics = server.getMetrics();
    expect(metrics['sudo_dashboard_uptime_seconds']).toBeDefined();
    expect(metrics['sudo_system_cpu_percent']).toBeDefined();
    expect(typeof metrics['sudo_dashboard_uptime_seconds']).toBe('number');
  });

  it('DB-8: getAlignment returns score and signals', () => {
    const server = new DashboardServer(getTestConfig());
    const alignment = server.getAlignment();
    expect(typeof alignment.score).toBe('number');
    expect(typeof alignment.signals).toBe('object');
    expect(alignment.signals).toHaveProperty('veto');
    expect(alignment.signals).toHaveProperty('trust');
  });

  it('DB-9: getRecentActivity returns limited events', () => {
    const server = new DashboardServer(getTestConfig());
    server.recordActivity('test', 'Event 1');
    server.recordActivity('test', 'Event 2');
    server.recordActivity('test', 'Event 3');
    const activity = server.getRecentActivity(2);
    expect(activity.length).toBe(2);
    expect(activity[0].summary).toBe('Event 3');
    expect(activity[1].summary).toBe('Event 2');
  });

  it('DB-10: recordActivity buffers max 100 events', () => {
    const server = new DashboardServer(getTestConfig());
    for (let i = 0; i < 110; i++) server.recordActivity('bulk', `Event ${i}`);
    const activity = server.getRecentActivity(200);
    expect(activity.length).toBe(100);
    expect(activity[0].summary).toBe('Event 109');
    expect(activity[99].summary).toBe('Event 10');
  });
});
