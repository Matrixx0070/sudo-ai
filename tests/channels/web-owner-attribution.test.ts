/**
 * @file web-owner-attribution.test.ts
 * @description Web chat may ADMIT a loopback/LAN client without a token, but
 * it must never call that client the OWNER.
 *
 * Two adversarial-review findings drive this file (2026-08-16):
 *   1. cli.ts dispatched EVERY web turn as `isOwner: true` while the adapter
 *      skips auth on loopback/LAN — behind a reverse proxy every client looks
 *      like 127.0.0.1, so any caller was "the owner".
 *   2. The first fix cached the proof on the ADAPTER, so a tokenless
 *      WebSocket (admitted by the same bypass) inherited owner status from
 *      the last owner HTTP request — reproduced as real-host root under god
 *      mode. Owner-proof must be per-connection and per-request.
 *
 * These tests drive a REAL server over a REAL socket, because the earlier
 * version of this file pre-set the internal flag and passed while both holes
 * were open.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { WebAdapter } from '../../src/core/channels/web.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';

const TOKEN = 'owner-token-under-test';
let saved: Record<string, string | undefined> = {};
let adapter: WebAdapter;
let server: http.Server;
let port: number;
let seen: UnifiedMessage[];

beforeEach(async () => {
  saved = {
    WEB_CHAT_TOKEN: process.env['WEB_CHAT_TOKEN'],
    WEB_CHAT_ENABLED: process.env['WEB_CHAT_ENABLED'],
    WEB_CHAT_PORT: process.env['WEB_CHAT_PORT'],
  };
  process.env['WEB_CHAT_TOKEN'] = TOKEN;
  process.env['WEB_CHAT_ENABLED'] = 'true';
  seen = [];
  adapter = new WebAdapter();
  adapter.onMessage(async (m) => { seen.push(m); });

  // The adapter attaches to an already-bound gateway server (it never listens
  // itself), so the test owns the server exactly like the gateway does.
  server = http.createServer();
  adapter.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
  process.env['WEB_CHAT_PORT'] = String(port);
});

afterEach(async () => {
  await adapter.stop?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Wait until a message arrives (or fail the test on timeout). */
async function nextMessage(timeoutMs = 4000): Promise<UnifiedMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = seen.shift();
    if (msg) return msg;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no inbound message observed');
}

async function post(path: string, body: unknown): Promise<void> {
  await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function wsSend(query: string, text: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat/ws${query}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(text);
  await new Promise((r) => setTimeout(r, 150));
  ws.close();
}

describe('web chat owner attribution', () => {
  it('POST without the token is admitted on loopback but is NOT owner', async () => {
    await post('/api/message', { peerId: 'attacker', text: 'hello' });
    expect((await nextMessage()).isOwner).toBe(false);
  });

  it('POST proving the token IS owner', async () => {
    await fetch(`http://127.0.0.1:${port}/api/message?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'owner', text: 'hello' }),
    });
    expect((await nextMessage()).isOwner).toBe(true);
  });

  it('a tokenless WS does NOT inherit owner from a prior owner request', async () => {
    // The reproduced exploit: owner proves the token over HTTP…
    await fetch(`http://127.0.0.1:${port}/api/message?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId: 'owner', text: 'owner turn' }),
    });
    expect((await nextMessage()).isOwner).toBe(true);

    // …then an unauthenticated socket connects and must NOT be the owner.
    await wsSend('', 'attacker turn');
    expect((await nextMessage()).isOwner).toBe(false);
  });

  it('a WS that proves the token IS owner', async () => {
    await wsSend(`?token=${TOKEN}`, 'owner ws turn');
    expect((await nextMessage()).isOwner).toBe(true);
  });

  it('owner status is boolean on every path (god mode requires an explicit answer)', async () => {
    await post('/api/message', { peerId: 'p', text: 'x' });
    expect(typeof (await nextMessage()).isOwner).toBe('boolean');
  });
});
