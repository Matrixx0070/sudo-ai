/**
 * MessageRouter — adapter registry, per-chat serialized dispatch, lifecycle
 * fan-out, outbound send/broadcast, and error containment. Uses an in-memory
 * fake ChannelAdapter; no network.
 */

import { describe, it, expect } from 'vitest';
import { MessageRouter } from '../../src/core/channels/router.js';
import { ChannelError } from '../../src/core/shared/index.js';
import type { ChannelAdapter } from '../../src/core/channels/adapter.js';
import type { ChannelType, MessageHandler, UnifiedMessage } from '../../src/core/channels/types.js';

class FakeAdapter implements ChannelAdapter {
  readonly channel: ChannelType;
  isConnected = false;
  failStart = false;
  startCalls = 0;
  stopCalls = 0;
  sent: Array<{ peerId: string; text: string }> = [];
  private handler: MessageHandler | null = null;

  constructor(channel: ChannelType) {
    this.channel = channel;
  }

  async start(): Promise<void> {
    this.startCalls++;
    if (this.failStart) throw new Error(`${this.channel} start exploded`);
    this.isConnected = true;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.isConnected = false;
  }

  async send(peerId: string, text: string): Promise<void> {
    this.sent.push({ peerId, text });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Simulate an inbound platform message; resolves when dispatch settles. */
  emit(msg: UnifiedMessage): Promise<void> {
    return this.handler ? this.handler(msg) : Promise.resolve();
  }
}

let nextId = 0;
function msg(channel: ChannelType, peerId: string, text: string): UnifiedMessage {
  nextId++;
  return {
    id: String(nextId),
    channel,
    peerId,
    peerName: 'Tester',
    chatType: 'dm',
    text,
    timestamp: new Date(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('MessageRouter', () => {
  it('rejects non-adapters and non-function handlers', () => {
    const router = new MessageRouter();
    expect(() => router.registerAdapter(null as unknown as ChannelAdapter)).toThrow(TypeError);
    expect(() => router.registerAdapter({} as ChannelAdapter)).toThrow(TypeError);
    expect(() => router.setHandler('nope' as unknown as MessageHandler)).toThrow(TypeError);
  });

  it('routes inbound messages from a registered adapter to the handler', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    router.registerAdapter(irc);

    const received: UnifiedMessage[] = [];
    router.setHandler(async (m) => { received.push(m); });

    await irc.emit(msg('irc', 'nick1', 'hello'));
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe('hello');
  });

  it('drops messages without throwing when no handler is set', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    router.registerAdapter(irc);
    await expect(irc.emit(msg('irc', 'nick1', 'lost'))).resolves.toBeUndefined();
  });

  it('serializes same-chat messages and runs different chats independently', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    router.registerAdapter(irc);

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });

    router.setHandler(async (m) => {
      order.push(`start:${m.text}`);
      if (m.text === 'a1') await firstGate;
      order.push(`end:${m.text}`);
    });

    const p1 = irc.emit(msg('irc', 'alice', 'a1'));
    const p2 = irc.emit(msg('irc', 'alice', 'a2'));
    const p3 = irc.emit(msg('irc', 'bob', 'b1'));
    await sleep(20);

    // bob proceeds while alice's first turn is still blocked; a2 waits.
    expect(order).toContain('end:b1');
    expect(order).not.toContain('start:a2');

    releaseFirst();
    await Promise.all([p1, p2, p3]);
    expect(order.indexOf('start:a2')).toBeGreaterThan(order.indexOf('end:a1'));
  });

  it('contains handler errors and keeps processing later messages', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    router.registerAdapter(irc);

    const handled: string[] = [];
    router.setHandler(async (m) => {
      if (m.text === 'boom') throw new Error('turn exploded');
      handled.push(m.text);
    });

    await irc.emit(msg('irc', 'nick1', 'boom'));
    await irc.emit(msg('irc', 'nick1', 'after'));
    expect(handled).toEqual(['after']);
  });

  it('startAll starts every adapter and tolerates one failing', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    const matrix = new FakeAdapter('matrix');
    matrix.failStart = true;
    const signal = new FakeAdapter('signal');
    router.registerAdapter(irc);
    router.registerAdapter(matrix);
    router.registerAdapter(signal);

    await router.startAll();
    expect(irc.isConnected).toBe(true);
    expect(matrix.isConnected).toBe(false);
    expect(signal.isConnected).toBe(true);
    expect(router.connectedChannels.sort()).toEqual(['irc', 'signal']);
    expect(router.registeredChannels.sort()).toEqual(['irc', 'matrix', 'signal']);
  });

  it('stopAll stops every adapter', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    const signal = new FakeAdapter('signal');
    router.registerAdapter(irc);
    router.registerAdapter(signal);
    await router.startAll();
    await router.stopAll();
    expect(irc.stopCalls).toBe(1);
    expect(signal.stopCalls).toBe(1);
    expect(router.connectedChannels).toEqual([]);
  });

  it('sendToChannel delegates to the right adapter and validates state', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    router.registerAdapter(irc);

    await expect(router.sendToChannel('matrix', 'p', 'x')).rejects.toThrow(ChannelError);
    await expect(router.sendToChannel('irc', 'p', 'x')).rejects.toThrow(ChannelError); // not connected

    await router.startAll();
    await router.sendToChannel('irc', 'nick1', 'hi there');
    expect(irc.sent).toEqual([{ peerId: 'nick1', text: 'hi there' }]);
  });

  it('broadcast hits all connected adapters and survives per-channel failures', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    const matrix = new FakeAdapter('matrix');
    matrix.failStart = true; // stays disconnected → its send fails inside broadcast
    router.registerAdapter(irc);
    router.registerAdapter(matrix);
    await router.startAll();

    await router.broadcast('announcement', 'owner-1');
    expect(irc.sent).toEqual([{ peerId: 'owner-1', text: 'announcement' }]);
    expect(matrix.sent).toEqual([]);
  });

  it('broadcast respects an explicit channel subset', async () => {
    const router = new MessageRouter();
    const irc = new FakeAdapter('irc');
    const signal = new FakeAdapter('signal');
    router.registerAdapter(irc);
    router.registerAdapter(signal);
    await router.startAll();

    await router.broadcast('only irc', 'owner-1', ['irc']);
    expect(irc.sent).toHaveLength(1);
    expect(signal.sent).toHaveLength(0);
  });

  it('re-registering a channel replaces the previous adapter', async () => {
    const router = new MessageRouter();
    const first = new FakeAdapter('irc');
    const second = new FakeAdapter('irc');
    router.registerAdapter(first);
    router.registerAdapter(second);
    await router.startAll();

    expect(router.registeredChannels).toEqual(['irc']);
    await router.sendToChannel('irc', 'p', 'x');
    expect(first.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);

    // Inbound from the replaced adapter still reaches the handler (its
    // onMessage was wired at registration), but only the new adapter is
    // the outbound target — documents the replacement contract.
    const received: string[] = [];
    router.setHandler(async (m) => { received.push(m.text); });
    await second.emit(msg('irc', 'p', 'from-second'));
    expect(received).toEqual(['from-second']);
  });

  describe('pre-dispatch interceptor (admission guard)', () => {
    it('rejects non-function interceptors', () => {
      const router = new MessageRouter();
      expect(() => router.setPreDispatchInterceptor('nope' as unknown as (m: UnifiedMessage) => boolean)).toThrow(TypeError);
    });

    it('consumed messages never reach the queue or handler', async () => {
      const router = new MessageRouter();
      const irc = new FakeAdapter('irc');
      router.registerAdapter(irc);

      const handled: string[] = [];
      router.setHandler(async (m) => { handled.push(m.text); });
      router.setPreDispatchInterceptor((m) => m.text.startsWith('YES (approval-id:'));

      await irc.emit(msg('irc', 'nick1', 'YES (approval-id: abc123)'));
      await irc.emit(msg('irc', 'nick1', 'normal turn'));
      expect(handled).toEqual(['normal turn']);
    });

    it('interceptor runs even while the peer queue is blocked (bypass, not enqueue)', async () => {
      const router = new MessageRouter();
      const irc = new FakeAdapter('irc');
      router.registerAdapter(irc);

      const consumed: string[] = [];
      router.setPreDispatchInterceptor((m) => {
        if (m.text === 'control') { consumed.push(m.text); return true; }
        return false;
      });

      let releaseTurn!: () => void;
      const gate = new Promise<void>((r) => { releaseTurn = r; });
      const handled: string[] = [];
      router.setHandler(async (m) => { handled.push(m.text); await gate; });

      const turn = irc.emit(msg('irc', 'nick1', 'long turn'));
      await sleep(10);
      // The turn is mid-flight and holds the per-peer queue. The control
      // message is consumed immediately — it does not wait behind the turn.
      await irc.emit(msg('irc', 'nick1', 'control'));
      expect(consumed).toEqual(['control']);
      expect(handled).toEqual(['long turn']);

      releaseTurn();
      await turn;
    });

    it('fails open when the interceptor throws', async () => {
      const router = new MessageRouter();
      const irc = new FakeAdapter('irc');
      router.registerAdapter(irc);

      const handled: string[] = [];
      router.setHandler(async (m) => { handled.push(m.text); });
      router.setPreDispatchInterceptor(() => { throw new Error('interceptor bug'); });

      await irc.emit(msg('irc', 'nick1', 'still delivered'));
      expect(handled).toEqual(['still delivered']);
    });
  });
});
