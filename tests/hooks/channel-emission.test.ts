/**
 * @file tests/hooks/channel-emission.test.ts
 * Verifies message:received and message:sent HookEvents fire for each channel
 * adapter, and that throwing hook handlers do NOT break channel sends.
 */

import { describe, it, expect, vi } from 'vitest';
import { HookManager } from '../../src/core/hooks/index.js';
import type { HookContext } from '../../src/core/hooks/index.js';
import { TelegramAdapter } from '../../src/core/channels/telegram.js';
import { DiscordAdapter } from '../../src/core/channels/discord.js';
import { WhatsAppAdapter } from '../../src/core/channels/whatsapp.js';

/**
 * Build a HookManager with a spy handler registered for the given event.
 * Returns the manager and the spy function for assertion.
 */
function buildSpy(event: string): {
  hooks: HookManager;
  spy: ReturnType<typeof vi.fn>;
} {
  const hooks = new HookManager();
  const spy = vi.fn(async (_ctx: HookContext) => undefined);
  hooks.register(event as Parameters<typeof hooks.register>[0], spy, `spy:${event}`);
  return { hooks, spy };
}

/**
 * Build a HookManager with a handler that always throws, plus a second spy
 * that should still be called (resilience check).
 */
function buildThrowingHooks(event: string): {
  hooks: HookManager;
  afterSpy: ReturnType<typeof vi.fn>;
} {
  const hooks = new HookManager();
  hooks.register(
    event as Parameters<typeof hooks.register>[0],
    async () => { throw new Error('intentional hook failure'); },
    'throwing-hook',
  );
  const afterSpy = vi.fn(async () => undefined);
  hooks.register(
    event as Parameters<typeof hooks.register>[0],
    afterSpy,
    'after-throw-spy',
  );
  return { hooks, afterSpy };
}

// ---------------------------------------------------------------------------
// TelegramAdapter tests
// ---------------------------------------------------------------------------

describe('TelegramAdapter — hook emission', () => {
  it('message:received fires when _handleInbound is called', async () => {
    const adapter = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['123']);
    const { hooks, spy } = buildSpy('message:received');
    adapter.setHookEmitter(hooks);

    // Register a no-op message handler so the adapter does not drop the message.
    adapter.onMessage(async () => undefined);

    // Build a minimal Grammy Context stub.
    const ctx = {
      from: { id: 123, first_name: 'Test', last_name: 'User', username: 'testuser' },
      chat: { id: 123, type: 'private' },
      message: { message_id: 42, date: Math.floor(Date.now() / 1000), reply_to_message: undefined },
    } as unknown;

    // Invoke private method via type cast.
    await (adapter as unknown as {
      _handleInbound(ctx: unknown, text: string, media: unknown[]): Promise<void>;
    })._handleInbound(ctx, 'hello world', []);

    // Give fire-and-forget a tick to settle.
    await new Promise<void>((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledOnce();
    const emittedCtx = spy.mock.calls[0][0] as HookContext;
    expect(emittedCtx.event).toBe('message:received');
    expect(emittedCtx.channel).toBe('telegram');
    expect(emittedCtx.sessionId).toMatch(/^tg-123-/);
    expect((emittedCtx.meta as Record<string, unknown>).peerId).toBe('123');
  });

  it('message:sent fires after send() completes successfully', async () => {
    const adapter = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['123']);
    const { hooks, spy } = buildSpy('message:sent');
    adapter.setHookEmitter(hooks);

    // Inject a mock bot so send() does not throw "not connected".
    const mockSendMessage = vi.fn(async () => ({ message_id: 1 }));
    (adapter as unknown as Record<string, unknown>)._isConnected = true;
    (adapter as unknown as Record<string, unknown>).bot = {
      api: { sendMessage: mockSendMessage },
    };

    await adapter.send('123', 'hello');

    // Give fire-and-forget a tick to settle.
    await new Promise<void>((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledOnce();
    const emittedCtx = spy.mock.calls[0][0] as HookContext;
    expect(emittedCtx.event).toBe('message:sent');
    expect(emittedCtx.channel).toBe('telegram');
    expect((emittedCtx.meta as Record<string, unknown>).peerId).toBe('123');
  });

  it('a throwing hook does NOT prevent Telegram send() from completing', async () => {
    const adapter = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['123']);
    const { hooks } = buildThrowingHooks('message:sent');
    adapter.setHookEmitter(hooks);

    const mockSendMessage = vi.fn(async () => ({ message_id: 2 }));
    (adapter as unknown as Record<string, unknown>)._isConnected = true;
    (adapter as unknown as Record<string, unknown>).bot = {
      api: { sendMessage: mockSendMessage },
    };

    // send() must not throw even though the hook handler throws.
    await expect(adapter.send('123', 'resilience check')).resolves.toBeUndefined();

    // The underlying sendMessage was still called.
    expect(mockSendMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DiscordAdapter tests
// ---------------------------------------------------------------------------

describe('DiscordAdapter — hook emission', () => {
  it('message:received fires when _dispatch is called', async () => {
    const adapter = new DiscordAdapter('DISCORD_TOKEN', []);
    const { hooks, spy } = buildSpy('message:received');
    adapter.setHookEmitter(hooks);

    adapter.onMessage(async () => undefined);

    const unifiedMsg = {
      id: 'disc-msg-1',
      channel: 'discord',
      peerId: 'channel-99',
      peerName: 'DiscordUser',
      chatType: 'dm',
      text: 'hey there',
      timestamp: new Date(),
    } as unknown;

    await (adapter as unknown as {
      _dispatch(msg: unknown): Promise<void>;
    })._dispatch(unifiedMsg);

    await new Promise<void>((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledOnce();
    const emittedCtx = spy.mock.calls[0][0] as HookContext;
    expect(emittedCtx.event).toBe('message:received');
    expect(emittedCtx.channel).toBe('discord');
    expect((emittedCtx.meta as Record<string, unknown>).peerId).toBe('channel-99');
  });

  it('message:sent fires after Discord send() completes successfully', async () => {
    const adapter = new DiscordAdapter('DISCORD_TOKEN', []);
    const { hooks, spy } = buildSpy('message:sent');
    adapter.setHookEmitter(hooks);

    // Inject a mock client so send() works.
    const mockChannelSend = vi.fn(async () => ({}));
    const mockFetch = vi.fn(async () => ({
      isTextBased: () => true,
      send: mockChannelSend,
    }));
    (adapter as unknown as Record<string, unknown>)._isConnected = true;
    (adapter as unknown as Record<string, unknown>).client = {
      channels: { fetch: mockFetch },
    };

    await adapter.send('channel-99', 'test message');

    await new Promise<void>((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledOnce();
    const emittedCtx = spy.mock.calls[0][0] as HookContext;
    expect(emittedCtx.event).toBe('message:sent');
    expect(emittedCtx.channel).toBe('discord');
    expect((emittedCtx.meta as Record<string, unknown>).peerId).toBe('channel-99');
  });

  it('a throwing hook does NOT prevent Discord send() from completing', async () => {
    const adapter = new DiscordAdapter('DISCORD_TOKEN', []);
    const { hooks, afterSpy } = buildThrowingHooks('message:sent');
    adapter.setHookEmitter(hooks);

    const mockChannelSend = vi.fn(async () => ({}));
    const mockFetch = vi.fn(async () => ({
      isTextBased: () => true,
      send: mockChannelSend,
    }));
    (adapter as unknown as Record<string, unknown>)._isConnected = true;
    (adapter as unknown as Record<string, unknown>).client = {
      channels: { fetch: mockFetch },
    };

    await expect(adapter.send('channel-99', 'survive bad hook')).resolves.toBeUndefined();

    // Wait for async fire-and-forget to settle.
    await new Promise<void>((r) => setImmediate(r));

    // afterSpy (the second hook registered after the throwing one) must still fire.
    expect(afterSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WhatsAppAdapter tests
// ---------------------------------------------------------------------------

describe('WhatsAppAdapter — hook emission', () => {
  it('message:received fires when _processInbound is called', async () => {
    const adapter = new WhatsAppAdapter(undefined, ['1234@s.whatsapp.net']);
    const { hooks, spy } = buildSpy('message:received');
    adapter.setHookEmitter(hooks);

    adapter.onMessage(async () => undefined);

    // Build a minimal proto.IWebMessageInfo stub.
    const rawMsg = {
      key: {
        remoteJid: '1234@s.whatsapp.net',
        fromMe: false,
        id: 'wa-msg-1',
      },
      message: { conversation: 'whatsapp hello' },
      pushName: 'WaUser',
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown;

    await (adapter as unknown as {
      _processInbound(raw: unknown): Promise<void>;
    })._processInbound(rawMsg);

    await new Promise<void>((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledOnce();
    const emittedCtx = spy.mock.calls[0][0] as HookContext;
    expect(emittedCtx.event).toBe('message:received');
    expect(emittedCtx.channel).toBe('whatsapp');
    expect((emittedCtx.meta as Record<string, unknown>).text).toBe('whatsapp hello');
  });

  it('message:sent fires after WhatsApp send() completes successfully', async () => {
    const adapter = new WhatsAppAdapter(undefined, []);
    const { hooks, spy } = buildSpy('message:sent');
    adapter.setHookEmitter(hooks);

    // Inject a mock Baileys socket.
    const mockSendMessage = vi.fn(async () => ({}));
    (adapter as unknown as Record<string, unknown>)._isConnected = true;
    (adapter as unknown as Record<string, unknown>).socket = {
      sendMessage: mockSendMessage,
    };

    await adapter.send('1234', 'hello whatsapp');

    await new Promise<void>((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledOnce();
    const emittedCtx = spy.mock.calls[0][0] as HookContext;
    expect(emittedCtx.event).toBe('message:sent');
    expect(emittedCtx.channel).toBe('whatsapp');
    expect((emittedCtx.meta as Record<string, unknown>).peerId).toBe('1234');
  });

  it('a throwing hook does NOT prevent WhatsApp send() from completing', async () => {
    const adapter = new WhatsAppAdapter(undefined, []);
    const { hooks, afterSpy } = buildThrowingHooks('message:sent');
    adapter.setHookEmitter(hooks);

    const mockSendMessage = vi.fn(async () => ({}));
    (adapter as unknown as Record<string, unknown>)._isConnected = true;
    (adapter as unknown as Record<string, unknown>).socket = {
      sendMessage: mockSendMessage,
    };

    await expect(adapter.send('1234', 'survive throw')).resolves.toBeUndefined();

    await new Promise<void>((r) => setImmediate(r));

    expect(afterSpy).toHaveBeenCalled();
  });
});
