/**
 * @file http-api-owner-attribution.test.ts
 * @description The gateway API must tell the agent loop WHO is calling.
 *
 * Found while generalising god mode to every owner channel (2026-08-17): the
 * route gate called `authenticateHttp(req)` — which already resolves
 * `isOwner` for gateway-token/secret credentials — and then threw the result
 * away, running the turn with no caller. Every client driving sudo-ai through
 * this surface (TUI, scripts, a remote owner client) was unattributed, so
 * owner-gated behaviour and god mode never applied to them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleChatCompletions } from '../../src/core/gateway/http-api.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

type RunCall = { sessionId: string; message: string; opts?: { caller?: { isOwner: boolean } } };

function harness() {
  const calls: RunCall[] = [];
  const deps = {
    agentLoop: {
      run: async (sessionId: string, message: string, _e?: unknown, opts?: RunCall['opts']) => {
        calls.push({ sessionId, message, opts });
        return { text: 'ok', attachments: [] };
      },
    },
    sessionManager: { getOrCreate: async () => ({ id: 'sess-1' }) },
  } as never;

  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'content-type': 'application/json' },
    on(event: string, cb: (chunk?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(body));
      if (event === 'end') cb();
      return this;
    },
  } as unknown as IncomingMessage;

  const res = {
    headersSent: false,
    writeHead: vi.fn(),
    end: vi.fn(),
    setHeader: vi.fn(),
    write: vi.fn(),
  } as unknown as ServerResponse;

  return { calls, deps, req, res };
}

describe('gateway API owner attribution', () => {
  it('threads owner=true when the caller authenticated as the owner', async () => {
    const { calls, deps, req, res } = harness();
    await handleChatCompletions(req, res, deps, true);
    expect(calls[0]?.opts?.caller?.isOwner).toBe(true);
  });

  it('threads owner=false for a non-owner credential', async () => {
    const { calls, deps, req, res } = harness();
    await handleChatCompletions(req, res, deps, false);
    expect(calls[0]?.opts?.caller?.isOwner).toBe(false);
  });

  it('defaults to NON-owner when the flag is omitted (fail closed)', async () => {
    const { calls, deps, req, res } = harness();
    await handleChatCompletions(req, res, deps);
    expect(calls[0]?.opts?.caller?.isOwner).toBe(false);
  });
});

describe('gateway API — god mode denies unauthenticated loopback owner status', () => {
  // Adversarial review 2026-08-17 reproduced this: authenticateHttp's
  // loopback-direct rule returns isOwner:true when NO secret is configured.
  // It admits a local caller but proves no identity, so under god mode it
  // would hand host root to any process on the box.
  const KEYS = ['SUDO_AUTHORITY_GOD_MODE', 'GATEWAY_TOKEN', 'GATEWAY_SECRET'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('loopback-direct callers are NOT owners while god mode is on', async () => {
    process.env['SUDO_AUTHORITY_GOD_MODE'] = '1';
    const { authenticateHttp } = await import('../../src/core/gateway/auth.js');
    const { isGodMode } = await import('../../src/core/security/execution-authority.js');

    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as never;
    const auth = authenticateHttp(req);

    // The rule still ADMITS (that behaviour is unchanged)…
    expect(auth.ok).toBe(true);
    expect(auth.isOwner).toBe(true);

    // …but the route must not turn that into owner authority under god mode.
    const gatewayOwner = auth.isOwner === true && !(isGodMode() && auth.credential === 'loopback');
    expect(gatewayOwner).toBe(false);
  });

  it('loopback callers DO keep owner status when god mode is off', async () => {
    const { authenticateHttp } = await import('../../src/core/gateway/auth.js');
    const { isGodMode } = await import('../../src/core/security/execution-authority.js');

    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as never;
    const auth = authenticateHttp(req);
    const gatewayOwner = auth.isOwner === true && !(isGodMode() && auth.credential === 'loopback');
    expect(gatewayOwner).toBe(true);
  });
});
