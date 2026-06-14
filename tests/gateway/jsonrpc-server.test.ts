/**
 * @file tests/gateway/jsonrpc-server.test.ts
 * @description End-to-end tests for the gateway JSON-RPC wire — PassThrough
 * streams + a fake dashboard HTTP server. Verifies that the wire protocol
 * (NDJSON, request/response envelopes, error mapping) matches the JSON-RPC
 * 2.0 spec for valid, invalid, parse-error, and unknown-method cases.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { startGatewayServer } from '../../src/gateway/jsonrpc/server.js';
import { JsonRpcErrorCode } from '../../src/core/acp/jsonrpc.js';
import type { GatewayConfig } from '../../src/gateway/jsonrpc/fetcher.js';

// Reserved test-server port range: 19700-19799 — jsonrpc-server.test.ts.
let portCounter = 19700;

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

/** Collect NDJSON messages from a PassThrough stream. Resolves when count reached. */
function collect(stream: PassThrough, count: number, timeoutMs = 3_000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`collect timeout — got ${messages.length}/${count} messages`));
    }, timeoutMs);
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === '') continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          messages.push({ raw: line });
        }
        if (messages.length >= count) {
          clearTimeout(timer);
          resolve(messages);
          return;
        }
      }
    });
  });
}

describe('JSON-RPC gateway wire (gap #25 slice 3)', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
  });

  it('responds to gateway.version with the registered method list', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startGatewayServer(stdin, stdout, cfg(1));
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway.version' }) + '\n');

    const [msg] = (await collect(stdout, 1)) as Array<Record<string, unknown>>;
    expect(msg['jsonrpc']).toBe('2.0');
    expect(msg['id']).toBe(1);
    const result = msg['result'] as { methods: string[]; protocol: string };
    expect(result.protocol).toBe('jsonrpc-2.0');
    expect(result.methods).toContain('agents.snapshot');
  });

  it('proxies agents.snapshot through to the dashboard HTTP server', async () => {
    const payload = { spawned: [], slotsUsed: 0, slotsMax: 4, queueWaiting: 2 };
    const s = await startServer((req, res) => {
      expect(req.url).toBe('/api/agents/live');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    servers.push(s);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startGatewayServer(stdin, stdout, cfg(s.port));

    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'agents.snapshot' }) + '\n');

    const [msg] = (await collect(stdout, 1)) as Array<Record<string, unknown>>;
    expect(msg['id']).toBe('r1');
    expect(msg['result']).toEqual(payload);
  });

  it('returns MethodNotFound for an unknown method', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startGatewayServer(stdin, stdout, cfg(1));
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'does.not.exist' }) + '\n');

    const [msg] = (await collect(stdout, 1)) as Array<Record<string, unknown>>;
    expect(msg['id']).toBe(2);
    const err = msg['error'] as { code: number; message: string };
    expect(err.code).toBe(JsonRpcErrorCode.MethodNotFound);
    expect(err.message).toContain('does.not.exist');
  });

  it('returns ParseError on malformed JSON', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startGatewayServer(stdin, stdout, cfg(1));
    stdin.write('{not-json}\n');

    const [msg] = (await collect(stdout, 1)) as Array<Record<string, unknown>>;
    expect(msg['id']).toBeNull();
    const err = msg['error'] as { code: number };
    expect(err.code).toBe(JsonRpcErrorCode.ParseError);
  });

  it('returns InvalidRequest when missing jsonrpc/method fields', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startGatewayServer(stdin, stdout, cfg(1));
    // Missing "method"
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5 }) + '\n');

    const [msg] = (await collect(stdout, 1)) as Array<Record<string, unknown>>;
    expect(msg['id']).toBe(5);
    const err = msg['error'] as { code: number };
    expect(err.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it('ignores notifications (no response on the wire)', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startGatewayServer(stdin, stdout, cfg(1));
    // No id → notification per JSON-RPC 2.0
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'gateway.version' }) + '\n');
    // Follow up with a real request so we have something to await.
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'gateway.version' }) + '\n');

    const [msg] = (await collect(stdout, 1)) as Array<Record<string, unknown>>;
    // Only the second (the request) yields a wire message. The first
    // notification produced nothing.
    expect(msg['id']).toBe(99);
  });

  it('handles two consecutive requests on the same connection', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    startGatewayServer(stdin, stdout, cfg(1));
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'gateway.version' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'gateway.version' }) + '\n');

    const msgs = (await collect(stdout, 2)) as Array<Record<string, unknown>>;
    // Numeric comparator to keep this defensive against future tests that use
    // ids like 9 and 10 (lexicographic sort would reverse those).
    expect(msgs.map((m) => m['id']).sort((a, b) => (a as number) - (b as number))).toEqual([10, 11]);
  });
});
