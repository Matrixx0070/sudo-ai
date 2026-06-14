/**
 * @file tests/tui/fleetview-fetcher.test.ts
 * @description Tests for the FleetView TUI's HTTP fetcher (gap #25 slice 2).
 *
 * Spins up a tiny http.Server per test, exercises auth handling, success,
 * malformed JSON, malformed shape, timeout, and connection errors. No ink/JSX
 * involved — the fetcher is a pure data utility separate from the App.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  fetchLiveAgents,
  readConfigFromEnv,
  type TuiConfig,
} from '../../src/tui/fleetview/fetcher.js';
import type { LiveAgentsData } from '../../src/core/dashboard/dashboard-types.js';

// Reserved test-server port range: 19400-19499 — fleetview-fetcher.test.ts.
// Other test files' ranges: 19100 dashboard-server, 19200 dashboard-routes,
// 19300 dashboard/fleetview. Keep this comment in sync when adding new ranges.
let portCounter = 19400;

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

function cfg(port: number, overrides?: Partial<TuiConfig>): TuiConfig {
  return {
    host: '127.0.0.1',
    port,
    token: 'fleetview-test-token',
    pollMs: 1500,
    requestTimeoutMs: 2000,
    ...overrides,
  };
}

const sampleData: LiveAgentsData = {
  spawned: [
    {
      id: 'agent-1',
      task: 'do a thing',
      startedAt: new Date().toISOString(),
      elapsedMs: 1234,
      sinceHeartbeatMs: 100,
      idle: false,
    },
  ],
  slotsUsed: 1,
  slotsMax: 4,
  queueWaiting: 0,
};

describe('readConfigFromEnv (gap #25 slice 2)', () => {
  it('fails honestly when SUDO_DASHBOARD_TOKEN is missing', () => {
    const res = readConfigFromEnv({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('SUDO_DASHBOARD_TOKEN');
  });

  it('accepts GATEWAY_TOKEN as a fallback', () => {
    const res = readConfigFromEnv({ GATEWAY_TOKEN: 'fallback-tok' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.token).toBe('fallback-tok');
  });

  it('parses host/port/poll/timeout with sane defaults', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.host).toBe('127.0.0.1');
      expect(res.config.port).toBe(18910);
      expect(res.config.pollMs).toBe(1500);
      expect(res.config.requestTimeoutMs).toBe(4000);
    }
  });

  it('rejects an invalid port', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_DASHBOARD_PORT: 'abc' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('SUDO_DASHBOARD_PORT');
  });

  it('clamps too-low poll intervals to the default 1500', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_TUI_POLL_MS: '50' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.pollMs).toBe(1500);
  });

  it('clamps too-low request timeouts to the default 4000', () => {
    const res = readConfigFromEnv({ SUDO_DASHBOARD_TOKEN: 't', SUDO_TUI_REQUEST_TIMEOUT_MS: '10' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.requestTimeoutMs).toBe(4000);
  });
});

describe('fetchLiveAgents (gap #25 slice 2)', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it('returns parsed data on a 200 with valid JSON', async () => {
    const s = await startServer((req, res) => {
      expect(req.url).toBe('/api/agents/live');
      expect(req.headers.authorization).toBe('Bearer fleetview-test-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sampleData));
    });
    servers.push(s);
    const result = await fetchLiveAgents(cfg(s.port));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.spawned).toHaveLength(1);
      expect(result.data.slotsMax).toBe(4);
    }
  });

  it('surfaces Unauthorized with a clear message on 401', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"Unauthorized"}');
    });
    servers.push(s);
    const result = await fetchLiveAgents(cfg(s.port));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unauthorized');
  });

  it('surfaces HTTP errors with status and snippet on 500', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    servers.push(s);
    const result = await fetchLiveAgents(cfg(s.port));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HTTP 500/);
  });

  it('reports a parse error on non-JSON 200 body', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('not json {{');
    });
    servers.push(s);
    const result = await fetchLiveAgents(cfg(s.port));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('parse error');
  });

  it('reports a shape error when required fields are missing', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('{"spawned":"not-an-array"}');
    });
    servers.push(s);
    const result = await fetchLiveAgents(cfg(s.port));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('malformed');
  });

  it('accepts a malformed per-agent entry — render-side guards handle it', async () => {
    // Regression for verifier MED 2: the top-level shape check intentionally
    // does NOT validate per-agent fields. The render path (shortId,
    // formatElapsed, etc.) uses null-safe guards, so a single bad entry
    // should not poison the whole snapshot.
    const s = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ spawned: [{ id: null }], slotsUsed: 0, slotsMax: 4, queueWaiting: 0 }));
    });
    servers.push(s);
    const result = await fetchLiveAgents(cfg(s.port));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.spawned).toHaveLength(1);
      expect(result.data.slotsMax).toBe(4);
    }
  });

  it('reports a connection error when the server is not listening', async () => {
    const result = await fetchLiveAgents(cfg(1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('connection error');
  });

  it('reports a timeout when the server hangs past requestTimeoutMs', async () => {
    const s = await startServer(() => {
      // Never respond.
    });
    servers.push(s);
    const result = await fetchLiveAgents(cfg(s.port, { requestTimeoutMs: 500 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('timed out');
  });
});
