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

import { describe, it, expect, vi } from 'vitest';
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
