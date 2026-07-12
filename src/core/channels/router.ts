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
import type { ChannelAccessPolicy } from './access-policy.js';

const log = createLogger('channels:router');

/** Per-channel health snapshot (Feature 1 — channel.health / self-diagnostics). */
export interface ChannelHealth {
  channel: ChannelType;
  connected: boolean;
  /** Times the supervisor has restarted this adapter since boot. */
  restarts: number;
  /** Last start/restart error message, if any. */
  lastError?: string;
  /** Epoch ms of the last inbound message admitted on this channel. */
  lastMessageAt?: number;
  /** Epoch ms of the last restart attempt. */
  lastRestartAt?: number;
}

/** Tuning for the crash-isolation supervisor. */
export interface SupervisorOptions {
  /** How often to check adapters for a crashed/disconnected state. Default 15s. */
  intervalMs?: number;
  /** First backoff after a failure. Default 2s. */
  baseBackoffMs?: number;
  /** Backoff ceiling. Default 5min. */
  maxBackoffMs?: number;
}

export interface RouterOptions {
  supervisor?: SupervisorOptions;
}

interface AdapterStat {
  restarts: number;
  lastError?: string;
  lastMessageAt?: number;
  lastRestartAt?: number;
  backoffMs: number;
  /** Epoch ms before which no restart is attempted. */
  nextRetryAt: number;
  /** Whether the adapter has ever successfully started (distinguishes crash vs never-up). */
  everStarted: boolean;
}

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
   * Optional gateway access policy (Feature 1). When set, every inbound message
   * is admission-checked BEFORE it reaches the interceptor, the per-peer queue,
   * or the handler: non-allowlisted senders are silently dropped and audit-
   * logged (never a reply — don't reveal the bot is alive), and admitted
   * messages get `isOwner` resolved onto them.
   */
  private accessPolicy: ChannelAccessPolicy | null = null;

  /** Crash-isolation supervisor state (Feature 1). */
  private readonly stats = new Map<ChannelType, AdapterStat>();
  private supervisorTimer: ReturnType<typeof setInterval> | null = null;
  private readonly supIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  /**
   * @param crossChannelMemory - Optional memory store.  When omitted the
   *   router behaves exactly as before: no persistence, no history injection.
   * @param opts - Optional supervisor tuning.
   */
  constructor(crossChannelMemory?: CrossChannelMemory | null, opts?: RouterOptions) {
    this.crossChannelMemory = crossChannelMemory ?? null;
    this.supIntervalMs = opts?.supervisor?.intervalMs ?? 15_000;
    this.baseBackoffMs = opts?.supervisor?.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = opts?.supervisor?.maxBackoffMs ?? 300_000;
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
    this.stats.set(adapter.channel, { restarts: 0, backoffMs: this.baseBackoffMs, nextRetryAt: 0, everStarted: false });
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
   * Install the gateway access policy (owner allowlist). See {@link accessPolicy}.
   */
  setAccessPolicy(policy: ChannelAccessPolicy): void {
    this.accessPolicy = policy;
    log.info({ active: policy.active }, 'channel access policy installed');
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

    // Crash-isolation: each start is independent (one failure never blocks
    // another), and failures schedule a supervised backoff retry rather than
    // being logged-and-forgotten.
    await Promise.allSettled(entries.map(([channel, adapter]) => this._startAdapter(channel, adapter)));

    // Supervisor: periodically restart any adapter that failed to start or
    // dropped after connecting, with per-adapter exponential backoff.
    if (!this.supervisorTimer && this.supIntervalMs > 0) {
      this.supervisorTimer = setInterval(() => void this.runSupervisorTick(), this.supIntervalMs);
      if (typeof this.supervisorTimer.unref === 'function') this.supervisorTimer.unref();
      log.info({ intervalMs: this.supIntervalMs }, 'channel supervisor started');
    }
  }

  /**
   * Stop the supervisor and all registered adapters concurrently.
   */
  async stopAll(): Promise<void> {
    if (this.supervisorTimer) { clearInterval(this.supervisorTimer); this.supervisorTimer = null; }
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
  // Crash-isolation supervisor (Feature 1)
  // ---------------------------------------------------------------------------

  /** Start one adapter, recording success/failure + scheduling backoff on error. */
  private async _startAdapter(channel: ChannelType, adapter: ChannelAdapter): Promise<void> {
    const stat = this.stats.get(channel);
    try {
      await adapter.start();
      if (stat) { stat.backoffMs = this.baseBackoffMs; stat.nextRetryAt = 0; stat.everStarted = true; delete stat.lastError; }
      log.info({ channel }, 'adapter started');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (stat) { stat.lastError = msg; stat.nextRetryAt = this._nowMs() + stat.backoffMs; stat.backoffMs = Math.min(stat.backoffMs * 2, this.maxBackoffMs); }
      log.error({ channel, err: msg, retryInMs: stat?.backoffMs }, 'adapter failed to start — backoff retry scheduled');
    }
  }

  /**
   * One supervisor pass: for each adapter that is not connected and past its
   * backoff window, attempt a restart. A crash in one adapter never touches the
   * others (each is independent + errors are contained).
   */
  async runSupervisorTick(nowMs: number = this._nowMs()): Promise<void> {
    for (const [channel, adapter] of this.adapters.entries()) {
      if (adapter.isConnected) continue;
      const stat = this.stats.get(channel);
      if (!stat || nowMs < stat.nextRetryAt) continue;
      stat.restarts += 1;
      stat.lastRestartAt = nowMs;
      log.warn({ channel, restarts: stat.restarts }, 'supervisor: adapter down — restarting');
      try { await adapter.stop(); } catch { /* stop must not throw; ignore */ }
      await this._startAdapter(channel, adapter);
    }
  }

  /** Overridable clock for deterministic tests. */
  protected _nowMs(): number {
    return Date.now();
  }

  /** Per-channel health snapshot (Feature 1 — channel.health / self-diagnostics). */
  health(): ChannelHealth[] {
    return [...this.adapters.entries()].map(([channel, adapter]) => {
      const s = this.stats.get(channel);
      return {
        channel,
        connected: adapter.isConnected,
        restarts: s?.restarts ?? 0,
        ...(s?.lastError ? { lastError: s.lastError } : {}),
        ...(s?.lastMessageAt ? { lastMessageAt: s.lastMessageAt } : {}),
        ...(s?.lastRestartAt ? { lastRestartAt: s.lastRestartAt } : {}),
      };
    });
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
    // Gateway admission gate (Feature 1): deny-by-default owner allowlist,
    // resolved BEFORE anything else. Non-allowlisted senders are silently
    // dropped (no reply — never reveal the bot is alive) and audit-logged.
    if (this.accessPolicy && this.accessPolicy.active) {
      let decision;
      try {
        decision = this.accessPolicy.resolve(msg.channel, msg.peerId);
      } catch (err) {
        // Fail OPEN on policy bugs would defeat the security purpose; fail CLOSED
        // but audit loudly so a broken policy is noticed, not silently bypassed.
        log.error({ channel: msg.channel, peerId: msg.peerId, err }, 'access policy threw — denying (fail closed)');
        return Promise.resolve();
      }
      if (!decision.admit) {
        log.warn(
          { audit: 'channel-admission-denied', channel: msg.channel, peerId: msg.peerId, peerName: msg.peerName, reason: decision.reason },
          'AUDIT: channel admission DENIED — message dropped',
        );
        return Promise.resolve();
      }
      // Stamp the resolved owner flag for downstream owner-gated behaviour.
      (msg as UnifiedMessage).isOwner = decision.isOwner;
    }

    // Health: record last inbound activity for channel.health / diagnostics.
    const stat = this.stats.get(msg.channel);
    if (stat) stat.lastMessageAt = this._nowMs();

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

// ---------------------------------------------------------------------------
// Module singleton — boot registers the live gateway router so tools (e.g.
// channel.health) and self-diagnostics can read channel health without threading
// the instance through every call site. Null until an extra-channel gateway is
// wired (e.g. prod with only Telegram, which runs its own bespoke path).
// ---------------------------------------------------------------------------

let _globalMessageRouter: MessageRouter | null = null;

export function setGlobalMessageRouter(router: MessageRouter | null): void {
  _globalMessageRouter = router;
}

export function getGlobalMessageRouter(): MessageRouter | null {
  return _globalMessageRouter;
}
