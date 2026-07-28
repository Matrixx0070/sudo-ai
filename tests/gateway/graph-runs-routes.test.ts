/**
 * Tests for graph-runs-routes.ts — AL4 telemetry surface for the dashboard's
 * Bench & Graph Runs panel:
 *   - GET /v1/admin/graph-runs → runs with status + budget spent (limit clamped)
 *   - GET /v1/admin/graph-runs/approvals → pending gate artifacts
 *   - 401 on missing/wrong auth; 405 non-GET; 404 unknown subpath
 * Backed by a REAL GraphRunStore on a temp DB (no mocks on the read surface).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { registerGraphRunsRoutes } from '../../src/core/gateway/graph-runs-routes.js';
import { GraphRunStore } from '../../src/core/orchestration/index.js';
import type { WorkflowGraph } from '../../src/core/workflows/index.js';

interface TestServer {
  port: number;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(store: GraphRunStore, token?: string): Promise<TestServer> {
  const server = http.createServer();
  registerGraphRunsRoutes(server, { store }, token ? Buffer.from(token, 'utf8') : null);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const close = () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
      cleanups.push(close);
      resolve({ port, close });
    });
    server.on('error', reject);
  });
}

async function get(port: number, pathname: string, token?: string, method = 'GET'): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function seededStore(): GraphRunStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-runs-routes-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new GraphRunStore(path.join(dir, 'mind.db'));
  cleanups.push(() => store.close());
  const graph: WorkflowGraph = {
    name: 'telemetry-fixture',
    nodes: [
      { id: 'a', kind: 'agent' },
      { id: 'ask', kind: 'gate' },
    ],
    edges: [{ from: 'a', to: 'ask' }],
  };
  store.createRun('run-1', graph);
  store.persistEvent('run-1', {
    type: 'node',
    result: { id: 'a', status: 'success', output: 'ok', durationMs: 5, iteration: 1 },
    spend: 42,
  });
  store.requestApproval('run-1', 'ask', 'Ship it?');
  return store;
}

describe('graph-runs admin routes', () => {
  it('lists runs with status + budget spent, and clamps limit', async () => {
    const store = seededStore();
    const srv = await startServer(store, 'tok');
    const ok = await get(srv.port, '/v1/admin/graph-runs?limit=5', 'tok');
    expect(ok.status).toBe(200);
    expect(ok.body.runs).toHaveLength(1);
    expect(ok.body.runs[0]).toMatchObject({ runId: 'run-1', graphName: 'telemetry-fixture', status: 'running', budgetSpent: 42 });
    const silly = await get(srv.port, '/v1/admin/graph-runs?limit=99999', 'tok');
    expect(silly.status).toBe(200); // clamped internally, still serves
  });

  it('lists pending gate approvals (the operator inbox)', async () => {
    const store = seededStore();
    const srv = await startServer(store, 'tok');
    const r = await get(srv.port, '/v1/admin/graph-runs/approvals', 'tok');
    expect(r.status).toBe(200);
    expect(r.body.pending).toHaveLength(1);
    expect(r.body.pending[0]).toMatchObject({ runId: 'run-1', nodeId: 'ask', status: 'pending', note: 'Ship it?' });
  });

  it('401 without/with wrong token; open when no token configured', async () => {
    const store = seededStore();
    const srv = await startServer(store, 'tok');
    expect((await get(srv.port, '/v1/admin/graph-runs')).status).toBe(401);
    expect((await get(srv.port, '/v1/admin/graph-runs', 'wrong')).status).toBe(401);
    const open = await startServer(seededStore());
    expect((await get(open.port, '/v1/admin/graph-runs')).status).toBe(200);
  });

  it('405 on non-GET, 404 on unknown subpath, other prefixes untouched', async () => {
    const store = seededStore();
    const srv = await startServer(store, 'tok');
    expect((await get(srv.port, '/v1/admin/graph-runs', 'tok', 'POST')).status).toBe(405);
    expect((await get(srv.port, '/v1/admin/graph-runs/nope', 'tok')).status).toBe(404);
  });
});
