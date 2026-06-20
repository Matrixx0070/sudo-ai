/**
 * @file tests/gateway/response-cache.test.ts
 * @description Gateway response cache (orphan wiring). Covers the previously
 * untested cache module (getCacheKey / cacheGet / cacheSet — TTL + LRU) and the
 * handleChatCompletions integration: a repeated identical request (same session)
 * is served from cache (skipping the agent) under SUDO_RESPONSE_CACHE=1, while
 * different sessions, the flag-off path, and streaming are never cached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { getCacheKey, cacheGet, cacheSet, cacheClear } from '../../src/core/gateway/cache.js';
import { handleChatCompletions, type HttpApiDeps } from '../../src/core/gateway/http-api.js';

// The cache store is a module-level singleton — flush it (and the hit/miss
// counters) before each test so cross-test state can't skew hit counts.
beforeEach(() => cacheClear());

// --- module-level cache unit tests --------------------------------------------

describe('gateway cache module', () => {
  it('getCacheKey is deterministic on identical bodies and varies by last message', () => {
    const a = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] });
    const b = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello' }] });
    const c = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'different' }] });
    expect(getCacheKey(a)).toBe(getCacheKey(b));
    expect(getCacheKey(a)).not.toBe(getCacheKey(c));
  });

  it('cacheSet/cacheGet round-trips and expires after the TTL', () => {
    vi.useFakeTimers();
    try {
      cacheSet('unit-k1', 'payload-1');
      expect(cacheGet('unit-k1')).toBe('payload-1');
      vi.advanceTimersByTime(61_000); // past the 60s TTL
      expect(cacheGet('unit-k1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cacheGet returns null for an absent key', () => {
    expect(cacheGet('unit-absent-key')).toBeNull();
  });
});

// --- handler integration ------------------------------------------------------

function mockReq(body: string, ip = '10.0.0.1'): EventEmitter & Record<string, unknown> {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req['socket'] = { remoteAddress: ip };
  req['url'] = '/v1/chat/completions';
  req['method'] = 'POST';
  req['headers'] = {};
  // Emit the body after readBody() has attached its listeners (next macrotask).
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}

function mockRes(): Record<string, unknown> {
  const res: Record<string, unknown> = { headersSent: false, statusCode: 0, body: '' };
  res['writeHead'] = (s: number) => { res['statusCode'] = s; res['headersSent'] = true; return res; };
  res['write'] = () => true;
  res['end'] = (p?: string) => { if (p) res['body'] = p; res['ended'] = true; return res; };
  res['destroy'] = () => {};
  return res;
}

function makeDeps(): { deps: HttpApiDeps; runCalls: () => number } {
  let calls = 0;
  const deps = {
    sessionManager: { getOrCreate: async (_ch: string, peer: string) => ({ id: `sess-${peer}` }) },
    agentLoop: { run: async () => { calls++; return { text: `answer-${calls}`, attachments: [] }; } },
  } as unknown as HttpApiDeps;
  return { deps, runCalls: () => calls };
}

function body(content: string, stream = false): string {
  return JSON.stringify({ model: 'sudo-ai-v5', stream, messages: [{ role: 'user', content }] });
}

async function call(deps: HttpApiDeps, b: string, ip = '10.0.0.1'): Promise<Record<string, unknown>> {
  const res = mockRes();
  await handleChatCompletions(mockReq(b, ip) as never, res as never, deps);
  return res;
}

describe('handleChatCompletions response cache wiring', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_RESPONSE_CACHE']; });
  afterEach(() => { if (saved === undefined) delete process.env['SUDO_RESPONSE_CACHE']; else process.env['SUDO_RESPONSE_CACHE'] = saved; });

  it('CACHE-1: flag on → identical same-session request is served from cache (agent NOT re-run)', async () => {
    process.env['SUDO_RESPONSE_CACHE'] = '1';
    const { deps, runCalls } = makeDeps();
    const b = body('cache-hit-probe-1');
    const r1 = await call(deps, b, '10.1.1.1');
    const r2 = await call(deps, b, '10.1.1.1');
    expect(runCalls()).toBe(1);              // second call hit the cache
    expect(r2['body']).toBe(r1['body']);     // identical response
    expect(r2['statusCode']).toBe(200);
  });

  it('CACHE-2: flag off → no caching (agent runs every time)', async () => {
    delete process.env['SUDO_RESPONSE_CACHE'];
    const { deps, runCalls } = makeDeps();
    const b = body('cache-off-probe-2');
    await call(deps, b, '10.2.2.2');
    await call(deps, b, '10.2.2.2');
    expect(runCalls()).toBe(2);
  });

  // Mock-level: sessionId here is derived from the IP. The real cross-client
  // isolation guarantee comes from SessionManager.getOrCreate (one session per
  // client) — this test verifies the cache key threads sessionId through.
  it('CACHE-3: per-session keying → different clients do not share a cache entry', async () => {
    process.env['SUDO_RESPONSE_CACHE'] = '1';
    const { deps, runCalls } = makeDeps();
    const b = body('cross-client-probe-3');
    await call(deps, b, '10.3.3.3');
    await call(deps, b, '10.3.3.4'); // different IP → different session
    expect(runCalls()).toBe(2);
  });

  it('CACHE-4: streaming requests are never cached', async () => {
    process.env['SUDO_RESPONSE_CACHE'] = '1';
    const { deps, runCalls } = makeDeps();
    const b = body('stream-probe-4', true);
    await call(deps, b, '10.4.4.4');
    await call(deps, b, '10.4.4.4');
    expect(runCalls()).toBe(2);
  });
});
