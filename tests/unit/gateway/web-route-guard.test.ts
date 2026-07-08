/**
 * @file tests/unit/gateway/web-route-guard.test.ts
 * @description Regression tests for the installed-layout /api/message hang.
 *
 * Root cause: gateway handleRequest allowlisted /chat, /assets/* and
 * /api/message to "fall through" to the WebAdapter's sibling request
 * listener — but when the web channel never attached (WEB_CHAT_ENABLED not
 * 'true', which is what a fresh `sudo-ai quickstart` install used to produce),
 * NO listener ever wrote a response: the socket hung until client timeout
 * (curl: 000) and the message was silently dropped (no session, no persisted
 * user message), while /health stayed 200.
 *
 * These tests pin the fix: web routes answer 503 with an actionable error
 * when the web adapter is not attached, and still fall through untouched once
 * a route owner has marked itself attached.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';

// Pick a random free port BEFORE importing server.ts (GATEWAY_PORT is read at
// module load). Bind a throwaway server on :0 to discover a free port.
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

interface Resp { status: number; body: string }

function request(port: number, method: string, path: string, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' }, timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('timeout', () => { req.destroy(new Error('request timed out — handler never responded')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let port: number;
let serverMod: typeof import('../../../src/core/gateway/server.js');

beforeAll(async () => {
  port = await findFreePort();
  process.env['GATEWAY_PORT'] = String(port);
  serverMod = await import('../../../src/core/gateway/server.js');
  await serverMod.startGateway();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    serverMod.gatewayServer?.close(() => resolve());
    serverMod.gatewayServer?.closeAllConnections?.();
  });
});

describe('gateway web-route guard (installed-layout /api/message hang)', () => {
  it('answers POST /api/message with 503 (not a hang) when the web adapter is not attached', async () => {
    const res = await request(port, 'POST', '/api/message', JSON.stringify({ peerId: 't', text: 'hi' }));
    expect(res.status).toBe(503);
    const parsed = JSON.parse(res.body) as { error: { message: string; type: string } };
    expect(parsed.error.type).toBe('gateway_error');
    expect(parsed.error.message).toContain('WEB_CHAT_ENABLED');
  });

  it('answers GET /chat with 503 when the web adapter is not attached', async () => {
    const res = await request(port, 'GET', '/chat');
    expect(res.status).toBe(503);
  });

  it('falls through to the sibling listener once the web owner is attached', async () => {
    // Simulate WebAdapter.attach(): mark the owner + register a sibling listener.
    serverMod.markGatewayRouteOwnerAttached('web');
    const sibling = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'POST' && path === '/api/message') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      }
    };
    serverMod.gatewayServer!.on('request', sibling);
    try {
      const res = await request(port, 'POST', '/api/message', JSON.stringify({ peerId: 't', text: 'hi' }));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    } finally {
      serverMod.gatewayServer!.removeListener('request', sibling);
      serverMod.markGatewayRouteOwnerDetached('web');
    }
  });

  it('returns to 503 after the web owner detaches (WebAdapter.stop)', async () => {
    const res = await request(port, 'POST', '/api/message', JSON.stringify({ peerId: 't', text: 'hi' }));
    expect(res.status).toBe(503);
  });

  it('does not affect unrelated routes (/health stays 200, unknown stays 404)', async () => {
    const health = await request(port, 'GET', '/health');
    expect(health.status).toBe(200);
    const unknown = await request(port, 'GET', '/definitely-not-a-route');
    expect(unknown.status).toBe(404);
  });
});
