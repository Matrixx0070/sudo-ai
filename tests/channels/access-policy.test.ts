/**
 * ChannelAccessPolicy (Feature 1) — deny-by-default owner allowlist, isOwner
 * resolution, and the router admission gate (denied senders never reach the
 * handler; admitted senders arrive with isOwner set).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelAccessPolicy } from '../../src/core/channels/access-policy.js';
import { loadChannelsConfig } from '../../src/core/channels/channels-config.js';
import { MessageRouter } from '../../src/core/channels/router.js';
import type { ChannelAdapter } from '../../src/core/channels/adapter.js';
import type { ChannelType, MessageHandler, UnifiedMessage } from '../../src/core/channels/types.js';

describe('ChannelAccessPolicy.resolve', () => {
  it('admits owner with isOwner=true', () => {
    const p = new ChannelAccessPolicy({ channels: { signal: { owners: ['+1555'] } } });
    expect(p.resolve('signal', '+1555')).toMatchObject({ admit: true, isOwner: true });
  });

  it('deny-by-default within a gated channel (locked block)', () => {
    const p = new ChannelAccessPolicy({ channels: { signal: { open: false } } });
    expect(p.resolve('signal', 'anyone').admit).toBe(false);
  });

  it('admits allowedPeers as non-owner', () => {
    const p = new ChannelAccessPolicy({ channels: { irc: { owners: ['boss'], allowedPeers: ['pal'] } } });
    expect(p.resolve('irc', 'pal')).toMatchObject({ admit: true, isOwner: false });
    expect(p.resolve('irc', 'stranger').admit).toBe(false);
  });

  it('open:true admits everyone (owner still only for owners)', () => {
    const p = new ChannelAccessPolicy({ channels: { discord: { open: true, owners: ['me'] } } });
    expect(p.resolve('discord', 'rando')).toMatchObject({ admit: true, isOwner: false });
    expect(p.resolve('discord', 'me')).toMatchObject({ admit: true, isOwner: true });
  });

  it("wildcard '*' owner makes everyone an owner", () => {
    const p = new ChannelAccessPolicy({ channels: { web: { owners: ['*'] } } });
    expect(p.resolve('web', 'whoever')).toMatchObject({ admit: true, isOwner: true });
  });

  it('channel with no block follows defaultDeny', () => {
    expect(new ChannelAccessPolicy({ defaultDeny: false }).resolve('telegram', 'x').admit).toBe(true);
    expect(new ChannelAccessPolicy({ defaultDeny: true }).resolve('telegram', 'x').admit).toBe(false);
  });

  it('permissive() admits all and reports inactive', () => {
    const p = ChannelAccessPolicy.permissive();
    expect(p.active).toBe(false);
    expect(p.resolve('signal', 'anyone').admit).toBe(true);
  });

  it('active is true once any channel is gated', () => {
    expect(new ChannelAccessPolicy({ channels: { signal: { open: false } } }).active).toBe(true);
  });
});

describe('loadChannelsConfig', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function writeCfg(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'chcfg-')); dirs.push(dir);
    const p = join(dir, 'channels.json5'); writeFileSync(p, body); return p;
  }

  it('captures open:false as a LOCK (regression: was silently dropped)', () => {
    const cfg = loadChannelsConfig(writeCfg('{ channels: { signal: { enabled: false, open: false } } }'));
    expect(cfg?.channels?.signal).toEqual({ open: false });
    const p = new ChannelAccessPolicy(cfg ?? {});
    expect(p.resolve('signal', 'stranger').admit).toBe(false);
  });

  it('parses owners + open:true and ignores non-policy fields (tokenEnv/enabled)', () => {
    const cfg = loadChannelsConfig(writeCfg('{ channels: { discord: { enabled: true, tokenEnv: "DISCORD_TOKEN", owners: ["me"] }, web: { open: true } } }'));
    expect(cfg?.channels?.discord).toEqual({ owners: ['me'] });
    expect(cfg?.channels?.web).toEqual({ open: true });
  });

  it('returns null for a missing file (permissive fallback)', () => {
    expect(loadChannelsConfig(join(tmpdir(), 'does-not-exist-channels.json5'))).toBeNull();
  });
});

// --- router admission integration ---

class FakeAdapter implements ChannelAdapter {
  readonly channel: ChannelType;
  isConnected = false;
  private handler: MessageHandler | null = null;
  constructor(channel: ChannelType) { this.channel = channel; }
  async start(): Promise<void> { this.isConnected = true; }
  async stop(): Promise<void> { this.isConnected = false; }
  async send(): Promise<void> {}
  onMessage(h: MessageHandler): void { this.handler = h; }
  emit(m: UnifiedMessage): Promise<void> { return this.handler ? this.handler(m) : Promise.resolve(); }
}

function mkMsg(channel: ChannelType, peerId: string): UnifiedMessage {
  return { id: 'm1', channel, peerId, peerName: peerId, chatType: 'dm', text: 'hi', timestamp: new Date() };
}

describe('MessageRouter admission gate', () => {
  it('drops a non-allowlisted sender before the handler', async () => {
    const router = new MessageRouter();
    router.setAccessPolicy(new ChannelAccessPolicy({ channels: { signal: { owners: ['+1555'] } } }));
    const handler = vi.fn(async () => {});
    router.setHandler(handler);
    const a = new FakeAdapter('signal');
    router.registerAdapter(a);
    await a.emit(mkMsg('signal', 'stranger'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('admits the owner and stamps isOwner on the message', async () => {
    const router = new MessageRouter();
    router.setAccessPolicy(new ChannelAccessPolicy({ channels: { signal: { owners: ['+1555'] } } }));
    let seen: UnifiedMessage | null = null;
    router.setHandler(async (m) => { seen = m; });
    const a = new FakeAdapter('signal');
    router.registerAdapter(a);
    await a.emit(mkMsg('signal', '+1555'));
    expect(seen).not.toBeNull();
    expect(seen!.isOwner).toBe(true);
  });

  it('permissive policy is a no-op (all admitted)', async () => {
    const router = new MessageRouter();
    router.setAccessPolicy(ChannelAccessPolicy.permissive());
    const handler = vi.fn(async () => {});
    router.setHandler(handler);
    const a = new FakeAdapter('irc');
    router.registerAdapter(a);
    await a.emit(mkMsg('irc', 'anyone'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
