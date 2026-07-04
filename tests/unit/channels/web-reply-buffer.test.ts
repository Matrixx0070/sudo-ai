/**
 * Web reply buffer: a reply that dropped because the client's WS was gone must
 * be buffered and flushed when that peerId reconnects — not silently lost (the
 * "Web send: no active WS connection — dropped" bug seen 14x in prod logs).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebAdapter } from '../../../src/core/channels/web.js';

function fakeSocket() {
  const received: string[] = [];
  return { readyState: 1, OPEN: 1, send: (d: string) => received.push(d), received };
}

// Reach the private buffer/flush + the pending map via a typed reflection helper.
type Internals = {
  _bufferReply(peerId: string, text: string): void;
  _flushPendingReplies(peerId: string, ws: unknown): void;
  _pendingReplies: Map<string, Array<{ text: string; ts: number }>>;
};
function internals(a: WebAdapter): Internals {
  return a as unknown as Internals;
}

describe('WebAdapter reply buffer', () => {
  afterEach(() => { delete process.env['SUDO_WEB_REPLY_BUFFER']; });

  it('flushes a buffered reply to a reconnecting socket', () => {
    const a = new WebAdapter();
    internals(a)._bufferReply('peer1', 'the missed answer');
    const ws = fakeSocket();
    internals(a)._flushPendingReplies('peer1', ws);
    expect(ws.received).toEqual(['the missed answer']);
    // Consumed exactly once — a second reconnect gets nothing.
    const ws2 = fakeSocket();
    internals(a)._flushPendingReplies('peer1', ws2);
    expect(ws2.received).toEqual([]);
  });

  it('drops replies older than the TTL', () => {
    const a = new WebAdapter();
    internals(a)._bufferReply('peer1', 'stale');
    // Backdate the buffered entry beyond the 5-minute TTL.
    internals(a)._pendingReplies.get('peer1')![0]!.ts = Date.now() - 6 * 60_000;
    const ws = fakeSocket();
    internals(a)._flushPendingReplies('peer1', ws);
    expect(ws.received).toEqual([]);
  });

  it('caps buffered replies per peer (keeps the most recent)', () => {
    const a = new WebAdapter();
    for (let i = 0; i < 25; i++) internals(a)._bufferReply('peer1', `msg${i}`);
    const ws = fakeSocket();
    internals(a)._flushPendingReplies('peer1', ws);
    expect(ws.received).toHaveLength(20);          // REPLY_BUFFER_MAX_PER_PEER
    expect(ws.received[0]).toBe('msg5');           // oldest 5 evicted
    expect(ws.received.at(-1)).toBe('msg24');
  });

  it('kill-switch=0 disables the flush', () => {
    process.env['SUDO_WEB_REPLY_BUFFER'] = '0';
    const a = new WebAdapter();
    internals(a)._bufferReply('peer1', 'x');
    const ws = fakeSocket();
    internals(a)._flushPendingReplies('peer1', ws);
    expect(ws.received).toEqual([]);
  });

  it('is a no-op when there is nothing buffered for the peer', () => {
    const a = new WebAdapter();
    const ws = fakeSocket();
    internals(a)._flushPendingReplies('unknown-peer', ws);
    expect(ws.received).toEqual([]);
  });
});
