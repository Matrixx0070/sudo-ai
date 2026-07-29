/**
 * @file browser-viewport.ts
 * @description TX11 — live browser viewport for the Telegram working card
 * (SUDO_TG_BROWSER_VIEW=1, default OFF). While the agent runs `browser.*`
 * tools, a SEPARATE photo message ("viewport bubble") is sent next to the
 * working card and edited in place (editMessageMedia) with fresh screencast
 * frames at a ~3s cadence — an animated view of the agent actually browsing.
 *
 * Design notes (why a separate message): a Telegram TEXT message can never
 * become a photo — editMessageMedia only works on a message that already
 * carries media. The working card is a text bubble (BufferedEditSink), so the
 * viewport lives in its own photo bubble alongside it.
 *
 * PRIVACY GUARD (non-negotiable): the agent's browser may hold logged-in
 * sessions and sensitive pages. Frames are only ever sent when `allowed` is
 * true, which the caller must derive from BOTH conditions: the peer is an
 * OWNER (`ownerUsers`) AND the chat is a DM (`msg.chatType === 'dm'`). Never
 * a group, never a non-owner. The module enforces the flag defensively: with
 * `allowed:false` nothing is ever sent, started, or stopped.
 *
 * Ownership: if a screencast is already active on the profile (e.g. an admin
 * is watching via /admin MJPEG), it is REUSED and never stopped at turn end.
 * Only a cast this instance started is stopped in `finish()`.
 *
 * Everything is best-effort/fail-open: no error here may fail or slow a turn.
 * All Telegram + screencast calls are injected so the module unit-tests with
 * fakes (no grammy / CDP / playwright imports).
 */

import { createHash } from 'node:crypto';

/** Injected subset of the screencast manager (see browser/screencast-manager.ts). */
export interface ViewportScreencast {
  isActive(name: string): boolean;
  start(name: string, opts: { fps?: number; quality?: number; maxWidth?: number; maxHeight?: number }): Promise<void>;
  stop(name: string): Promise<unknown>;
  latestFrame(name: string): Buffer | null;
  /** Current page URL for the caption — must not throw; null when unknown. */
  pageUrl?(name: string): string | null;
}

export interface BrowserViewportOptions {
  /**
   * PRIVACY GUARD: true ONLY for owner + DM (see file header). False → the
   * viewport is fully inert: no sends, no screencast starts, no teardown work.
   */
  allowed: boolean;
  /** SUDO_TG_BROWSER_VIEW_KEEP=1 — keep the final frame instead of deleting the bubble. */
  keepFinal?: boolean;
  /** Refresh cadence (default 3000 ms). Also the minimum gap between edits. */
  intervalMs?: number;
  screencast: ViewportScreencast;
  /** Names of currently running browser profiles (BrowserManager.list()). */
  listRunning: () => string[];
  /** Send the first frame as a NEW photo message; resolves to its message id. */
  sendPhoto: (frame: Buffer, caption?: string) => Promise<string | number>;
  /** Edit the existing photo message in place (editMessageMedia). */
  editPhoto: (messageId: string | number, frame: Buffer, caption?: string) => Promise<void>;
  /** Best-effort delete of the viewport bubble (teardown default). */
  deleteMessage: (messageId: string | number) => Promise<void>;
  /** Clock seam for tests. */
  now?: () => number;
  /** Timer seam for tests. Defaults to a real unref'd setInterval. */
  scheduler?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  /** Optional error sink (e.g. log.debug). Never called with throw semantics. */
  onError?: (context: string, err: unknown) => void;
}

/** Modest preview settings — this is a live preview, not a video feed. */
const CAST_OPTS = { fps: 2, quality: 50, maxWidth: 1280, maxHeight: 800 } as const;
const DEFAULT_INTERVAL_MS = 3000;
const CAPTION_MAX = 200;

const defaultScheduler = {
  set(fn: () => void, ms: number): unknown {
    const h = setInterval(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear(handle: unknown): void {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * One per Telegram turn. Lifecycle:
 *   onBrowserTool(args.browser)  — first `browser.*` tool arms the refresh loop
 *   tick()                        — resolve profile → ensure cast → send/edit frame
 *   finish()                      — stop timer, stop OUR cast only, delete-or-keep bubble
 */
export class BrowserViewport {
  private readonly opts: BrowserViewportOptions;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly scheduler: NonNullable<BrowserViewportOptions['scheduler']>;

  private profile: string | null = null;
  private profileHint: string | null = null;
  private startedByUs = false;
  private messageId: string | number | null = null;
  private lastFrameKey: string | null = null;
  private lastEditMs = 0;
  private timer: unknown = null;
  private finished = false;
  /** In-flight refresh, shared by concurrent tick() callers (see tick()). */
  private inFlight: Promise<void> | null = null;

  constructor(opts: BrowserViewportOptions) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.scheduler = opts.scheduler ?? defaultScheduler;
  }

  /**
   * Called on every agent `tool-call` event whose name starts with `browser.`.
   * `browserArg` is the tool's `browser` param when the model passed one —
   * the strongest signal for WHICH profile this turn is actually driving.
   * Lazily arms the refresh timer on the first browser tool of the turn.
   */
  onBrowserTool(browserArg?: unknown): Promise<void> {
    if (!this.opts.allowed || this.finished) return Promise.resolve(); // privacy gate + lifecycle
    if (typeof browserArg === 'string' && browserArg.length > 0) this.profileHint = browserArg;
    if (this.timer === null) {
      this.timer = this.scheduler.set(() => { void this.tick(); }, this.intervalMs);
    }
    // Opportunistic immediate refresh (throttled inside). The promise is
    // returned so callers CAN await the refresh; cli.ts fires it with `void`.
    return this.tick();
  }

  /**
   * One refresh step, fully fail-open — every failure is swallowed via onError
   * and retried on the next tick.
   *
   * Serialized by returning the IN-FLIGHT promise rather than a no-op: an
   * early-return here would make a tick that lands during another tick appear
   * complete while the real work was still pending, so an awaiting caller
   * could observe pre-send state.
   */
  tick(): Promise<void> {
    if (!this.opts.allowed || this.finished) return Promise.resolve();
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this._tickOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async _tickOnce(): Promise<void> {
    try {
      const profile = this.resolveProfile();
      if (profile === null) return;

      // Ensure a screencast exists. Reuse an already-active cast (admin may be
      // watching) — we only ever stop a cast WE started (see finish()).
      if (!this.opts.screencast.isActive(profile)) {
        await this.opts.screencast.start(profile, CAST_OPTS);
        this.startedByUs = true;
      }

      const frame = this.opts.screencast.latestFrame(profile);
      if (!frame || frame.length === 0) return;

      // Throttle: at most one Telegram edit per interval (immediate ticks from
      // tool events share this gate with the timer).
      if (this.messageId !== null && this.now() - this.lastEditMs < this.intervalMs) return;

      // Skip unchanged frames — Telegram 400s on "message is not modified"
      // and identical uploads waste bandwidth.
      const key = createHash('sha1').update(frame).digest('hex');
      if (key === this.lastFrameKey) return;

      const caption = this.buildCaption(profile);
      if (this.messageId === null) {
        this.messageId = await this.opts.sendPhoto(frame, caption);
      } else {
        await this.opts.editPhoto(this.messageId, frame, caption);
      }
      this.lastFrameKey = key;
      this.lastEditMs = this.now();
    } catch (err) {
      this.opts.onError?.('viewport tick', err);
    }
  }

  /**
   * Turn teardown (call from the turn's finally). Idempotent, never throws.
   * Stops the refresh timer, stops the screencast ONLY if we started it, and
   * deletes the viewport bubble unless keepFinal (SUDO_TG_BROWSER_VIEW_KEEP=1).
   */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer !== null) {
      try { this.scheduler.clear(this.timer); } catch { /* best effort */ }
      this.timer = null;
    }
    if (this.startedByUs && this.profile !== null) {
      try { await this.opts.screencast.stop(this.profile); } catch (err) { this.opts.onError?.('viewport stop cast', err); }
    }
    if (this.messageId !== null && !this.opts.keepFinal) {
      try { await this.opts.deleteMessage(this.messageId); } catch (err) { this.opts.onError?.('viewport delete bubble', err); }
    }
  }

  /** Exposed for tests/wiring introspection. */
  get viewportMessageId(): string | number | null { return this.messageId; }
  get startedCast(): boolean { return this.startedByUs; }

  /**
   * Which profile to preview. Prefer the profile the turn's tools actually
   * named (`browser` tool arg, default "default"); fall back to the single
   * running profile; with zero or several running and no matching hint, no-op
   * (retry next tick — the tool may still be launching the browser).
   */
  private resolveProfile(): string | null {
    if (this.profile !== null) return this.profile;
    let running: string[];
    try { running = this.opts.listRunning(); } catch { return null; }
    if (this.profileHint !== null && running.includes(this.profileHint)) this.profile = this.profileHint;
    else if (this.profileHint === null && running.includes('default')) this.profile = 'default'; // tools' implicit default
    else if (running.length === 1) this.profile = running[0]!;
    return this.profile;
  }

  /** Short page-URL caption; never throws, empty on any problem. */
  private buildCaption(profile: string): string | undefined {
    try {
      const url = this.opts.screencast.pageUrl?.(profile);
      if (typeof url === 'string' && url.length > 0 && url !== 'about:blank') {
        return url.length > CAPTION_MAX ? `${url.slice(0, CAPTION_MAX - 1)}…` : url;
      }
    } catch { /* caption is cosmetic */ }
    return undefined;
  }
}
