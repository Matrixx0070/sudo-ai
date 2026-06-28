/**
 * Unit tests for the channel-outbox registry — the outbound-sender lookup the
 * ScheduledMessageDispatcher and the §9.6 meta-tool channelRouter both delegate to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerOutboundAdapter,
  registerOutboundSender,
  sendToChannelOutbox,
  hasOutbound,
  registeredOutboundChannels,
  clearOutbox,
} from '../../../src/core/channels/channel-outbox.js';
import type { ChannelAdapter } from '../../../src/core/channels/adapter.js';
import type { ChannelType } from '../../../src/core/channels/types.js';

function mockAdapter(channel: ChannelType): { adapter: ChannelAdapter; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  const adapter = { channel, send, start: vi.fn(), onMessage: vi.fn() } as unknown as ChannelAdapter;
  return { adapter, send };
}

describe('channel-outbox', () => {
  beforeEach(() => clearOutbox());

  it('routes sendToChannelOutbox to the registered adapter', async () => {
    const { adapter, send } = mockAdapter('telegram');
    registerOutboundAdapter(adapter);
    await sendToChannelOutbox('telegram', 'peer-1', 'hello');
    expect(send).toHaveBeenCalledWith('peer-1', 'hello', undefined);
  });

  it('throws a clear error for an unregistered channel', async () => {
    await expect(sendToChannelOutbox('discord', 'x', 'y')).rejects.toThrow(/no outbound sender registered.*discord/i);
  });

  it('tracks registered channels and hasOutbound', () => {
    expect(registeredOutboundChannels()).toHaveLength(0);
    registerOutboundAdapter(mockAdapter('telegram').adapter);
    registerOutboundAdapter(mockAdapter('slack').adapter);
    expect(hasOutbound('telegram')).toBe(true);
    expect(hasOutbound('discord')).toBe(false);
    expect(registeredOutboundChannels().sort()).toEqual(['slack', 'telegram']);
  });

  it('supports a raw sender function and last-registration-wins', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    registerOutboundSender('web', first);
    registerOutboundSender('web', second);
    await sendToChannelOutbox('web', 'p', 't');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('p', 't', undefined);
  });

  it('clearOutbox empties the registry', () => {
    registerOutboundAdapter(mockAdapter('telegram').adapter);
    clearOutbox();
    expect(registeredOutboundChannels()).toHaveLength(0);
  });
});
