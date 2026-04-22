/**
 * Tests for bench-routes.ts — Wave 10 Builder 2.
 *
 * Covers:
 *   - GET /v1/admin/bench → list runs
 *   - GET /v1/admin/bench/results → filter results
 *   - POST /v1/admin/bench/run → queue run, return runId
 *   - 401 on missing/wrong auth
 *   - Invalid condition query param → 400
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { registerBenchRoutes } from '../../src/core/gateway/bench-routes.js';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-routes-'));
  return path.join(dir, 'bench.db');
}

interface TestServer {
  server: http.Server;
  port:   number;
  close:  () => Promise<void>;
}

async function startServer(store: BenchStore, token?: string): Promise<TestServer> {
  const server = http.createServer();
  const tokenBuf = token ? Buffer.from(token, 'utf8') : null;
  registerBenchRoutes(server, { benchStore: store }, tokenBuf);

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr  = server.address();
      const port  = typeof addr === 'object' && addr ? addr.port : 0;
      const close = () => new Promise<void>((res, rej) =>
        server.close(e => e ? rej(e) : res()),
      );
      resolve({ server, port, close });
    });
    server.on('error', reject);
  });
}

async function doRequest(
  port:    number,
  method:  string,
  pathname: string,
  token?:  string,
  body?:   string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests — no auth required
// ---------------------------------------------------------------------------

describe('GET /v1/admin/bench — list runs', () => {
  let srv: TestServer;
  let store: BenchStore;

  beforeEach(async () => {
    store = new BenchStore(makeTempDb());
    srv   = await startServer(store);
  });

  afterEach(async () => {
    await srv.close();
    store.close();
    vi.restoreAllMocks();
  });

  it('returns empty runs list when no reports stored', async () => {
    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/bench');
    expect(status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toEqual([]);
  });

  it('returns summary of stored reports', async () => {
    store.upsertReport({
      runId: randomUUID(), startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(), totalTasks: 5, successRate: 0.8,
      medianLatencyMs: 100, p99LatencyMs: 500, totalCostUsd: 0.01,
      byCondition: {
        no_skills: { successRate: 0.8, medianLatencyMs: 100 },
        skills_on: { successRate: 0.8, medianLatencyMs: 100 },
        skills_optimized: { successRate: 0.8, medianLatencyMs: 100 },
      },
      byModel: { m: { successRate: 0.8, medianLatencyMs: 100 } },
      markdownSummary: '# Summary',
    });

    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/bench');
    expect(status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toHaveLength(1);
  });
});

describe('GET /v1/admin/bench/results — filter', () => {
  let srv: TestServer;
  let store: BenchStore;

  beforeEach(async () => {
    store = new BenchStore(makeTempDb());
    srv   = await startServer(store);
  });

  afterEach(async () => {
    await srv.close();
    store.close();
  });

  it('returns empty data when no results stored', async () => {
    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/bench/results');
    expect(status).toBe(200);
    expect((body as { data: unknown[] }).data).toEqual([]);
  });

  it('filters by condition correctly', async () => {
    store.insertResult({
      id: randomUUID(), runId: randomUUID(), model: 'x', agentId: 'a',
      taskId: 'task-hello', condition: 'skills_on', seedIndex: 0,
      success: true, latencyMs: 100, costUsd: 0.01, complexityTier: 'simple',
      timestamp: new Date().toISOString(),
    });

    const { status, body } = await doRequest(srv.port, 'GET', '/v1/admin/bench/results?condition=no_skills');
    expect(status).toBe(200);
    expect((body as { data: unknown[] }).data).toHaveLength(0);
  });

  it('returns 400 for invalid condition', async () => {
    const { status } = await doRequest(srv.port, 'GET', '/v1/admin/bench/results?condition=invalid');
    expect(status).toBe(400);
  });
});

describe('POST /v1/admin/bench/run', () => {
  let srv: TestServer;
  let store: BenchStore;

  beforeEach(async () => {
    store = new BenchStore(makeTempDb());
    srv   = await startServer(store);
  });

  afterEach(async () => {
    await srv.close();
    store.close();
  });

  it('returns 202 with runId and status queued', async () => {
    const { status, body } = await doRequest(
      srv.port, 'POST', '/v1/admin/bench/run', undefined,
      JSON.stringify({ models: ['test-model'], conditions: ['no_skills'], seeds: 1 }),
    );
    expect(status).toBe(202);
    expect((body as { status: string }).status).toBe('queued');
    expect(typeof (body as { runId: string }).runId).toBe('string');
  });

  it('returns 202 with default model when models not provided', async () => {
    const { status, body } = await doRequest(
      srv.port, 'POST', '/v1/admin/bench/run', undefined,
      JSON.stringify({}),
    );
    expect(status).toBe(202);
    expect((body as { runId: string }).runId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe('bench-routes — auth enforcement', () => {
  it('returns 401 when GATEWAY_TOKEN set and no token provided', async () => {
    const store = new BenchStore(makeTempDb());
    const srv   = await startServer(store, 'super-secret-token-that-is-32char!!');

    const { status } = await doRequest(srv.port, 'GET', '/v1/admin/bench');
    expect(status).toBe(401);

    await srv.close();
    store.close();
  });

  it('returns 200 when correct token provided', async () => {
    const TOKEN = 'super-secret-token-that-is-32char!!';
    const store = new BenchStore(makeTempDb());
    const srv   = await startServer(store, TOKEN);

    const { status } = await doRequest(srv.port, 'GET', '/v1/admin/bench', TOKEN);
    expect(status).toBe(200);

    await srv.close();
    store.close();
  });

  it('returns 401 for wrong token', async () => {
    const TOKEN = 'super-secret-token-that-is-32char!!';
    const store = new BenchStore(makeTempDb());
    const srv   = await startServer(store, TOKEN);

    const { status } = await doRequest(srv.port, 'GET', '/v1/admin/bench', 'wrong-token');
    expect(status).toBe(401);

    await srv.close();
    store.close();
  });
});
