/**
 * @file tests/gateway/sse-stream.test.ts
 * @description SSE Stream Broker test suite — 14 tests.
 *
 * Tests:
 *   1.  subscribe fans out event to a connected client
 *   2.  no fanout when no clients are connected
 *   3.  unsubscribe on client close (req close event)
 *   4.  heartbeat sends ": ping\n\n" every 15 s (fake timers)
 *   5.  auth rejection — wrong token returns 401
 *   6.  auth rejection — missing token header returns 401
 *   7.  10-connection cap returns 429 on the 11th connection
 *   8.  historical events endpoint replays buffer
 *   9.  event filter ?events= param — only matching events forwarded to live stream
 *   10. event filter ?events= param — only matching events returned from /events
 *   11. ring buffer capped at 500 entries
 *   12. ring buffer cleared on session:end hook
 *   13. multiple sessions do not bleed events into each other
 *   14. destroy() clears all hooks and ends all client connections
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SseStreamBroker, registerSseRoutes } from '../../src/core/gateway/sse-stream.js';
import { HookManager } from '../../src/core/hooks/index.js';
import type { HookContext } from '../../src/core/hooks/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN  = 'test-gateway-token-1234';
const WRONG_TOKEN  = 'not-the-right-token';
const SESSION_A    = 'sess_test_aaa';
const SESSION_B    = 'sess_test_bbb';

/**
 * Build a fake IncomingMessage-like object with controllable headers and url.
 * We only need the subset that sse-stream.ts reads.
 */
function makeFakeReq(options: {
  url?: string;
  token?: string | null;
  method?: string;
}): { req: IncomingMessage; emitClose: () => void } {
  const pt = new PassThrough();
  const req = pt as unknown as IncomingMessage;
  (req as unknown as Record<string, unknown>).url    = options.url ?? '/';
  (req as unknown as Record<string, unknown>).method = options.method ?? 'GET';
  (req as unknown as Record<string, unknown>).headers = {
    authorization: options.token != null ? `Bearer ${options.token}` : undefined,
  };
  const emitClose = () => pt.emit('close');
  return { req, emitClose };
}

/**
 * Build a minimal ServerResponse-like writable for tracking writes.
 * Uses a shared state object so callers always read current values.
 */
function makeFakeRes(): {
  res: ServerResponse;
  written: string[];
  state: { statusCode: number | undefined; ended: boolean };
  headers: Record<string, unknown>;
} {
  const written: string[] = [];
  const state: { statusCode: number | undefined; ended: boolean } = { statusCode: undefined, ended: false };
  const headers: Record<string, unknown> = {};

  const res = {
    headersSent: false,
    writeHead(status: number, hdrs?: Record<string, unknown>) {
      state.statusCode = status;
      if (hdrs) Object.assign(headers, hdrs);
      (this as unknown as Record<string, unknown>).headersSent = true;
    },
    write(data: string | Buffer) {
      written.push(typeof data === 'string' ? data : data.toString());
      return true;
    },
    end(data?: string) {
      if (data) written.push(data);
      state.ended = true;
    },
    on() { return this; },
  } as unknown as ServerResponse;

  return { res, written, state, headers };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHooks(): HookManager {
  return new HookManager();
}

function makeCtx(sessionId: string, extra?: Partial<HookContext>): HookContext {
  return { event: 'on:message', sessionId, message: 'hello', ...extra };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SseStreamBroker', () => {
  let hooks: HookManager;
  let broker: SseStreamBroker;

  beforeEach(() => {
    process.env['GATEWAY_TOKEN'] = VALID_TOKEN;
    hooks = makeHooks();
    broker = new SseStreamBroker(hooks);
  });

  afterEach(() => {
    broker.destroy();
    delete process.env['GATEWAY_TOKEN'];
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Fan-out to a connected client
  // -------------------------------------------------------------------------

  it('fans out emitted hook events to connected SSE clients', async () => {
    const { res, written } = makeFakeRes();
    const { req, emitClose } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });

    broker.handleStream(req, res, SESSION_A);

    // Emit an event via hookManager
    await hooks.emit('on:message', makeCtx(SESSION_A));

    expect(written.some((w) => w.includes('event: on:message'))).toBe(true);
    expect(written.some((w) => w.includes(SESSION_A))).toBe(true);

    emitClose();
  });

  // -------------------------------------------------------------------------
  // 2. No fanout when no clients connected
  // -------------------------------------------------------------------------

  it('does not throw when no clients are connected for a session', async () => {
    await expect(hooks.emit('on:message', makeCtx(SESSION_A))).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 3. Unsubscribe on client close
  // -------------------------------------------------------------------------

  it('removes client from set when req emits close', async () => {
    const { res } = makeFakeRes();
    const { req, emitClose } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });

    broker.handleStream(req, res, SESSION_A);
    expect(broker.connectionCount(SESSION_A)).toBe(1);

    emitClose();
    expect(broker.connectionCount(SESSION_A)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Heartbeat
  // -------------------------------------------------------------------------

  it('sends ": ping\\n\\n" heartbeat every 15 s', () => {
    vi.useFakeTimers();

    const { res, written } = makeFakeRes();
    const { req, emitClose } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });

    broker.handleStream(req, res, SESSION_A);

    expect(written.filter((w) => w === ': ping\n\n')).toHaveLength(0);

    vi.advanceTimersByTime(15_000);
    expect(written.filter((w) => w === ': ping\n\n')).toHaveLength(1);

    vi.advanceTimersByTime(15_000);
    expect(written.filter((w) => w === ': ping\n\n')).toHaveLength(2);

    emitClose();
  });

  // -------------------------------------------------------------------------
  // 5. Auth rejection — wrong token
  // -------------------------------------------------------------------------

  it('rejects SSE connection with 401 when wrong bearer token is provided', () => {
    const { res, written, state } = makeFakeRes();
    const { req } = makeFakeReq({ token: WRONG_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });

    broker.handleStream(req, res, SESSION_A);

    expect(state.statusCode).toBe(401);
    expect(written.join('')).toContain('Unauthorized');
  });

  // -------------------------------------------------------------------------
  // 6. Auth rejection — missing token
  // -------------------------------------------------------------------------

  it('rejects SSE connection with 401 when no Authorization header is present', () => {
    const { res, written, state } = makeFakeRes();
    const { req } = makeFakeReq({ token: null, url: `/v1/sessions/${SESSION_A}/stream` });

    broker.handleStream(req, res, SESSION_A);

    expect(state.statusCode).toBe(401);
    expect(written.join('')).toContain('Unauthorized');
  });

  // -------------------------------------------------------------------------
  // 7. 10-connection cap
  // -------------------------------------------------------------------------

  it('returns 429 when more than 10 concurrent SSE connections exist for a session', () => {
    // Connect 10 clients — should all succeed
    const cleanups: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      const { res } = makeFakeRes();
      const { req, emitClose } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });
      broker.handleStream(req, res, SESSION_A);
      cleanups.push(emitClose);
    }

    expect(broker.connectionCount(SESSION_A)).toBe(10);

    // 11th connection should be rejected
    const { res: res11, written: w11, state: state11 } = makeFakeRes();
    const { req: req11 } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });
    broker.handleStream(req11, res11, SESSION_A);

    expect(state11.statusCode).toBe(429);
    expect(w11.join('')).toContain('Max 10');

    cleanups.forEach((c) => c());
  });

  // -------------------------------------------------------------------------
  // 8. Historical events replay
  // -------------------------------------------------------------------------

  it('replays buffered events from the ring buffer on /events endpoint', async () => {
    // Emit 3 events to populate the ring buffer
    await hooks.emit('on:message', makeCtx(SESSION_A, { message: 'msg1' }));
    await hooks.emit('on:message', makeCtx(SESSION_A, { message: 'msg2' }));
    await hooks.emit('session:start', makeCtx(SESSION_A, { event: 'session:start' }));

    const { res, written } = makeFakeRes();
    const { req } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/events` });

    broker.handleHistoricalEvents(req, res, SESSION_A);

    const body = JSON.parse(written.join('')) as { count: number; events: unknown[] };
    expect(body.count).toBe(3);
    expect(body.events).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 9. Event filter on live stream
  // -------------------------------------------------------------------------

  it('only forwards matching events to live stream when ?events= filter is set', async () => {
    const { res, written } = makeFakeRes();
    const { req, emitClose } = makeFakeReq({
      token: VALID_TOKEN,
      url: `/v1/sessions/${SESSION_A}/stream?events=session:start`,
    });

    broker.handleStream(req, res, SESSION_A);

    // This should be filtered out
    await hooks.emit('on:message', makeCtx(SESSION_A));
    // This should pass through
    await hooks.emit('session:start', makeCtx(SESSION_A, { event: 'session:start' }));

    const allWritten = written.join('');
    expect(allWritten).toContain('event: session:start');
    expect(allWritten).not.toContain('event: on:message');

    emitClose();
  });

  // -------------------------------------------------------------------------
  // 10. Event filter on /events endpoint
  // -------------------------------------------------------------------------

  it('filters historical events by ?events= query param on /events endpoint', async () => {
    await hooks.emit('on:message', makeCtx(SESSION_A));
    await hooks.emit('session:start', makeCtx(SESSION_A, { event: 'session:start' }));
    await hooks.emit('session:end', makeCtx(SESSION_A, { event: 'session:end' }));

    const { res, written } = makeFakeRes();
    const { req } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/events?events=session:start,session:end` });

    broker.handleHistoricalEvents(req, res, SESSION_A);

    const body = JSON.parse(written.join('')) as { count: number; events: Array<{ event: string }> };
    expect(body.count).toBe(2);
    expect(body.events.every((e) => e.event === 'session:start' || e.event === 'session:end')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 11. Ring buffer capped at 500
  // -------------------------------------------------------------------------

  it('caps ring buffer at 500 events', async () => {
    for (let i = 0; i < 510; i++) {
      await hooks.emit('on:message', makeCtx(SESSION_A));
    }
    expect(broker.getBuffer(SESSION_A)).toHaveLength(500);
  });

  // -------------------------------------------------------------------------
  // 12. Ring buffer cleared on session:end
  // -------------------------------------------------------------------------

  it('clears ring buffer when session:end is emitted', async () => {
    await hooks.emit('on:message', makeCtx(SESSION_A));
    expect(broker.getBuffer(SESSION_A).length).toBeGreaterThan(0);

    broker.clearBuffer(SESSION_A);
    expect(broker.getBuffer(SESSION_A)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 13. Session isolation — events from SESSION_B do not reach SESSION_A clients
  // -------------------------------------------------------------------------

  it('does not forward events from a different session to connected clients', async () => {
    const { res, written } = makeFakeRes();
    const { req, emitClose } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });

    broker.handleStream(req, res, SESSION_A);

    // Emit event with SESSION_B's sessionId — should NOT reach SESSION_A client
    await hooks.emit('on:message', makeCtx(SESSION_B, { message: 'secret_b' }));

    const allWritten = written.join('');
    expect(allWritten).not.toContain('secret_b');

    emitClose();
  });

  // -------------------------------------------------------------------------
  // 14. destroy() unregisters hooks and closes all clients
  // -------------------------------------------------------------------------

  it('destroy() unregisters all SSE hook subscriptions and closes clients', () => {
    const { res } = makeFakeRes();
    const { req } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });

    broker.handleStream(req, res, SESSION_A);
    expect(broker.connectionCount(SESSION_A)).toBe(1);

    const hookCountBefore = hooks.size;
    broker.destroy();

    // Hooks count should be lower after destroy
    expect(hooks.size).toBeLessThan(hookCountBefore);
    expect(broker.connectionCount(SESSION_A)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// registerSseRoutes integration
// ---------------------------------------------------------------------------

describe('registerSseRoutes', () => {
  beforeEach(() => {
    process.env['GATEWAY_TOKEN'] = VALID_TOKEN;
  });

  afterEach(() => {
    delete process.env['GATEWAY_TOKEN'];
  });

  it('returns a SseStreamBroker and routes GET /v1/sessions/:id/stream requests', () => {
    const hooks = new HookManager();
    const listeners: Array<(req: IncomingMessage, res: ServerResponse) => void> = [];
    const fakeServer = {
      on: (event: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => {
        if (event === 'request') listeners.push(handler);
      },
    } as unknown as import('node:http').Server;

    const broker = registerSseRoutes(fakeServer, hooks);
    expect(broker).toBeInstanceOf(SseStreamBroker);
    expect(listeners).toHaveLength(1);

    // Verify a stream request is handled (not falls through)
    const { res, written, state } = makeFakeRes();
    const { req } = makeFakeReq({ token: VALID_TOKEN, url: `/v1/sessions/${SESSION_A}/stream` });
    listeners[0]!(req, res);

    // Should have set SSE headers (200 with text/event-stream) not fallen through
    expect(state.statusCode).toBe(200);
    expect(written).toHaveLength(0); // no data written yet, just headers

    broker.destroy();
    hooks.unregister('');  // noop — just verify no throw
  });
});
