/**
 * @file core/viewport.ts
 * @description Owner-DM-guarded screen-frame streaming for the Computer Use
 * Backend, modelled on browser-viewport.ts.
 *
 * PRIVACY GUARD (non-negotiable, same rule as the browser viewport): frames are
 * emitted ONLY when the recipient is the VERIFIED OWNER **and** the chat is a
 * DM — never a group, never a non-owner, and never when the feature flag is off.
 * A screen feed can expose anything on the display; leaking it anywhere else is
 * a privacy breach, so the guard is enforced defensively here regardless of what
 * the caller passes.
 */

import { createLogger } from '../../../../shared/logger.js';
import type { PerceptionService } from './perception.js';

const log = createLogger('computer:viewport');

/** Feature flag — default OFF. */
const FLAG = 'SUDO_COMPUTER_VIEWPORT';

export interface ViewportContext {
  /** True only when the turn is attributable to the verified owner. */
  isOwner: boolean;
  /** Chat type of the recipient; must be 'dm' to stream. */
  chatType?: string;
}

/** Sink that actually delivers a frame (e.g. edits a Telegram photo bubble). */
export type FrameSink = (pngBase64: string, seq: number) => Promise<void>;

/**
 * Decide whether streaming is permitted. Exposed for testing and reuse.
 * ALL of: flag on, owner verified, DM chat.
 */
export function viewportAllowed(ctx: ViewportContext): boolean {
  if (process.env[FLAG] !== '1') return false;
  if (!ctx.isOwner) return false;
  if (ctx.chatType !== 'dm') return false;
  return true;
}

export interface ViewportOptions {
  display: string;
  perception: PerceptionService;
  sink: FrameSink;
  /** Minimum ms between frames. Default 2500 (matches the browser viewport cadence). */
  minIntervalMs?: number;
}

/**
 * Streams periodic frames while active. Call `frame()` opportunistically (e.g.
 * after each action); it self-throttles and no-ops entirely if the guard fails.
 */
export class ViewportStreamer {
  private lastAt = 0;
  private readonly minInterval: number;
  private stopped = false;

  constructor(private readonly ctx: ViewportContext, private readonly opts: ViewportOptions) {
    this.minInterval = opts.minIntervalMs ?? 2500;
  }

  get active(): boolean {
    return !this.stopped && viewportAllowed(this.ctx);
  }

  /** Emit a frame if allowed and the throttle window has elapsed. */
  async frame(): Promise<boolean> {
    if (!this.active) return false;
    const now = Date.now();
    if (now - this.lastAt < this.minInterval) return false;
    this.lastAt = now;
    try {
      const snap = await this.opts.perception.capture(this.opts.display);
      await this.opts.sink(snap.screenshot, snap.seq);
      return true;
    } catch (e) {
      log.debug({ err: String(e) }, 'viewport frame failed (non-fatal)');
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
