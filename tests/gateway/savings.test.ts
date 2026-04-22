/**
 * @file tests/gateway/savings.test.ts
 * @description Tests for GET /v1/savings — savings routes.
 *
 * Tests:
 *  1.  GET /v1/savings returns 200 with correct shape
 *  2.  GET /v1/savings?period=day returns period=day in rows
 *  3.  GET /v1/savings?period=week returns period=week in rows
 *  4.  GET /v1/savings?period=all is default when no period param
 *  5.  GET /v1/savings with empty tracker returns empty rows or zeros
 *  6.  GET /v1/savings without auth token returns 401
 *  7.  GET /v1/savings?period=invalid → defaults to "all"
 *  8.  GET /v1/savings response includes totalCostUsd, totalWh, totalFlops
 *  9.  GET /v1/savings with per-model breakdown uses model rows
 *  10. GET /v1/savings rows include energy field with wh and flops
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerSavingsRoutes } from '../../src/core/gateway/savings-routes.js';
import type { CostTrackerLike } from '../../src/core/gateway/savings-routes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-savings-token-32chars-padding';

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, 'utf8');
}

function makeEmptyTracker(): CostTrackerLike {
  return {
    getTotalCost: () => ({ calls: 0, estimatedUsd: 0 }),
  };
}

function makeTrackerWithCost(usd: number): CostTrackerLike {
  return {
    getTotalCost: () => ({ calls: 5, estimatedUsd: usd }),
  };
}

function makeTrackerWithBreakdown(): CostTrackerLike {
  return {
    getTotalCost: () => ({ calls: 10, estimatedUsd: 0.05 }),
    getModelBreakdown: () => [
      {
        model: 'gpt-4o',
        provider: 'openai',
        calls: 5,
        inputTokens: 10000,
        outputTokens: 5000,
        estimatedUsd: 0.025,
      },
      {
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        calls: 5,
        inputTokens: 8000,
        outputTokens: 4000,
        estimatedUsd: 0.025,
      },
    ],
  };
}

async function startServer(
  tracker: CostTrackerLike,
  token?: string,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer();
  const tokenBuf = token ? makeTokenBuf(token) : null;

  // Patch GATEWAY_TOKEN for auth
  if (token) {
    process.env['GATEWAY_TOKEN'] = token;
  } else {
    delete process.env['GATEWAY_TOKEN'];
  }

  registerSavingsRoutes(server, { costTracker: tracker });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function get(
  baseUrl: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          resolve({ status: res.statusCode ?? 0, body });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/savings', () => {
  let server: http.Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server) await stopServer(server);
    delete process.env['GATEWAY_TOKEN'];
  });

  it('1. returns 200 with correct shape', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithCost(0.01), VALID_TOKEN));
    const { status, body } = await get(baseUrl, '/v1/savings', VALID_TOKEN);
    expect(status).toBe(200);
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('totalCostUsd');
    expect(body).toHaveProperty('totalWh');
    expect(body).toHaveProperty('totalFlops');
  });

  it('2. period=day in query → rows have period=day', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithCost(0.05), VALID_TOKEN));
    const { status, body } = await get(baseUrl, '/v1/savings?period=day', VALID_TOKEN);
    expect(status).toBe(200);
    const b = body as { rows: Array<{ period: string }> };
    if (b.rows.length > 0) {
      expect(b.rows[0]?.period).toBe('day');
    }
  });

  it('3. period=week → rows have period=week', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithCost(0.05), VALID_TOKEN));
    const { status, body } = await get(baseUrl, '/v1/savings?period=week', VALID_TOKEN);
    expect(status).toBe(200);
    const b = body as { rows: Array<{ period: string }> };
    if (b.rows.length > 0) {
      expect(b.rows[0]?.period).toBe('week');
    }
  });

  it('4. no period param defaults to "all"', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithCost(0.05), VALID_TOKEN));
    const { status, body } = await get(baseUrl, '/v1/savings', VALID_TOKEN);
    expect(status).toBe(200);
    const b = body as { rows: Array<{ period: string }> };
    if (b.rows.length > 0) {
      expect(b.rows[0]?.period).toBe('all');
    }
  });

  it('5. empty tracker returns empty rows and zero totals', async () => {
    ({ server, baseUrl } = await startServer(makeEmptyTracker(), VALID_TOKEN));
    const { status, body } = await get(baseUrl, '/v1/savings', VALID_TOKEN);
    expect(status).toBe(200);
    const b = body as { rows: unknown[]; totalCostUsd: number; totalWh: number };
    expect(b.rows).toHaveLength(0);
    expect(b.totalCostUsd).toBe(0);
    expect(b.totalWh).toBe(0);
  });

  it('6. missing auth token returns 401', async () => {
    ({ server, baseUrl } = await startServer(makeEmptyTracker(), VALID_TOKEN));
    const { status } = await get(baseUrl, '/v1/savings'); // no token
    expect(status).toBe(401);
  });

  it('7. invalid period param defaults to "all"', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithCost(0.05), VALID_TOKEN));
    const { status, body } = await get(baseUrl, '/v1/savings?period=BADPERIOD', VALID_TOKEN);
    expect(status).toBe(200);
    const b = body as { rows: Array<{ period: string }> };
    if (b.rows.length > 0) {
      expect(b.rows[0]?.period).toBe('all');
    }
  });

  it('8. response includes totalCostUsd, totalWh, totalFlops', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithCost(0.01), VALID_TOKEN));
    const { body } = await get(baseUrl, '/v1/savings', VALID_TOKEN);
    const b = body as { totalCostUsd: number; totalWh: number; totalFlops: number };
    expect(typeof b.totalCostUsd).toBe('number');
    expect(typeof b.totalWh).toBe('number');
    expect(typeof b.totalFlops).toBe('number');
  });

  it('9. tracker with getModelBreakdown uses per-model rows', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithBreakdown(), VALID_TOKEN));
    const { status, body } = await get(baseUrl, '/v1/savings', VALID_TOKEN);
    expect(status).toBe(200);
    const b = body as { rows: Array<{ provider: string; model: string }> };
    expect(b.rows.length).toBe(2);
    expect(b.rows.some((r) => r.provider === 'openai')).toBe(true);
    expect(b.rows.some((r) => r.provider === 'anthropic')).toBe(true);
  });

  it('10. rows include energy field with wh and flops', async () => {
    ({ server, baseUrl } = await startServer(makeTrackerWithBreakdown(), VALID_TOKEN));
    const { body } = await get(baseUrl, '/v1/savings', VALID_TOKEN);
    const b = body as { rows: Array<{ energy: { wh: number; flops: number; source: string } }> };
    if (b.rows.length > 0) {
      expect(b.rows[0]?.energy).toHaveProperty('wh');
      expect(b.rows[0]?.energy).toHaveProperty('flops');
      expect(b.rows[0]?.energy.source).toBe('estimated');
    }
  });
});
