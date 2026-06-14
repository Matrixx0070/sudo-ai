/**
 * @file tests/gateway/jsonrpc-fetcher.test.ts
 * @description Tests for the gateway's generic dashboard fetcher
 * (gap #25 slice 3). Mirrors the TUI fetcher tests so future changes to either
 * fetcher are caught against the same parity bar.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  dashboardGet,
  readConfigFromEnv,
  type GatewayConfig,
} from '../../src/gateway/jsonrpc/fetcher.js';

// Reserved test-server port range: 19500-19599 — jsonrpc-fetcher.test.ts.
// Other ranges in use: 19100 dashboard-server, 19200 dashboard-routes,
// 19300 fleetview dashboard, 19400 fleetview TUI fetcher.
let portCounter = 19500;

interface TestServer {
  port: number;
  close(): Promise<void>;
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    const port = portCounter++;
    srv.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => new Promise((res, rej) => srv.close((err) => (err ? rej(err) : res()))),
      });
    });
    srv.on('error', reject);
  });
}

function cfg(port: number, overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    host: '127.0.0.1',
    port,
    token: 'gw-test-token',
    requestTimeoutMs: 2000,
    ...overrides,
  };
}

describe('readConfigFromEnv (gateway, gap #25 slice 3)', () => {
  it('fails when SUDO_DASHBOARD_TOKEN and GATEWAY_TOKEN are both missing', () => {
    const r = readConfigFromEnv({});
    expect(r.ok).toBe(false);
  });

  it('accepts GATEWAY_TOKEN as a fallback', () => {
    const r = readConfigFromEnv({ GATEWAY_TOKEN: 'gw-fallback' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.token).toBe('gw-fallback');
  });

  it('defaults host/port/timeout sensibly', () => {
    const r = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.host).toBe('127.0.0.1');
      expect(r.config.port).toBe(18910);
      expect(r.config.requestTimeoutMs).toBe(4000);
    }
  });

  it('rejects invalid port', () => {
    const r = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 'x', SUDO_DASHBOARD_PORT: 'abc' });
    expect(r.ok).toBe(false);
  });

  it('clamps too-low timeout to default', () => {
    const r = readConfigFromEnv({
      SUDO_DASHBOARD_TOKEN: 'x',
      SUDO_GATEWAY_REQUEST_TIMEOUT_MS: '50',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.requestTimeoutMs).toBe(4000);
  });
});

describe('dashboardGet (gateway, gap #25 slice 3)', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it('returns parsed JSON on 200', async () => {
    const s = await startServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer gw-test-token');
      expect(req.url).toBe('/api/anything');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: 1 }));
    });
    servers.push(s);
    const r = await dashboardGet<{ ok: number }>(cfg(s.port), '/api/anything');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.ok).toBe(1);
  });

  it('returns 401 error with status', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(401);
      res.end('{}');
    });
    servers.push(s);
    const r = await dashboardGet<unknown>(cfg(s.port), '/api/anything');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toContain('Unauthorized');
    }
  });

  it('surfaces HTTP 500 with snippet', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom-server-side');
    });
    servers.push(s);
    const r = await dashboardGet<unknown>(cfg(s.port), '/api/anything');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/HTTP 500/);
  });

  it('reports parse error on bad JSON', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('not-json {{');
    });
    servers.push(s);
    const r = await dashboardGet<unknown>(cfg(s.port), '/api/anything');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('parse error');
  });

  it('honors a custom parser (for non-JSON endpoints like /api/metrics)', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('raw text body');
    });
    servers.push(s);
    const r = await dashboardGet<string>(cfg(s.port), '/api/raw', (b) => b);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('raw text body');
  });

  it('reports connection error when server not listening', async () => {
    const r = await dashboardGet<unknown>(cfg(1), '/api/anything');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('connection error');
  });

  it('reports timeout when server hangs past requestTimeoutMs', async () => {
    const s = await startServer(() => {
      // never respond
    });
    servers.push(s);
    const r = await dashboardGet<unknown>(cfg(s.port, { requestTimeoutMs: 500 }), '/api/anything');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('timed out');
  });
});
