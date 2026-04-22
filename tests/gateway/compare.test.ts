/**
 * @file tests/gateway/compare.test.ts
 * @description Tests for GET /v1/admin/compare — compare routes.
 *
 * Tests:
 *  1.  Missing 'a' param → 400
 *  2.  Missing 'b' param → 400
 *  3.  Missing 'prompt' param → 400
 *  4.  All required params → 200 with CompareResult shape
 *  5.  No auth token → 401
 *  6.  Both model calls made concurrently (mock brain called twice)
 *  7.  Response includes latencyAms and latencyBms
 *  8.  Response includes costAusd and costBusd
 *  9.  Response includes complexityA and complexityB
 *  10. Response includes runId (UUID format)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerCompareRoutes } from '../../src/core/gateway/compare-routes.js';
import type { BrainLike, ComplexityScorerLike } from '../../src/core/gateway/compare-routes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Each test uses a unique token so the module-scoped rate-limit Map buckets
// do not bleed across tests. Wave 11 added a rate limiter that keyed by
// bearer token; without per-test tokens, tests 7-10 would be the 6th-9th
// requests in the same bucket and receive 429 instead of 200.
function uniqueToken(testNum: number): string {
  return `compare-test-tok-${testNum}-pad!!!`;
}

function makeBrain(response = 'mock response'): BrainLike {
  return {
    runWithModel: vi.fn(async (modelId: string, prompt: string) => ({
      text: `${response} from ${modelId}`,
      inputTokens: 100,
      outputTokens: 50,
    })),
  };
}

function makeScorer(): ComplexityScorerLike {
  return {
    score: vi.fn((_prompt: string, _model?: string) => ({
      score: 0.3,
      tier: 'moderate' as const,
      signals: ['prompt_length'],
      suggested_max_tokens: 4096,
      thinking_model: false,
    })),
  };
}

async function startServer(
  brain: BrainLike,
  scorer: ComplexityScorerLike,
  token?: string,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer();

  if (token) {
    process.env['GATEWAY_TOKEN'] = token;
  } else {
    delete process.env['GATEWAY_TOKEN'];
  }

  registerCompareRoutes(server, { brain, complexityScorer: scorer });

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

describe('GET /v1/admin/compare', () => {
  let server: http.Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server) await stopServer(server);
    delete process.env['GATEWAY_TOKEN'];
  });

  it('1. missing "a" param → 400', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(1)));
    const { status } = await get(
      baseUrl,
      '/v1/admin/compare?b=anthropic/claude-sonnet-4-5&prompt=hello',
      uniqueToken(1),
    );
    expect(status).toBe(400);
  });

  it('2. missing "b" param → 400', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(2)));
    const { status } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&prompt=hello',
      uniqueToken(2),
    );
    expect(status).toBe(400);
  });

  it('3. missing "prompt" param → 400', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(3)));
    const { status } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=anthropic/claude-sonnet-4-5',
      uniqueToken(3),
    );
    expect(status).toBe(400);
  });

  it('4. all required params → 200 with CompareResult shape', async () => {
    const brain = makeBrain();
    ({ server, baseUrl } = await startServer(brain, makeScorer(), uniqueToken(4)));
    const { status, body } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=xai/grok-4-0709&prompt=hello',
      uniqueToken(4),
    );
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('runId');
    expect(b).toHaveProperty('modelA');
    expect(b).toHaveProperty('modelB');
    expect(b).toHaveProperty('prompt');
    expect(b).toHaveProperty('responseA');
    expect(b).toHaveProperty('responseB');
    expect(b).toHaveProperty('timestamp');
  });

  it('5. no auth token → 401', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(5)));
    const { status } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=xai/grok-4-0709&prompt=hello',
      // no token
    );
    expect(status).toBe(401);
  });

  it('6. both model calls made concurrently (brain called twice)', async () => {
    const brain = makeBrain();
    ({ server, baseUrl } = await startServer(brain, makeScorer(), uniqueToken(6)));
    await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=xai/grok-4-0709&prompt=test',
      uniqueToken(6),
    );
    expect(brain.runWithModel).toHaveBeenCalledTimes(2);
    expect((brain.runWithModel as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)).toContain('openai/gpt-4o');
    expect((brain.runWithModel as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)).toContain('xai/grok-4-0709');
  });

  it('7. response includes latencyAms and latencyBms', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(7)));
    const { body } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=xai/grok-4-0709&prompt=test',
      uniqueToken(7),
    );
    const b = body as { latencyAms: number; latencyBms: number };
    expect(typeof b.latencyAms).toBe('number');
    expect(typeof b.latencyBms).toBe('number');
    expect(b.latencyAms).toBeGreaterThanOrEqual(0);
    expect(b.latencyBms).toBeGreaterThanOrEqual(0);
  });

  it('8. response includes costAusd and costBusd', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(8)));
    const { body } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=xai/grok-4-0709&prompt=test',
      uniqueToken(8),
    );
    const b = body as { costAusd: number; costBusd: number };
    expect(typeof b.costAusd).toBe('number');
    expect(typeof b.costBusd).toBe('number');
  });

  it('9. response includes complexityA and complexityB', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(9)));
    const { body } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=xai/grok-4-0709&prompt=test',
      uniqueToken(9),
    );
    const b = body as { complexityA: { score: number; tier: string }; complexityB: { score: number; tier: string } };
    expect(b.complexityA).toHaveProperty('score');
    expect(b.complexityA).toHaveProperty('tier');
    expect(b.complexityB).toHaveProperty('score');
    expect(b.complexityB).toHaveProperty('tier');
  });

  it('10. response includes runId in UUID format', async () => {
    ({ server, baseUrl } = await startServer(makeBrain(), makeScorer(), uniqueToken(10)));
    const { body } = await get(
      baseUrl,
      '/v1/admin/compare?a=openai/gpt-4o&b=xai/grok-4-0709&prompt=test',
      uniqueToken(10),
    );
    const b = body as { runId: string };
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(b.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
