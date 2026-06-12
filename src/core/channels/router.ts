/**
 * @file router.ts
 * @description MessageRouter — central dispatcher for all inbound and outbound messages.
 *
 * Responsibilities:
 *  - Maintain a registry of ChannelAdapter instances.
 *  - Route inbound UnifiedMessages to the registered handler, serialized per
 *    peer using a KeyedAsyncQueue to prevent race conditions.
 *  - Provide send and broadcast helpers that delegate to the correct adapter.
 *  - Optionally integrate with CrossChannelMemory to store every message and
 *    inject cross-channel history into the dispatch pipeline.
 */

import { createLogger } from '../shared/index.js';
import { ChannelError } from '../shared/index.js';
import { KeyedAsyncQueue } from '../sessions/queue.js';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelType, MessageHandler, SendOptions, UnifiedMessage } from './types.js';
import { CrossChannelMemory } from './cross-channel-memory.js';

const log = createLogger('channels:router');

/**
 * Central hub that connects channel adapters to the brain pipeline.
 *
 * @example
 * ```ts
 * // Without cross-channel memory (default, no change in behaviour):
 * const router = new MessageRouter();
 *
 * // With cross-channel memory — messages are persisted and cross-channel
 * // history is injected into every dispatched message:
 * const router = new MessageRouter(new CrossChannelMemory());
 *
 * router.registerAdapter(telegramAdapter);
 * router.setHandler(async (msg) => { ... });
 * await router.startAll();
 * ```
 */
export class MessageRouter {
  private readonly adapters = new Map<ChannelType, ChannelAdapter>();
  private readonly queue = new KeyedAsyncQueue();
  private handler: MessageHandler | null = null;

  /**
   * Optional admission interceptor checked synchronously in `_dispatch`
   * BEFORE the message is enqueued. Returning true consumes the message: it
   * never reaches the per-peer queue or the handler. Used for control
   * traffic — e.g. tool-approval replies — that must bypass the turn queue,
   * because a reply queued behind the very turn awaiting it would deadlock.
   */
  private preDispatchInterceptor: ((msg: UnifiedMessage) => boolean) | null = null;

  /**
   * Optional cross-channel memory store.
   * When provided, every inbound and outbound message is persisted, and the
   * peer's full cross-channel history is attached to the UnifiedMessage as
   * `crossChannelContext` before the handler is invoked.
   */
  private readonly crossChannelMemory: CrossChannelMemory | null;

  /**
   * @param crossChannelMemory - Optional memory store.  When omitted the
   *   router behaves exactly as before: no persistence, no history injection.
   */
  constructor(crossChannelMemory?: CrossChannelMemory) {
    this.crossChannelMemory = crossChannelMemory ?? null;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a channel adapter with the router.
   * The router immediately wires the adapter's `onMessage` to its internal
   * dispatch pipeline. Replaces any previously registered adapter for the
   * same channel type.
   *
   * @param adapter - Initialized (but not yet started) adapter instance.
   */
  registerAdapter(adapter: ChannelAdapter): void {
    if (!adapter || typeof adapter.channel !== 'string') {
      throw new TypeError('registerAdapter: adapter must implement ChannelAdapter');
    }

    adapter.onMessage((msg) => this._dispatch(msg));
    this.adapters.set(adapter.channel, adapter);
    log.info({ channel: adapter.channel }, 'adapter registered');
  }

  /**
   * Set the single message handler that receives all routed messages.
   * Must be called before `startAll()` so no messages are dropped.
   *
   * @param handler - Async callback; receives a fully normalized UnifiedMessage.
   */
  setHandler(handler: MessageHandler): void {
    if (typeof handler !== 'function') {
      throw new TypeError('setHandler: handler must be a function');
    }
    this.handler = handler;
    log.debug('global message handler registered');
  }

  /**
   * Register a synchronous pre-dispatch admission interceptor.
   * See {@link preDispatchInterceptor} for semantics.
   */
  setPreDispatchInterceptor(interceptor: (msg: UnifiedMessage) => boolean): void {
    if (typeof interceptor !== 'function') {
      throw new TypeError('setPreDispatchInterceptor: interceptor must be a function');
    }
    this.preDispatchInterceptor = interceptor;
    log.debug('pre-dispatch interceptor registered');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start all registered adapters concurrently.
   * Individual adapter failures are logged but do not prevent other adapters
   * from starting (best-effort — Telegram is primary, others optional).
   */
  async startAll(): Promise<void> {
    const entries = [...this.adapters.entries()];
    log.info({ count: entries.length }, 'starting all channel adapters');

    await Promise.allSettled(
      entries.map(async ([channel, adapter]) => {
        try {
          await adapter.start();
          log.info({ channel }, 'adapter started');
        } catch (err) {
          log.error({ channel, err }, 'adapter failed to start');
        }
      }),
    );
  }

  /**
   * Stop all registered adapters concurrently.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.adapters.entries()];
    log.info({ count: entries.length }, 'stopping all channel adapters');

    await Promise.allSettled(
      entries.map(async ([channel, adapter]) => {
        try {
          await adapter.stop();
          log.info({ channel }, 'adapter stopped');
        } catch (err) {
          log.error({ channel, err }, 'adapter stop error (ignored)');
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  /**
   * Send a message through a specific channel adapter.
   *
   * @param channel - Target channel type.
   * @param peerId  - Platform-specific destination identifier.
   * @param text    - Message body.
   * @param options - Optional send parameters.
   * @throws {ChannelError} if the channel is not registered or the send fails.
   */
  async sendToChannel(
    channel: ChannelType,
    peerId: string,
    text: string,
    options?: SendOptions,
  ): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new ChannelError(
        `No adapter registered for channel: ${channel}`,
        'channel_not_registered',
        { channel },
      );
    }

    if (!adapter.isConnected) {
      throw new ChannelError(
        `Adapter for channel ${channel} is not connected`,
        'channel_not_connected',
        { channel, peerId },
      );
    }

    log.debug({ channel, peerId, textLen: text.length }, 'sending message');
    await adapter.send(peerId, text, options);

    // Persist every outbound message so cross-channel history stays complete.
    if (this.crossChannelMemory) {
      try {
        this.crossChannelMemory.storeMessage(channel as Parameters<CrossChannelMemory['storeMessage']>[0], peerId, text, 'assistant');
      } catch (err) {
        log.warn({ channel, peerId, err }, 'cross-channel memory: failed to store outbound message');
      }
    }
  }

  /**
   * Broadcast a message to all connected channels (or a subset).
   * Failures on individual channels are logged and do not interrupt others.
   *
   * @param text     - Message body to broadcast.
   * @param peerId   - Target peer identifier (same across channels, e.g. a config-level owner ID).
   * @param channels - Optional allowlist; if omitted broadcasts to all connected adapters.
   * @param options  - Optional send parameters applied to all sends.
   */
  async broadcast(
    text: string,
    peerId: string,
    channels?: ChannelType[],
    options?: SendOptions,
  ): Promise<void> {
    const targets =
      channels != null
        ? channels.filter((c) => this.adapters.has(c))
        : ([...this.adapters.keys()] as ChannelType[]);

    log.info({ targets, peerId }, 'broadcasting message');

    await Promise.allSettled(
      targets.map(async (channel) => {
        try {
          await this.sendToChannel(channel, peerId, text, options);
        } catch (err) {
          log.error({ channel, peerId, err }, 'broadcast send failed');
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /** Returns the set of registered channel types. */
  get registeredChannels(): ChannelType[] {
    return [...this.adapters.keys()];
  }

  /** Returns channel types where `isConnected` is true. */
  get connectedChannels(): ChannelType[] {
    return [...this.adapters.entries()]
      .filter(([, a]) => a.isConnected)
      .map(([c]) => c);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Internal dispatch: enqueues the message under a per-peer key so messages
   * from the same peer are always processed in arrival order.
   *
   * When CrossChannelMemory is present:
   *  1. The inbound message is persisted as `role: 'user'`.
   *  2. The peer's cross-channel history is retrieved and attached to the
   *     UnifiedMessage as `crossChannelContext` before the handler is called.
   */
  private _dispatch(msg: UnifiedMessage): Promise<void> {
    if (this.preDispatchInterceptor) {
      try {
        if (this.preDispatchInterceptor(msg)) {
          log.info({ channel: msg.channel, peerId: msg.peerId }, 'message consumed by pre-dispatch interceptor — not queued');
          return Promise.resolve();
        }
      } catch (err) {
        // Fail open: interceptor bugs must never drop user messages.
        log.warn({ channel: msg.channel, peerId: msg.peerId, err }, 'pre-dispatch interceptor threw — dispatching normally');
      }
    }

    const key = `${msg.channel}:${msg.peerId}`;

    return this.queue.enqueue(key, async () => {
      if (!this.handler) {
        log.warn({ channel: msg.channel, peerId: msg.peerId }, 'message received but no handler set — dropping');
        return;
      }

      // ------------------------------------------------------------------
      // Cross-channel memory: store inbound + inject history
      // ------------------------------------------------------------------
      let enrichedMsg = msg;
      if (this.crossChannelMemory) {
        try {
          // 1. Persist the inbound message.
          this.crossChannelMemory.storeMessage(
            msg.channel as Parameters<CrossChannelMemory['storeMessage']>[0],
            msg.peerId,
            msg.text ?? '',
            'user',
          );

          // 2. Retrieve cross-channel context for this peer and attach it.
          const crossChannelContext = this.crossChannelMemory.retrieveContext(
            msg.channel as Parameters<CrossChannelMemory['retrieveContext']>[0],
            msg.peerId,
          );

          enrichedMsg = { ...msg, crossChannelContext } as UnifiedMessage & {
            crossChannelContext: ReturnType<CrossChannelMemory['retrieveContext']>;
          };
        } catch (err) {
          log.warn({ channel: msg.channel, peerId: msg.peerId, err }, 'cross-channel memory: store/retrieve failed — proceeding without context');
        }
      }

      try {
        await this.handler(enrichedMsg);
      } catch (err) {
        log.error(
          { channel: msg.channel, peerId: msg.peerId, msgId: msg.id, err },
          'message handler threw — error contained',
        );
      }
    });
  }
}
