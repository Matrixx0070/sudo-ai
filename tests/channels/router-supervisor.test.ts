/**
 * MessageRouter crash-isolation supervisor + channel.health (Feature 1).
 * Deterministic: supervisor auto-timer disabled (intervalMs:0), ticks driven
 * manually with an injected clock.
 */
import { describe, it, expect } from 'vitest';
import { MessageRouter } from '../../src/core/channels/router.js';
import type { ChannelAdapter } from '../../src/core/channels/adapter.js';
import type { ChannelType, MessageHandler } from '../../src/core/channels/types.js';

class FlakyAdapter implements ChannelAdapter {
  readonly channel: ChannelType;
  isConnected = false;
  failStart = false;
  startCalls = 0;
  private handler: MessageHandler | null = null;
  constructor(channel: ChannelType) { this.channel = channel; }
  async start(): Promise<void> { this.startCalls++; if (this.failStart) throw new Error('start boom'); this.isConnected = true; }
  async stop(): Promise<void> { this.isConnected = false; }
  async send(): Promise<void> {}
  onMessage(h: MessageHandler): void { this.handler = h; }
  crash(): void { this.isConnected = false; } // simulate a silent disconnect
}

/** Router with an injectable clock for deterministic backoff windows. */
class TestRouter extends MessageRouter {
  now = 0;
  protected _nowMs(): number { return this.now; }
}

function mkRouter(): TestRouter {
  return new TestRouter(null, { supervisor: { intervalMs: 0, baseBackoffMs: 1000, maxBackoffMs: 8000 } });
}

describe('MessageRouter supervisor', () => {
  it('records an error + stays down when start fails, without throwing', async () => {
    const r = mkRouter();
    const a = new FlakyAdapter('discord'); a.failStart = true;
    r.registerAdapter(a);
    await r.startAll(); // must not throw
    const h = r.health().find((x) => x.channel === 'discord')!;
    expect(h.connected).toBe(false);
    expect(h.lastError).toContain('boom');
  });

  it('restarts a crashed adapter after the backoff window (with growing backoff)', async () => {
    const r = mkRouter();
    const a = new FlakyAdapter('signal');
    r.registerAdapter(a);
    r.now = 0;
    await r.startAll();
    expect(a.isConnected).toBe(true);

    a.crash(); // silent disconnect
    await r.runSupervisorTick(500); // healthy adapters that JUST crashed: nextRetryAt is 0 → eligible
    expect(a.isConnected).toBe(true); // restarted
    expect(r.health().find((x) => x.channel === 'signal')!.restarts).toBe(1);
  });

  it('honours the backoff window before retrying a repeatedly-failing adapter', async () => {
    const r = mkRouter();
    const a = new FlakyAdapter('irc'); a.failStart = true;
    r.registerAdapter(a);
    r.now = 0;
    await r.startAll();           // fails → nextRetryAt = 0 + 1000 = 1000, backoff → 2000
    const before = a.startCalls;
    await r.runSupervisorTick(500);  // still within backoff → no retry
    expect(a.startCalls).toBe(before);
    await r.runSupervisorTick(1500); // past backoff → retry
    expect(a.startCalls).toBe(before + 1);
  });

  it('crash isolation: one down adapter does not restart a healthy sibling', async () => {
    const r = mkRouter();
    const down = new FlakyAdapter('discord');
    const healthy = new FlakyAdapter('slack');
    r.registerAdapter(down);
    r.registerAdapter(healthy);
    await r.startAll();
    const healthyStarts = healthy.startCalls;
    down.crash();
    await r.runSupervisorTick(100);
    expect(down.isConnected).toBe(true);        // restarted
    expect(healthy.isConnected).toBe(true);     // untouched
    expect(healthy.startCalls).toBe(healthyStarts); // NOT re-started
  });

  it('manageInbound:false observes for health but never starts/restarts/routes it', async () => {
    const r = mkRouter();
    const ext = new FlakyAdapter('telegram');
    // Externally-managed: simulate that Telegram already started itself.
    ext.isConnected = true;
    r.registerAdapter(ext, { manageInbound: false });
    await r.startAll();
    expect(ext.startCalls).toBe(0);                 // router did NOT start it
    expect(r.health().find((h) => h.channel === 'telegram')?.connected).toBe(true); // but health sees it

    ext.crash();
    await r.runSupervisorTick(999_999);
    expect(ext.startCalls).toBe(0);                 // supervisor did NOT restart it (self-managed)
    expect(r.health().find((h) => h.channel === 'telegram')?.restarts).toBe(0);
  });

  it('health() reflects connected + restart counts', async () => {
    const r = mkRouter();
    const a = new FlakyAdapter('matrix');
    r.registerAdapter(a);
    await r.startAll();
    const h = r.health();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ channel: 'matrix', connected: true, restarts: 0 });
  });
});
