/**
 * @file channel-outbox.ts
 * @description Process-wide registry of OUTBOUND channel senders. Channel
 * adapters in cli.ts are block-scoped to their own `if (enabled)` blocks, so a
 * background producer (e.g. ScheduledMessageDispatcher) can't hold a reference
 * to each one. Each adapter registers its send here at construction; consumers
 * call sendToChannelOutbox(channel, peerId, text) without knowing the adapter.
 *
 * A channel with no registered sender throws a clear error — the caller decides
 * whether to retry or fail (the dispatcher records it as a failed delivery).
 * Populating the registry is side-effect-free, so it runs regardless of any
 * single consumer's feature flag.
 */

import type { ChannelType, SendOptions } from './types.js';
import type { ChannelAdapter } from './adapter.js';

export type OutboundSender = (peerId: string, text: string, options?: SendOptions) => Promise<void>;

const outbox = new Map<ChannelType, OutboundSender>();

/** Register a raw send function for a channel. Last registration wins. */
export function registerOutboundSender(channel: ChannelType, send: OutboundSender): void {
  outbox.set(channel, send);
}

/** Convenience: register a full ChannelAdapter under its own channel key. */
export function registerOutboundAdapter(adapter: ChannelAdapter): void {
  outbox.set(adapter.channel, (peerId, text, options) => adapter.send(peerId, text, options));
}

export function hasOutbound(channel: ChannelType): boolean {
  return outbox.has(channel);
}

export function registeredOutboundChannels(): ChannelType[] {
  return [...outbox.keys()];
}

/** Deliver text to a channel via its registered sender. Throws if none registered. */
export async function sendToChannelOutbox(
  channel: ChannelType,
  peerId: string,
  text: string,
  options?: SendOptions,
): Promise<void> {
  const send = outbox.get(channel);
  if (!send) throw new Error(`no outbound sender registered for channel "${channel}"`);
  try {
    await send(peerId, text, options);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw Object.assign(
      new Error(`channel outbox send failed (${channel}/${peerId}): ${msg}`),
      { cause, channel, peerId },
    );
  }
}

/** Test/teardown helper — clears all registrations. */
export function clearOutbox(): void {
  outbox.clear();
}
