/**
 * @file steer-buffer.ts
 * @description GW-5 — per-session mid-run steer buffer.
 *
 * When a message arrives mid-turn and the session's queue mode is `steer`, the
 * text is pushed here instead of waiting for the whole ReACT turn to finish. The
 * agent loop drains this buffer at each safe iteration boundary (post-tool-exec,
 * pre-model-call) and appends the messages as user-role input with a `[mid-run]`
 * marker before building the next model request.
 *
 * Trust tier: every buffered message carries the effective trust tier the router
 * computed (min(run, steered)); the loop tags the injected content with it so a
 * steer can never upgrade a run. The router NEVER buffers a message that would
 * downgrade an owner run (untrusted steer → owner run) — that goes to followup.
 *
 * Overflow: cap of 20 buffered messages per session. When full, the two oldest
 * are coalesced into a single summarized line, capped at COALESCE_MAX_CHARS
 * chars. Coalescing never drops a whole message; a coalesced line longer than
 * the cap is truncated at the tail and the dropped char count is logged at WARN
 * (observable, not silent).
 *
 * Pure, in-memory, single-process. Keyed by the loop's sessionId so producer
 * (router/turn-handler) and consumer (loop) agree without extra plumbing.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:steer-buffer');

/** owner (2) is more trusted than untrusted (1). */
export type SteerTier = 'owner' | 'untrusted';
export const TIER_RANK: Record<SteerTier, number> = { untrusted: 1, owner: 2 };

/** The lower (less-trusted) of two tiers. */
export function minTier(a: SteerTier, b: SteerTier): SteerTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

export interface SteerMessage {
  text: string;
  /** Effective trust tier of this steer (already min(run, steered)). */
  tier: SteerTier;
  /** ms epoch pushed. */
  at: number;
  /** True when this entry is a coalesced summary of earlier overflow messages. */
  coalesced?: boolean;
}

export const STEER_BUFFER_CAP = 20;

/**
 * Max chars a coalesced overflow summary retains. Raised from the original 500
 * so sustained overflow keeps far more context; anything beyond this is trimmed
 * from the tail and the dropped count is logged (see coalesceOldest).
 */
export const COALESCE_MAX_CHARS = 2000;

export class SteerBuffer {
  private readonly buffers = new Map<string, SteerMessage[]>();
  private readonly cap: number;
  private readonly now: () => number;

  constructor(opts: { cap?: number; now?: () => number } = {}) {
    this.cap = opts.cap ?? STEER_BUFFER_CAP;
    this.now = opts.now ?? Date.now;
  }

  /** Push a steer message for a session. Overflow → coalesce oldest (never drop). */
  push(sessionId: string, text: string, tier: SteerTier): void {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    let buf = this.buffers.get(sessionId);
    if (!buf) { buf = []; this.buffers.set(sessionId, buf); }
    buf.push({ text: trimmed, tier, at: this.now() });
    if (buf.length > this.cap) this.coalesceOldest(sessionId, buf);
  }

  /** Merge the two oldest entries into a single summarized line to stay within cap. */
  private coalesceOldest(sessionId: string, buf: SteerMessage[]): void {
    const a = buf.shift();
    const b = buf.shift();
    if (!a || !b) return;
    // The summary inherits the LESS-trusted tier of the two (conservative).
    const tier = minTier(a.tier, b.tier);
    const full = `[${a.coalesced ? 'earlier steers' : '2 earlier steer messages'}] ${a.text} | ${b.text}`;
    const text = full.slice(0, COALESCE_MAX_CHARS);
    const droppedChars = full.length - text.length;
    const merged: SteerMessage = { text, tier, at: a.at, coalesced: true };
    buf.unshift(merged);
    if (droppedChars > 0) {
      log.warn(
        { sessionId, size: buf.length, droppedChars },
        'GW-5 steer buffer overflow — coalesced oldest and truncated tail past cap (observable)',
      );
    } else {
      log.warn({ sessionId, size: buf.length }, 'GW-5 steer buffer overflow — coalesced oldest (never dropped)');
    }
  }

  /** Number of buffered steer messages for a session. */
  size(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }

  /** Drain and return all buffered steer messages for a session (clears the buffer). */
  drain(sessionId: string): SteerMessage[] {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.length === 0) return [];
    this.buffers.delete(sessionId);
    return buf;
  }

  /** Discard a session's buffer without returning it (e.g. on run end). */
  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}

// --------------------------------------------------------------------------
// Process singleton — producer (turn handler) and consumer (loop) share one.
// --------------------------------------------------------------------------

let _singleton: SteerBuffer | null = null;
export function getSteerBuffer(): SteerBuffer {
  if (!_singleton) _singleton = new SteerBuffer();
  return _singleton;
}
export function __resetSteerBufferForTest(): void { _singleton = null; }
