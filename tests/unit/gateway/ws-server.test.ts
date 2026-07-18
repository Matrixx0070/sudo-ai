/**
 * Unit tests for attachWsRpc (ws-server.ts).
 *
 * Each test spins up a real http.Server + WebSocketServer on a random port so
 * we exercise the actual upgrade / auth / dispatch flow.  All servers and
 * clients are closed in afterEach to prevent handle leaks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { attachWsRpc } from '../../../src/core/gateway/ws-server.js';
import type { WsServerDeps } from '../../../src/core/gateway/ws-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<WsServerDeps> = {}): WsServerDeps {
  return {
    httpServer: null as never, // filled in by startServer()
    sessionManager: null,
    toolRegistry: null,
    agentLoop: null,
    cronManager: null,
    hookManager: null,
    ...overrides,
  };
}

interface TestServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

async function startServer(
  deps?: Partial<WsServerDeps>,
  secret?: string,
  path?: string,
): Promise<TestServer> {
  const server = http.createServer();
  // Track all connections so we can force-close them in teardown
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const fullDeps: WsServerDeps = {
    ...makeDeps(deps),
    httpServer: server,
  };

  attachWsRpc(fullDeps, { secret, path });

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-destroy all tracked sockets first so server.close() resolves
        // immediately rather than waiting for keep-alive timeout.
        for (const s of sockets) {
          s.destroy();
        }
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function connectWs(port: number, queryString = ''): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}/ws${queryString}`;
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
}

function sendAndReceive(ws: WebSocket, payload: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for response')), 5000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw.toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    ws.send(JSON.stringify(payload));
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', () => resolve());
    ws.close();
  });
}

/**
 * Send a raw HTTP Upgrade request via a net.Socket.
 * Resolves with the first chunk of the server's response data, or 'no-response'
 * if nothing arrives within timeoutMs, or 'error' on socket error.
 * Always destroys the socket before resolving.
 */
function rawUpgradeRequest(
  port: number,
  reqPath: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const request =
        `GET ${reqPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Connection: Upgrade\r\n` +
        `Upgrade: websocket\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`;
      socket.write(request);
    });

    const done = (result: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => done('no-response'), timeoutMs);
    socket.once('data', (chunk) => done(chunk.toString('utf8')));
    socket.once('error', () => done('error'));
    socket.once('close', () => done('no-response'));
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('attachWsRpc (ws-server)', () => {
  let testServer: TestServer;
  let ws: WebSocket | null = null;

  afterEach(async () => {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await closeWs(ws);
      ws = null;
    }
    if (testServer) {
      await testServer.close().catch(() => {/* ignore */});
    }
  });

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  describe('WebSocket connection', () => {
    it('accepts a WebSocket connection on /ws', async () => {
      testServer = await startServer();
      ws = await connectWs(testServer.port);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('does NOT respond with HTTP 101 for upgrade requests to non-ws paths', async () => {
      testServer = await startServer({}, undefined, '/ws');
      // Server ignores upgrade to /other-path — returns nothing or sends close.
      const response = await rawUpgradeRequest(testServer.port, '/other-path', 500);
      // Expected: either no response at all (server ignored) or no 101 upgrade
      if (response !== 'no-response' && response !== 'error') {
        expect(response).not.toContain('HTTP/1.1 101');
      } else {
        // 'no-response' or 'error' both confirm the server did not upgrade
        expect(true).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Auth token check
  // -------------------------------------------------------------------------

  describe('auth token check', () => {
    it('accepts connection with valid token', async () => {
      testServer = await startServer({}, 'secret-abc');
      ws = await connectWs(testServer.port, '?token=secret-abc');
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('rejects connection with wrong token (HTTP 401)', async () => {
      testServer = await startServer({}, 'correct-secret');
      await expect(connectWs(testServer.port, '?token=wrong-token')).rejects.toThrow('HTTP 401');
    });

    it('rejects connection with missing token (HTTP 401)', async () => {
      testServer = await startServer({}, 'correct-secret');
      await expect(connectWs(testServer.port)).rejects.toThrow('HTTP 401');
    });

    it('accepts connection without token when no secret is configured', async () => {
      testServer = await startServer();  // no secret
      ws = await connectWs(testServer.port);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('auth rejection: raw upgrade to /ws with bad token does not produce 101', async () => {
      testServer = await startServer({}, 'supersecret');
      const response = await rawUpgradeRequest(testServer.port, '/ws?token=wrong', 2000);
      // Server writes HTTP 401 and destroys the socket
      if (response !== 'no-response' && response !== 'error') {
        expect(response).toContain('401');
      } else {
        // Socket was closed without 101 = also correct
        expect(true).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // RPC: health method
  // -------------------------------------------------------------------------

  describe('RPC dispatch — health', () => {
    it('responds to "health" with status "ok"', async () => {
      testServer = await startServer();
      ws = await connectWs(testServer.port);
      const resp = await sendAndReceive(ws, { id: '1', method: 'health' }) as { id: string; result: { status: string } };
      expect(resp.id).toBe('1');
      expect(resp.result.status).toBe('ok');
    });

    it('"health" response includes uptime as a number', async () => {
      testServer = await startServer();
      ws = await connectWs(testServer.port);
      const resp = await sendAndReceive(ws, { id: '2', method: 'health' }) as { result: { uptime: unknown } };
      expect(typeof resp.result.uptime).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // RPC: known stub methods
  // -------------------------------------------------------------------------

  describe('RPC dispatch — stub methods', () => {
    beforeEach(async () => {
      testServer = await startServer();
      ws = await connectWs(testServer.port);
    });

    it('responds to "tools.catalog" with an array', async () => {
      const resp = await sendAndReceive(ws!, { id: '3', method: 'tools.catalog' }) as { result: unknown };
      expect(Array.isArray(resp.result)).toBe(true);
    });

    it('responds to "sessions.list" with an array', async () => {
      const resp = await sendAndReceive(ws!, { id: '4', method: 'sessions.list' }) as { result: unknown };
      expect(Array.isArray(resp.result)).toBe(true);
    });

    it('responds to "cron.list" with an array', async () => {
      const resp = await sendAndReceive(ws!, { id: '5', method: 'cron.list' }) as { result: unknown };
      expect(Array.isArray(resp.result)).toBe(true);
    });

    it('responds to "chat.abort" with status', async () => {
      const resp = await sendAndReceive(ws!, { id: '6', method: 'chat.abort' }) as { result: { status: string } };
      expect(resp.result.status).toBe('abort not supported');
    });

    it('echoes the request id back in the response', async () => {
      const resp = await sendAndReceive(ws!, { id: 'unique-id-xyz', method: 'health' }) as { id: string };
      expect(resp.id).toBe('unique-id-xyz');
    });
  });

  // -------------------------------------------------------------------------
  // RPC: error cases
  // -------------------------------------------------------------------------

  describe('RPC error cases', () => {
    beforeEach(async () => {
      testServer = await startServer();
      ws = await connectWs(testServer.port);
    });

    it('returns -32700 (Parse error) for invalid JSON', async () => {
      const resp = await new Promise<{ error: { code: number } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        ws!.once('message', (raw) => {
          clearTimeout(timer);
          resolve(JSON.parse(raw.toString()) as { error: { code: number } });
        });
        ws!.send('NOT VALID JSON {{{');
      });
      expect(resp.error.code).toBe(-32700);
    });

    it('returns -32600 (Invalid Request) when id or method are missing', async () => {
      const resp = await sendAndReceive(ws!, { data: 'missing both id and method' }) as { error: { code: number } };
      expect(resp.error.code).toBe(-32600);
    });

    it('returns -32600 when message is a JSON array (not an object)', async () => {
      const resp = await new Promise<{ error: { code: number } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        ws!.once('message', (raw) => {
          clearTimeout(timer);
          resolve(JSON.parse(raw.toString()) as { error: { code: number } });
        });
        ws!.send(JSON.stringify([1, 2, 3]));
      });
      expect(resp.error.code).toBe(-32600);
    });

    it('returns -32601 (Method not found) for unknown method', async () => {
      const resp = await sendAndReceive(ws!, { id: '7', method: 'no.such.method' }) as { error: { code: number } };
      expect(resp.error.code).toBe(-32601);
    });

    it('-32601 error message mentions the unknown method name', async () => {
      const resp = await sendAndReceive(ws!, { id: '8', method: 'does.not.exist' }) as { error: { message: string } };
      expect(resp.error.message).toContain('does.not.exist');
    });

    it('returns -32600 when id is missing but method is present', async () => {
      const resp = await new Promise<{ error: { code: number } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        ws!.once('message', (raw) => {
          clearTimeout(timer);
          resolve(JSON.parse(raw.toString()) as { error: { code: number } });
        });
        ws!.send(JSON.stringify({ method: 'health' })); // no id
      });
      expect(resp.error.code).toBe(-32600);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple sequential requests on the same connection
  // -------------------------------------------------------------------------

  describe('sequential requests on one connection', () => {
    it('handles multiple requests independently', async () => {
      testServer = await startServer();
      ws = await connectWs(testServer.port);

      const collect = (count: number): Promise<object[]> =>
        new Promise((resolve) => {
          const results: object[] = [];
          ws!.on('message', (raw) => {
            results.push(JSON.parse(raw.toString()) as object);
            if (results.length === count) resolve(results);
          });
        });

      const p = collect(3);
      ws.send(JSON.stringify({ id: 'a', method: 'health' }));
      ws.send(JSON.stringify({ id: 'b', method: 'tools.catalog' }));
      ws.send(JSON.stringify({ id: 'c', method: 'no.method.here' }));

      const responses = await p;
      expect(responses).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------------------
// RPC v2 handshake (Slice C/2) — gated by SUDO_GATEWAY_RPC_V2=1
// ---------------------------------------------------------------------------

describe('attachWsRpc — RPC v2 handshake (SUDO_GATEWAY_RPC_V2=1)', () => {
  let testServer: TestServer;
  let ws: WebSocket | null = null;
  const savedV2 = process.env['SUDO_GATEWAY_RPC_V2'];

  beforeEach(() => { process.env['SUDO_GATEWAY_RPC_V2'] = '1'; });
  afterEach(async () => {
    if (ws && ws.readyState !== WebSocket.CLOSED) await closeWs(ws);
    ws = null;
    if (testServer) await testServer.close();
    if (savedV2 === undefined) delete process.env['SUDO_GATEWAY_RPC_V2'];
    else process.env['SUDO_GATEWAY_RPC_V2'] = savedV2;
  });

  it('connect returns hello-ok with scopes + methods', async () => {
    testServer = await startServer(); // no secret → loopback → admin principal
    ws = await connectWs(testServer.port);
    const res = await sendAndReceive(ws, { id: '1', method: 'connect', params: {} }) as {
      id: string; result?: { type: string; scopes: string[]; methods: string[] };
    };
    expect(res.id).toBe('1');
    expect(res.result?.type).toBe('hello-ok');
    expect(res.result?.scopes).toContain('operator.admin');
    expect(res.result?.methods).toContain('health');
  });

  it('rejects a non-connect first frame (-32001)', async () => {
    testServer = await startServer();
    ws = await connectWs(testServer.port);
    const res = await sendAndReceive(ws, { id: '2', method: 'health' }) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32001);
  });

  it('lets an admin call a scoped method after connect', async () => {
    testServer = await startServer();
    ws = await connectWs(testServer.port);
    await sendAndReceive(ws, { id: '1', method: 'connect', params: {} });
    const res = await sendAndReceive(ws, { id: '2', method: 'health' }) as { id: string; error?: { code: number } };
    expect(res.id).toBe('2');
    expect(res.error?.code).not.toBe(-32001); // not a handshake rejection
    expect(res.error?.code).not.toBe(-32003); // not a scope rejection
  });

  it('rejects a second connect (-32002)', async () => {
    testServer = await startServer();
    ws = await connectWs(testServer.port);
    await sendAndReceive(ws, { id: '1', method: 'connect', params: {} });
    const res = await sendAndReceive(ws, { id: '2', method: 'connect', params: {} }) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32002);
  });
});


// ---------------------------------------------------------------------------
// GW-8: idempotency + backpressure + preauth flood control (SUDO_GATEWAY_RPC_V2=1)
// ---------------------------------------------------------------------------

describe('attachWsRpc — GW-8 hardening (SUDO_GATEWAY_RPC_V2=1)', () => {
  let testServer: TestServer;
  let ws: WebSocket | null = null;
  const savedV2 = process.env['SUDO_GATEWAY_RPC_V2'];

  beforeEach(() => { process.env['SUDO_GATEWAY_RPC_V2'] = '1'; });
  afterEach(async () => {
    if (ws && ws.readyState !== WebSocket.CLOSED) await closeWs(ws);
    ws = null;
    if (testServer) await testServer.close();
    if (savedV2 === undefined) delete process.env['SUDO_GATEWAY_RPC_V2'];
    else process.env['SUDO_GATEWAY_RPC_V2'] = savedV2;
  });

  it('hello-ok advertises the backpressure policy (limits)', async () => {
    testServer = await startServer();
    ws = await connectWs(testServer.port);
    const res = await sendAndReceive(ws, { id: '1', method: 'connect', params: {} }) as {
      result?: { limits?: { maxPayload: number; maxBufferedBytes: number } };
    };
    expect(res.result?.limits?.maxPayload).toBe(512 * 1024);
    expect(res.result?.limits?.maxBufferedBytes).toBe(50 * 1024 * 1024);
  });

  it('a duplicate idempotencyKey executes the handler once and replays the result', async () => {
    let calls = 0;
    const agentLoop = { run: async (_sid: string, _msg: string) => { calls += 1; return { text: 'reply-' + calls, attachments: [] as unknown[] }; } };
    testServer = await startServer({ agentLoop });
    ws = await connectWs(testServer.port);
    await sendAndReceive(ws, { id: 'c', method: 'connect', params: {} });

    const first = await sendAndReceive(ws, { id: '1', method: 'sessions.send', params: { sessionId: 's', message: 'hi' }, idempotencyKey: 'dup-1' }) as { result?: { text: string } };
    const second = await sendAndReceive(ws, { id: '2', method: 'sessions.send', params: { sessionId: 's', message: 'hi' }, idempotencyKey: 'dup-1' }) as { result?: { text: string } };

    expect(calls).toBe(1);
    expect(first.result?.text).toBe('reply-1');
    expect(second.result?.text).toBe('reply-1');
  });

  it('rejects a mutating method with no idempotencyKey (-32602)', async () => {
    testServer = await startServer({ agentLoop: { run: async () => ({ text: 'x', attachments: [] }) } });
    ws = await connectWs(testServer.port);
    await sendAndReceive(ws, { id: 'c', method: 'connect', params: {} });
    const res = await sendAndReceive(ws, { id: '1', method: 'sessions.send', params: { sessionId: 's', message: 'hi' } }) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32602);
  });

  it('closes the connection (1008) after too many unauthorized pre-connect frames', async () => {
    testServer = await startServer();
    ws = await connectWs(testServer.port);
    const closed = new Promise<number>((resolve) => { ws!.once('close', (code) => resolve(code)); });
    // Spam non-connect frames before the handshake — each is unauthorized.
    for (let i = 0; i < 12; i++) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: String(i), method: 'health' }));
    }
    const code = await closed;
    expect(code).toBe(1008);
  });

  it('closes the connection (1009) on an oversized preauth frame', async () => {
    testServer = await startServer();
    ws = await connectWs(testServer.port);
    const closed = new Promise<number>((resolve) => { ws!.once('close', (code) => resolve(code)); });
    const big = 'x'.repeat(70 * 1024);
    ws.send(JSON.stringify({ id: '1', method: 'connect', params: { pad: big } }));
    const code = await closed;
    expect(code).toBe(1009);
  });
});
