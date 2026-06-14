/**
 * @file tests/gateway/jsonrpc-methods.test.ts
 * @description Tests for the gateway's method registry (gap #25 slice 3).
 * Each method is exercised against a fake dashboard HTTP server with known
 * responses; result shapes are verified.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { buildMethodRegistry, GATEWAY_VERSION, GatewayErrorCode } from '../../src/gateway/jsonrpc/methods.js';
import type { GatewayConfig } from '../../src/gateway/jsonrpc/fetcher.js';
import { AcpRpcError, JsonRpcErrorCode } from '../../src/core/acp/jsonrpc.js';

// Reserved test-server port range: 19600-19699 — jsonrpc-methods.test.ts.
let portCounter = 19600;

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

function cfg(port: number): GatewayConfig {
  return { host: '127.0.0.1', port, token: 'gw-token', requestTimeoutMs: 2000 };
}

describe('gateway methods (gap #25 slice 3)', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it('gateway.version returns the version + supported method list', async () => {
    const registry = buildMethodRegistry(cfg(1));
    const handler = registry.get('gateway.version')!;
    expect(handler).toBeDefined();
    const res = (await handler(null)) as {
      version: string;
      protocol: string;
      framing: string;
      methods: string[];
    };
    expect(res.version).toBe(GATEWAY_VERSION);
    expect(res.protocol).toBe('jsonrpc-2.0');
    expect(res.framing).toBe('ndjson');
    expect(res.methods).toContain('agents.snapshot');
    expect(res.methods).toContain('dashboard.stats');
    expect(res.methods).toContain('dashboard.metrics');
    // Sorted alphabetically.
    const copy = [...res.methods];
    copy.sort();
    expect(res.methods).toEqual(copy);
  });

  it('agents.snapshot proxies /api/agents/live', async () => {
    const payload = { spawned: [], slotsUsed: 0, slotsMax: 4, queueWaiting: 0 };
    const s = await startServer((req, res) => {
      expect(req.url).toBe('/api/agents/live');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    servers.push(s);
    const r = await buildMethodRegistry(cfg(s.port)).get('agents.snapshot')!(null);
    expect(r).toEqual(payload);
  });

  it('dashboard.stats / health / alignment proxy their endpoints', async () => {
    const seen: string[] = [];
    const s = await startServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200);
      res.end(JSON.stringify({ url: req.url }));
    });
    servers.push(s);
    const registry = buildMethodRegistry(cfg(s.port));
    await registry.get('dashboard.stats')!(null);
    await registry.get('dashboard.health')!(null);
    await registry.get('dashboard.alignment')!(null);
    expect(seen).toEqual(['/api/stats', '/api/health', '/api/alignment']);
  });

  it('dashboard.metrics parses Prometheus text into a map', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(
        [
          '# HELP sudo_agents_spawned Number of spawned agents',
          '# TYPE sudo_agents_spawned gauge',
          'sudo_agents_spawned 3',
          'sudo_agents_idle 1',
          '',
          'sudo_system_cpu_percent 12.5',
        ].join('\n'),
      );
    });
    servers.push(s);
    const r = (await buildMethodRegistry(cfg(s.port)).get('dashboard.metrics')!(null)) as Record<
      string,
      string
    >;
    expect(r['sudo_agents_spawned']).toBe('3');
    expect(r['sudo_agents_idle']).toBe('1');
    expect(r['sudo_system_cpu_percent']).toBe('12.5');
    // Comment lines must NOT leak into the map.
    expect(Object.keys(r).every((k) => !k.startsWith('#'))).toBe(true);
  });

  it('dashboard.activity passes the limit through and defaults to 50', async () => {
    const seen: string[] = [];
    const s = await startServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200);
      res.end('[]');
    });
    servers.push(s);
    const handler = buildMethodRegistry(cfg(s.port)).get('dashboard.activity')!;
    await handler(null);
    await handler({ limit: 10 });
    expect(seen).toEqual(['/api/activity?limit=50', '/api/activity?limit=10']);
  });

  it('dashboard.activity rejects a non-numeric limit with InvalidParams', async () => {
    const handler = buildMethodRegistry(cfg(1)).get('dashboard.activity')!;
    await expect(handler({ limit: 'lots' })).rejects.toBeInstanceOf(AcpRpcError);
  });

  it('dashboard.activity clamps limit to [1,100]', async () => {
    const seen: string[] = [];
    const s = await startServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200);
      res.end('[]');
    });
    servers.push(s);
    const handler = buildMethodRegistry(cfg(s.port)).get('dashboard.activity')!;
    await handler({ limit: 9999 });
    await handler({ limit: 0 });
    expect(seen).toEqual(['/api/activity?limit=100', '/api/activity?limit=1']);
  });

  it('upstream 401 maps to AcpRpcError(UpstreamUnauthorized) in the app-defined range', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(401);
      res.end('{}');
    });
    servers.push(s);
    const handler = buildMethodRegistry(cfg(s.port)).get('agents.snapshot')!;
    try {
      await handler(null);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AcpRpcError);
      if (err instanceof AcpRpcError) {
        // App-defined range, NOT InvalidRequest (which is reserved for
        // structurally bad envelopes).
        expect(err.code).toBe(GatewayErrorCode.UpstreamUnauthorized);
        expect(err.code).not.toBe(JsonRpcErrorCode.InvalidRequest);
      }
    }
  });

  it('dashboard.activity accepts a stringified-numeric limit (jq/bridges compat)', async () => {
    const seen: string[] = [];
    const s = await startServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200);
      res.end('[]');
    });
    servers.push(s);
    const handler = buildMethodRegistry(cfg(s.port)).get('dashboard.activity')!;
    await handler({ limit: '20' });
    expect(seen).toEqual(['/api/activity?limit=20']);
  });

  it('upstream HTTP 500 maps to AcpRpcError(InternalError)', async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    servers.push(s);
    const handler = buildMethodRegistry(cfg(s.port)).get('dashboard.stats')!;
    try {
      await handler(null);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AcpRpcError);
      if (err instanceof AcpRpcError) {
        expect(err.code).toBe(JsonRpcErrorCode.InternalError);
      }
    }
  });
});
