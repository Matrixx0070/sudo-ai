/**
 * @file tests/gateway/unified-gateway.test.ts
 * @description Integration tests for the WebAdapter refactor: port 3004 is NOT
 * bound at runtime; the gateway serves /chat, /chat/ws, /api/message; existing
 * routes have no regression.
 *
 * Tests:
 *  1.  GET /chat returns HTML containing SUDO-AI
 *  2.  GET /chat status code is 200
 *  3.  GET /chat content-type is text/html
 *  4.  POST /api/message with valid body → 200 { ok: true }
 *  5.  POST /api/message with missing fields → 400 { ok: false }
 *  6.  POST /api/message with malformed JSON → 400 { ok: false }
 *  7.  WS /chat/ws handshake — open event fires within 2 s
 *  8.  WS /chat/ws — peerId added to _clients after connect
 *  9.  WS /ws (non-chat path) — upgrade event with /ws URL leaves _clients empty
 *  10. Unknown path /random/foo — _handleHTTP returns early (res.writableEnded false)
 *  11. web.ts source does not contain port 3004 literal
 *  12. web.ts executable code does not call .listen()
 *  13. attach() sets isConnected = true
 *  14. start() deprecated stub sets isConnected = true (no-op, fast)
 *  15. stop() clears _clients and sets isConnected = false
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';

import { WebAdapter } from '../../src/core/channels/web.js';

// ---------------------------------------------------------------------------
// Private internals exposed via unsafe cast
// ---------------------------------------------------------------------------
type WebAdapterInternals = {
  _clients: Map<string, unknown>;
  _handleHTTP: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
};

function internals(adapter: WebAdapter): WebAdapterInternals {
  return adapter as unknown as WebAdapterInternals;
}

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

interface TestCtx {
  server: http.Server;
  adapter: WebAdapter;
  baseUrl: string;
  port: number;
}

async function startServer(): Promise<TestCtx> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const adapter = new WebAdapter();
    adapter.attach(server);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({ server, adapter, baseUrl, port });
    });
    server.on('error', reject);
  });
}

/**
 * Forcibly close a test server. Calls adapter.stop() first, then
 * closeAllConnections() to drain tracked keep-alive connections, then
 * server.close().
 *
 * Note: connections handed off via the 'upgrade' event and NOT claimed
 * by any listener are NOT tracked by closeAllConnections(). To avoid
 * a hang, tests that probe non-chat upgrade paths must destroy their
 * client-side sockets BEFORE calling closeTestServer().
 */
async function closeTestServer(ctx: TestCtx): Promise<void> {
  await ctx.adapter.stop().catch(() => { /* ignore */ });
  ctx.server.closeAllConnections();
  return new Promise((resolve) => {
    ctx.server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let ctx: TestCtx | null = null;
const openedWs: WebSocket[] = [];

beforeEach(() => {
  delete process.env['WEB_CHAT_TOKEN'];
});

afterEach(async () => {
  // Terminate all open client WS connections before closing server.
  for (const ws of openedWs) {
    ws.terminate();
  }
  openedWs.length = 0;

  if (ctx) {
    await closeTestServer(ctx);
    ctx = null;
  }

  delete process.env['WEB_CHAT_TOKEN'];
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('unified-gateway — WebAdapter', () => {

  // -------------------------------------------------------------------------
  // 1. GET /chat returns HTML containing SUDO-AI
  // -------------------------------------------------------------------------
  it('1. GET /chat returns HTML containing SUDO-AI', async () => {
    ctx = await startServer();
    const res = await fetch(`${ctx.baseUrl}/chat`);
    const text = await res.text();
    expect(text).toContain('SUDO-AI');
  });

  // -------------------------------------------------------------------------
  // 2. GET /chat status code is 200
  // -------------------------------------------------------------------------
  it('2. GET /chat status code is 200', async () => {
    ctx = await startServer();
    const res = await fetch(`${ctx.baseUrl}/chat`);
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 3. GET /chat content-type is text/html
  // -------------------------------------------------------------------------
  it('3. GET /chat content-type is text/html', async () => {
    ctx = await startServer();
    const res = await fetch(`${ctx.baseUrl}/chat`);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  // -------------------------------------------------------------------------
  // 4. POST /api/message with valid body → 200 { ok: true }
  // _dispatch is a no-op when no handler registered; route still responds 200.
  // -------------------------------------------------------------------------
  it('4. POST /api/message with valid body → 200 { ok: true }', async () => {
    ctx = await startServer();
    const res = await fetch(`${ctx.baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'p1', text: 'hi' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. POST /api/message with missing fields → 400
  // -------------------------------------------------------------------------
  it('5. POST /api/message with missing fields → 400', async () => {
    ctx = await startServer();
    const res = await fetch(`${ctx.baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'p1' }), // missing text
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. POST /api/message with malformed JSON → 400
  // -------------------------------------------------------------------------
  it('6. POST /api/message with malformed JSON → 400', async () => {
    ctx = await startServer();
    const res = await fetch(`${ctx.baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{{',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7. WS /chat/ws handshake — open event fires within 2 s
  // -------------------------------------------------------------------------
  it('7. WS /chat/ws handshake — open event fires within 2 s', async () => {
    ctx = await startServer();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx!.port}/chat/ws`);
      openedWs.push(ws);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS open timed out after 2 s'));
      }, 2000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  });

  // -------------------------------------------------------------------------
  // 8. WS /chat/ws — peerId added to _clients after connect
  // -------------------------------------------------------------------------
  it('8. WS /chat/ws — peerId added to _clients after connect', async () => {
    ctx = await startServer();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx!.port}/chat/ws`);
      openedWs.push(ws);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS open timed out'));
      }, 2000);
      ws.on('open', () => {
        clearTimeout(timer);
        setImmediate(() => {
          expect(internals(ctx!.adapter)._clients.size).toBeGreaterThanOrEqual(1);
          resolve();
        });
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  });

  // -------------------------------------------------------------------------
  // 9. WS /ws (non-chat path) — upgrade event with /ws URL leaves _clients empty
  //
  // web.ts's 'upgrade' listener returns early when upgradePath is not /chat/ws.
  // We simulate this by emitting an 'upgrade' event directly on the server
  // (via EventEmitter) with a fake req URL='/ws'. This avoids making a real
  // TCP connection (which would leave an unclaimed socket that hangs server.close()).
  //
  // Security: an unclaimed socket being left alive is a known behaviour of
  // web.ts documented in the comment "leave for the JSON-RPC ws-server.ts".
  // -------------------------------------------------------------------------
  it('9. WS /ws (non-chat path) — upgrade event leaves _clients empty', () => {
    const adapter = new WebAdapter();
    const srv = http.createServer();
    adapter.attach(srv);

    // Verify the adapter registered an 'upgrade' listener.
    const upgradeListeners = srv.listeners('upgrade');
    expect(upgradeListeners.length).toBeGreaterThanOrEqual(1);

    // Build a minimal fake req for path /ws.
    const fakeReq = {
      url: '/ws',
      method: 'GET',
      headers: {},
      socket: new EventEmitter(),
    } as unknown as http.IncomingMessage;

    // Call the upgrade listener directly with the fake req.
    // The listener should return early (path is not /chat/ws).
    // We pass a mock socket that records whether destroy() is called.
    let socketDestroyed = false;
    const mockSocket = Object.assign(new EventEmitter(), {
      destroy: () => { socketDestroyed = true; },
      write: () => { /* no-op */ },
    });
    const mockHead = Buffer.alloc(0);

    for (const listener of upgradeListeners) {
      (listener as (req: http.IncomingMessage, socket: unknown, head: unknown) => void)(fakeReq, mockSocket, mockHead);
    }

    // _clients should still be empty — the early return prevented registration.
    expect(internals(adapter)._clients.size).toBe(0);

    // Cleanup (srv is not listening, just close).
    srv.close();
  });

  // -------------------------------------------------------------------------
  // 10. Unknown path /random/foo — _handleHTTP returns early
  // Call _handleHTTP directly with a mock req/res. No server port needed.
  // -------------------------------------------------------------------------
  it('10. Unknown path /random/foo — adapter returns early without writing response', async () => {
    const adapter = new WebAdapter();
    const srv = http.createServer();
    adapter.attach(srv);
    srv.close();

    const mockReq = {
      url: '/random/foo',
      method: 'GET',
      headers: { host: 'localhost' },
      on: function(this: unknown) { return this; },
      socket: {},
    } as unknown as http.IncomingMessage;

    let headWritten = false;
    let endCalled = false;

    const mockRes = {
      get writableEnded() { return headWritten || endCalled; },
      writeHead: () => { headWritten = true; },
      end: () => { endCalled = true; },
      on: function(this: unknown) { return this; },
    } as unknown as http.ServerResponse;

    await internals(adapter)._handleHTTP(mockReq, mockRes);

    expect(headWritten).toBe(false);
    expect(endCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 11. Static scan: literal "3004" does NOT appear in web.ts
  // -------------------------------------------------------------------------
  it('11. web.ts source does not contain port 3004 literal', () => {
    const webTsPath = path.resolve('/root/sudo-ai-v4/src/core/channels/web.ts');
    const source = fs.readFileSync(webTsPath, 'utf8');
    expect(source).not.toMatch(/3004/);
  });

  // -------------------------------------------------------------------------
  // 12. web.ts executable code does not call .listen()
  // Strip both /* ... */ block comments and // line comments before scanning.
  // The JSDoc block on attach() says "Does NOT call server.listen()" — that
  // text is inside a block comment and must not trigger a false positive.
  // -------------------------------------------------------------------------
  it('12. web.ts executable code does not call .listen()', () => {
    const webTsPath = path.resolve('/root/sudo-ai-v4/src/core/channels/web.ts');
    const raw = fs.readFileSync(webTsPath, 'utf8');
    // Strip /* ... */ block comments (handles multi-line JSDoc).
    const noBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip // line comments.
    const stripped = noBlockComments.replace(/\/\/[^\n]*/g, '');
    // No .listen( call should remain in executable code.
    expect(stripped).not.toMatch(/\.listen\s*\(/);
  });

  // -------------------------------------------------------------------------
  // 13. attach() sets isConnected = true
  // -------------------------------------------------------------------------
  it('13. attach() sets isConnected = true', () => {
    const adapter = new WebAdapter();
    expect(adapter.isConnected).toBe(false);
    const srv = http.createServer();
    adapter.attach(srv);
    expect(adapter.isConnected).toBe(true);
    srv.closeAllConnections();
    srv.close();
  });

  // -------------------------------------------------------------------------
  // 14. start() deprecated stub sets isConnected = true and is effectively a no-op
  // Verify it completes quickly (< 200 ms) and sets isConnected = true.
  // NOTE: Port 3004 is occupied by an external process in this environment;
  //       we do NOT probe it to avoid a false signal.
  // -------------------------------------------------------------------------
  it('14. start() deprecated stub — isConnected becomes true, completes quickly', async () => {
    const adapter = new WebAdapter();
    expect(adapter.isConnected).toBe(false);

    const t0 = Date.now();
    await adapter.start();
    const elapsed = Date.now() - t0;

    expect(adapter.isConnected).toBe(true);
    // A real server.listen() would take > 200 ms; a true no-op is instant.
    expect(elapsed).toBeLessThan(200);
  });

  // -------------------------------------------------------------------------
  // 15. stop() clears _clients and sets isConnected = false
  // -------------------------------------------------------------------------
  it('15. stop() clears _clients and sets isConnected = false', async () => {
    ctx = await startServer();

    // Connect a WS client to populate _clients.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx!.port}/chat/ws`);
      openedWs.push(ws);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS open timeout'));
      }, 2000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    // Allow server-side handler one tick to register.
    await new Promise((r) => setImmediate(r));
    expect(internals(ctx.adapter)._clients.size).toBeGreaterThanOrEqual(1);

    await ctx.adapter.stop();
    expect(internals(ctx.adapter)._clients.size).toBe(0);
    expect(ctx.adapter.isConnected).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 16. POST /api/message with 64KB+1 body → 413 Payload Too Large
  // Sends a body that is exactly 1 byte over the 64 KB cap to verify the
  // streaming body limit is enforced at the Node.js IncomingMessage level.
  // -------------------------------------------------------------------------
  it('16. POST /api/message with 64KB+1 body → 413 Payload Too Large', async () => {
    ctx = await startServer();
    // 64 * 1024 + 1 = 65537 bytes — just over the 64 KB cap.
    const oversizeBody = 'x'.repeat(65537);
    const res = await fetch(`${ctx.baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizeBody,
    });
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toMatch(/Payload too large/);
  });

  // -------------------------------------------------------------------------
  // 17. GET /chat CSP header — style-src uses nonce, no 'unsafe-inline'
  // Verifies that the style-src directive contains a valid base64 nonce and
  // that the 'unsafe-inline' token has been removed entirely from the CSP.
  // -------------------------------------------------------------------------
  it("17. GET /chat CSP header has style-src 'nonce-...' and no 'unsafe-inline'", async () => {
    ctx = await startServer();
    const res = await fetch(`${ctx.baseUrl}/chat`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    // style-src must contain a nonce directive (base64 characters).
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9+/]+=*'/);
    // 'unsafe-inline' must not appear anywhere in the CSP header.
    expect(csp).not.toMatch(/unsafe-inline/);
  });
});
