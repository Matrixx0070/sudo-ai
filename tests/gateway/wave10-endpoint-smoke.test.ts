/**
 * Wave 10 endpoint smoke test.
 *
 * Boots the HTTP stack in-process by registering Wave 10 route groups
 * (bench, learning, savings) plus a simple 404 catch-all, then asserts:
 *   - GET /v1/admin/bench/results → 200
 *   - GET /v1/admin/learning/proposals → 200
 *   - GET /v1/savings → 200
 *   - GET /v1/admin/nonexistent-path-xyz → 404 (catch-all still fires)
 *
 * No auth token set — routes run with tokenBuf=null (open access).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { registerBenchRoutes } from '../../src/core/gateway/bench-routes.js';
import { registerLearningRoutes } from '../../src/core/gateway/learning-routes.js';
import { registerSavingsRoutes } from '../../src/core/gateway/savings-routes.js';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import type { ProposalStoreLike } from '../../src/core/gateway/learning-routes.js';
import type { CostTrackerLike } from '../../src/core/gateway/savings-routes.js';
import type { AgentConfigProposal, ProposalStatus } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave10-smoke-'));
  return path.join(dir, 'bench.db');
}

function makeEmptyProposalStore(): ProposalStoreLike {
  return {
    list({ status, limit, offset }: { status?: ProposalStatus; limit: number; offset: number }) {
      void status; void limit; void offset;
      return { data: [] as AgentConfigProposal[], total: 0 };
    },
    approve(id: string): AgentConfigProposal {
      throw new Error(`Not found: ${id}`);
    },
    reject(id: string): AgentConfigProposal {
      throw new Error(`Not found: ${id}`);
    },
    getById(_id: string): AgentConfigProposal | null {
      return null;
    },
  };
}

function makeEmptyTracker(): CostTrackerLike {
  return { getTotalCost: () => ({ calls: 0, estimatedUsd: 0 }) };
}

async function doGet(
  port: number,
  pathname: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: text });
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;
let benchStore: BenchStore;

beforeAll(async () => {
  // Ensure no GATEWAY_TOKEN so routes are open (no auth)
  delete process.env['GATEWAY_TOKEN'];

  benchStore = new BenchStore(makeTempDb());

  server = http.createServer();

  // Register Wave 10 route groups (null tokenBuf = no auth)
  registerBenchRoutes(server, { benchStore }, null);
  registerLearningRoutes(server, { proposalStore: makeEmptyProposalStore() }, null);
  registerSavingsRoutes(server, { costTracker: makeEmptyTracker() });

  // 404 catch-all for unmatched /v1/admin/* paths
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (pathname.startsWith('/v1/admin') && !res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found', code: 404 } }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  benchStore.close();
});

describe('Wave 10 endpoint smoke tests', () => {
  it('GET /v1/admin/bench/results → 200', async () => {
    const { status } = await doGet(port, '/v1/admin/bench/results');
    expect(status).toBe(200);
  });

  it('GET /v1/admin/learning/proposals → 200', async () => {
    const { status, body } = await doGet(port, '/v1/admin/learning/proposals');
    expect(status).toBe(200);
    expect((body as { data: unknown[] }).data).toEqual([]);
  });

  it('GET /v1/savings → 200', async () => {
    const { status } = await doGet(port, '/v1/savings');
    expect(status).toBe(200);
  });

  it('GET /v1/admin/nonexistent-path-xyz → 404 (catch-all fires)', async () => {
    const { status } = await doGet(port, '/v1/admin/nonexistent-path-xyz');
    expect(status).toBe(404);
  });

  it('GET /v1/admin/bench/results returns empty data array on fresh store', async () => {
    const { status, body } = await doGet(port, '/v1/admin/bench/results');
    expect(status).toBe(200);
    expect((body as { data: unknown[] }).data).toEqual([]);
  });

  it('GET /v1/admin/bench → 200 with empty runs list', async () => {
    const { status, body } = await doGet(port, '/v1/admin/bench');
    expect(status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toEqual([]);
  });
});
