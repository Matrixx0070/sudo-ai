/**
 * @file durable-outbox.ts — GW-15 integration seam
 *
 * Wraps the process-wide channel-outbox so that (opt-in, SUDO_OUTBOX_DURABLE=1)
 * text deliveries for a channel are persisted in the {@link DeliveryQueue} and
 * drained by a background poll loop with ack/claim semantics and crash recovery,
 * instead of a fire-and-forget direct send.
 *
 * Wired for Telegram first (its throttling + the #751 incident history); the
 * interface is channel-generic. Media-bearing sends fall through to the raw
 * sender (the durable path is text-only in this slice) so nothing is dropped.
 *
 * Default OFF → prod behavior is unchanged unless the operator sets the flag.
 * The poll loop declares a per-run drain cap (budget, invariant #10): pure-local
 * SQLite + a platform send per delivery, zero LLM calls.
 */

import type { OutboundSender, } from './channel-outbox.js';
import type { SendOptions } from './types.js';
import { DeliveryQueue, defaultClassifier, type DeliverFn, type DeliveryClass, type DeliveryQueueOptions } from './delivery-queue.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:durable-outbox');

/** Max deliveries drained per poll tick (per-run budget). */
export const DEFAULT_DRAIN_CAP = 20;
/** Default poll cadence. */
export const DEFAULT_POLL_MS = 2000;

/**
 * grammY-aware error classifier. Network failures (HttpError) never reached the
 * API → presend/retryable; a definitive 4xx API rejection → postsend/terminal;
 * a 429 rate-limit was NOT delivered → presend; 5xx / ambiguous → unknown.
 */
export function telegramClassifier(err: unknown): DeliveryClass {
  const name = (err as { name?: unknown } | null)?.name;
  const code = (err as { error_code?: unknown } | null)?.error_code;
  if (name === 'HttpError') return 'presend';
  if (typeof code === 'number') {
    if (code === 429) return 'presend';
    if (code >= 400 && code < 500) return 'postsend';
    return 'unknown';
  }
  return defaultClassifier(err);
}

export interface DurableOutboxDeps {
  /** The queue (usually backed by data/outbox.db). */
  queue: DeliveryQueue;
  /** The channel this durable path serves (e.g. 'telegram'). */
  channel: string;
  /** Raw platform send — MUST be the real adapter send, not the outbox wrapper. */
  rawSend: (peer: string, text: string, options?: SendOptions) => Promise<void>;
  /** Bind of registerOutboundSender(channel, …) so enqueue replaces direct send. */
  registerWrapper: (send: OutboundSender) => void;
  /** Poll cadence (ms). Default 2000. */
  pollMs?: number;
  /** Max drained per tick. Default 20. */
  drainCap?: number;
}

export interface DurableOutboxHandle {
  /** Drain up to drainCap deliveries now (also used by tests). */
  drainOnce: () => Promise<number>;
  /** Stop the poll loop. */
  stop: () => void;
}

/**
 * Install the durable outbox for one channel: run boot recovery, register the
 * enqueue wrapper, and start the drain loop. Returns a handle to stop it.
 */
export function installDurableOutbox(deps: DurableOutboxDeps): DurableOutboxHandle {
  const { queue, channel, rawSend, registerWrapper } = deps;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const drainCap = deps.drainCap ?? DEFAULT_DRAIN_CAP;

  const recovery = queue.recover();
  log.info({ channel, ...recovery }, 'durable outbox boot recovery complete');

  // Enqueue wrapper: text → queue; media-bearing sends bypass to raw (this slice
  // is text-only) so an attachment is never silently dropped.
  registerWrapper(async (peer: string, text: string, options?: SendOptions) => {
    if (options?.media?.length) {
      await rawSend(peer, text, options);
      return;
    }
    queue.enqueue({ channel, account: 'default', peer, text });
  });

  const deliver: DeliverFn = async (d) => { await rawSend(d.peer, d.text); };

  let draining = false;
  const drainOnce = async (): Promise<number> => {
    if (draining) return 0;
    draining = true;
    let sent = 0;
    try {
      for (let i = 0; i < drainCap; i++) {
        const state = await queue.dispatchOne(deliver);
        if (state === null) break; // nothing eligible
        sent += 1;
      }
    } finally {
      draining = false;
    }
    return sent;
  };

  const timer = setInterval(() => {
    void drainOnce().catch((err: unknown) => log.warn({ err: String(err) }, 'durable outbox drain error'));
  }, pollMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    drainOnce,
    stop: () => clearInterval(timer),
  };
}

/** Convenience: default queue options wiring the telegram classifier + alert. */
export function telegramQueueOptions(onAlert?: DeliveryQueueOptions['onAlert']): DeliveryQueueOptions {
  return { classify: telegramClassifier, ...(onAlert ? { onAlert } : {}) };
}
