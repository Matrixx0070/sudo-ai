/**
 * @file message-coalescer.ts
 * @description Inbound-message debounce/coalesce with a foreground-reply fence,
 * plus group-chat mention gating.
 *
 * Problem: chat users send bursts ("wait", "actually", "do X instead") that each
 * spawn a separate agent turn, and messages arriving while the agent is already
 * composing a reply spawn interleaved turns the user perceives as the bot
 * "talking over" them.
 *
 * MessageCoalescer solves both with one mechanism, keyed per chat
 * (`channel:peerId`):
 *  - Debounce: messages are buffered until the chat goes idle for `debounceMs`,
 *    then delivered as ONE combined message (texts joined by newlines).
 *  - Foreground-reply fence: while a delivery is in flight, new messages are
 *    held behind the fence and flushed as the NEXT combined turn when the
 *    in-flight delivery completes — never interleaved.
 *
 * The fence only works if `deliver` resolves when the agent turn fully
 * completes (reply sent), so callers must await the turn inside deliver.
 */

import type { UnifiedMessage } from './types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:coalescer');

const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_MAX_BUFFERED = 20;

export interface CoalescerOptions {
  /** Idle window before a buffered batch is delivered. Default 1000 ms. */
  debounceMs?: number;
  /** Max buffered messages per chat before delivery is forced. Default 20. */
  maxBuffered?: number;
  /**
   * Deliver one combined message. Must resolve only when the agent turn is
   * fully complete — the foreground-reply fence holds new messages until then.
   * Rejections are caught and logged; buffered messages still flush afterwards.
   */
  deliver: (msg: UnifiedMessage) => Promise<void>;
}

interface ChatState {
  buffer: UnifiedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  delivering: boolean;
  /** Resolves when the in-flight delivery (if any) settles; drain() awaits it. */
  inflight: Promise<void> | null;
}

/**
 * Merge a burst of messages from one chat into a single UnifiedMessage.
 * Metadata (id, timestamp, replyToId…) comes from the LAST message; texts are
 * newline-joined in arrival order; media lists are concatenated.
 */
export function combineMessages(msgs: UnifiedMessage[]): UnifiedMessage {
  if (msgs.length === 0) throw new Error('combineMessages: empty batch');
  if (msgs.length === 1) return msgs[0]!;

  const last = msgs[msgs.length - 1]!;
  const media = msgs.flatMap((m) => m.media ?? []);
  return {
    ...last,
    // text is typed as string but adapters may pass undefined for media-only
    // messages, so guard like isAddressedToBot does.
    text: msgs.map((m) => m.text ?? '').filter((t) => t.length > 0).join('\n'),
    ...(media.length > 0 ? { media } : {}),
  };
}

/**
 * Group-chat mention gating: should this inbound message be handled at all?
 *
 * - DMs are always handled.
 * - Group messages are handled only when the text mentions one of the bot's
 *   names (`@name`, case-insensitive). Reply-to-bot detection is not possible
 *   here (adapters do not track which platform message IDs are the bot's), so
 *   replies without a mention are gated like any other group message.
 * - With no known bot names, gating is skipped (fail-open) — better to answer
 *   than to go silent in every group.
 */
export function isAddressedToBot(msg: UnifiedMessage, botNames: string[]): boolean {
  if (msg.chatType !== 'group') return true;
  const names = botNames.map((n) => n.replace(/^@/, '').trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return true;
  const text = (msg.text ?? '').toLowerCase();
  return names.some((name) => text.includes(`@${name}`));
}

/**
 * Per-chat debounce/coalesce buffer with a foreground-reply fence.
 *
 * Usage:
 * ```ts
 * const coalescer = new MessageCoalescer({ deliver: handleTurn });
 * adapter.onMessage(async (msg) => coalescer.push(msg));
 * ```
 */
export class MessageCoalescer {
  private readonly debounceMs: number;
  private readonly maxBuffered: number;
  private readonly deliver: (msg: UnifiedMessage) => Promise<void>;
  private readonly chats = new Map<string, ChatState>();

  constructor(opts: CoalescerOptions) {
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.maxBuffered = Math.max(1, opts.maxBuffered ?? DEFAULT_MAX_BUFFERED);
    this.deliver = opts.deliver;
  }

  /** Buffer an inbound message; schedules (or defers) its delivery. */
  push(msg: UnifiedMessage): void {
    const key = `${msg.channel}:${msg.peerId}`;
    let state = this.chats.get(key);
    if (!state) {
      state = { buffer: [], timer: null, delivering: false, inflight: null };
      this.chats.set(key, state);
    }

    state.buffer.push(msg);

    // Fence: a turn is in flight for this chat — hold until it completes.
    if (state.delivering) {
      log.debug({ key, held: state.buffer.length }, 'Message held behind reply fence');
      return;
    }

    if (state.buffer.length >= this.maxBuffered) {
      this.clearTimer(state);
      void this.flush(key);
      return;
    }

    this.clearTimer(state);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flush(key);
    }, this.debounceMs);
  }

  /** Number of chats with buffered or in-flight work (introspection/tests). */
  get pendingChats(): number {
    return this.chats.size;
  }

  /**
   * Flush every buffered batch now and wait for deliveries (shutdown/tests).
   * Loops until quiescent: messages held behind an in-flight fence during one
   * pass get their own delivery in the next, so nothing is dropped.
   */
  async drain(): Promise<void> {
    for (;;) {
      // Prune chats that finished while keeping the Map from growing forever.
      for (const [key, s] of this.chats) {
        if (!s.delivering && s.buffer.length === 0 && s.timer === null) this.chats.delete(key);
      }

      const busy = [...this.chats.entries()].filter(
        ([, s]) => s.delivering || s.buffer.length > 0,
      );
      if (busy.length === 0) return;

      await Promise.all(busy.map(async ([key, state]) => {
        this.clearTimer(state);
        if (state.inflight) await state.inflight;
        await this.flush(key);
      }));
    }
  }

  private clearTimer(state: ChatState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private async flush(key: string): Promise<void> {
    const state = this.chats.get(key);
    if (!state || state.delivering || state.buffer.length === 0) return;

    const batch = state.buffer.splice(0);
    state.delivering = true;
    const delivery = (async () => {
      try {
        await this.deliver(combineMessages(batch));
      } catch (err) {
        log.warn({ key, batchSize: batch.length, err: String(err) }, 'Coalesced delivery failed');
      }
    })();
    state.inflight = delivery;
    try {
      await delivery;
    } finally {
      state.delivering = false;
      state.inflight = null;
      if (state.buffer.length > 0) {
        // Messages arrived behind the fence — they form the next turn.
        void this.flush(key);
      } else if (state.timer === null) {
        this.chats.delete(key);
      }
    }
  }
}
