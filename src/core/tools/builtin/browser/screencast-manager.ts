/**
 * @file screencast-manager.ts
 * @description Watch/takeover core (Spec 3, step 4). Drives a CDP screencast on
 * a running profile's active page and fans JPEG frames out to admin viewers as
 * an MJPEG stream (multipart/x-mixed-replace — renders live in an <img>). Also
 * holds the per-profile TAKEOVER lock (owner drives; agent pauses) and exposes
 * the CDP session so the admin panel can inject real mouse/key input.
 *
 * Keyed by profile name. Time-throttled to a target fps so a busy page can't
 * flood the socket. Best-effort throughout — a dead subscriber never breaks the
 * cast, a cast failure never breaks the browser.
 */

import type { ServerResponse } from 'node:http';
import type { CDPSession, Page } from 'playwright-core';
import { BrowserManager } from './browser-manager.js';
import { resolveActivePage } from './active-page.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('browser:screencast');

const MJPEG_BOUNDARY = 'sudoframe';
const DEFAULT_FPS = 3;

interface Cast {
  name: string;
  page: Page;
  session: CDPSession;
  latest: Buffer | null;
  subscribers: Set<ServerResponse>;
  takeover: boolean;
  minIntervalMs: number;
  lastSentMs: number;
  /** page dimensions from the last frame metadata (for input coord scaling). */
  deviceWidth: number;
  deviceHeight: number;
  /** screencast params kept so a crash re-attach uses the same settings. */
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

export interface WatchOptions { fps?: number; quality?: number; maxWidth?: number; maxHeight?: number }

class ScreencastManager {
  private static _i: ScreencastManager | null = null;
  private casts = new Map<string, Cast>();
  static getInstance(): ScreencastManager { return (this._i ??= new ScreencastManager()); }

  isActive(name: string): boolean { return this.casts.has(name); }
  list(): Array<{ name: string; viewers: number; takeover: boolean }> {
    return Array.from(this.casts.values()).map((c) => ({ name: c.name, viewers: c.subscribers.size, takeover: c.takeover }));
  }
  latestFrame(name: string): Buffer | null { return this.casts.get(name)?.latest ?? null; }
  getSession(name: string): CDPSession | null { return this.casts.get(name)?.session ?? null; }
  /** The live page — used to inject owner input during takeover (Playwright-native). */
  getPage(name: string): Page | null { return this.casts.get(name)?.page ?? null; }
  frameSize(name: string): { w: number; h: number } | null {
    const c = this.casts.get(name);
    return c && c.deviceWidth ? { w: c.deviceWidth, h: c.deviceHeight } : null;
  }

  /** Start a screencast on a running profile. Throws if the profile isn't launched. */
  async start(name: string, opts: WatchOptions = {}): Promise<void> {
    if (this.casts.has(name)) return;
    const inst = BrowserManager.getInstance().get(name);
    if (!inst) throw new Error(`browser profile "${name}" is not running — launch it first`);
    const page = await resolveActivePage(inst);
    const fps = Math.max(1, Math.min(10, opts.fps ?? DEFAULT_FPS));
    const cast: Cast = {
      name, page, session: undefined as unknown as CDPSession, latest: null, subscribers: new Set(),
      takeover: false, minIntervalMs: Math.floor(1000 / fps), lastSentMs: 0,
      deviceWidth: 0, deviceHeight: 0,
      quality: Math.max(20, Math.min(90, opts.quality ?? 55)),
      maxWidth: opts.maxWidth ?? 1280, maxHeight: opts.maxHeight ?? 800,
    };
    this.casts.set(name, cast);
    await this._attach(cast, page);
    log.info({ name, fps }, 'Screencast started');
  }

  /** Wire a CDP screencast onto `page` for this cast (shared by start + re-attach). */
  private async _attach(cast: Cast, page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    cast.page = page;
    cast.session = session;
    cast.lastSentMs = 0;
    session.on('Page.screencastFrame', (ev: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
      // Ack every frame promptly (else Chromium stops sending), but only
      // store/broadcast at the target fps.
      session.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => { /* detached */ });
      if (ev.metadata?.deviceWidth) { cast.deviceWidth = ev.metadata.deviceWidth; cast.deviceHeight = ev.metadata.deviceHeight ?? 0; }
      const now = Date.now();
      if (now - cast.lastSentMs < cast.minIntervalMs) return;
      cast.lastSentMs = now;
      try {
        const buf = Buffer.from(ev.data, 'base64');
        cast.latest = buf;
        this._broadcast(cast, buf);
      } catch { /* bad frame — skip */ }
    });
    await session.send('Page.startScreencast', {
      format: 'jpeg', quality: cast.quality, maxWidth: cast.maxWidth, maxHeight: cast.maxHeight, everyNthFrame: 1,
    });
  }

  /**
   * GAP 2: after a crash auto-relaunch the old CDP session is dead. If this
   * profile was being watched, re-attach the screencast to the fresh context's
   * active page — KEEPING existing MJPEG subscribers + the takeover flag so the
   * owner's live view resumes without reconnecting. No-op if not watched.
   */
  async reattachAfterRelaunch(name: string): Promise<boolean> {
    const cast = this.casts.get(name);
    if (!cast) return false;
    const inst = BrowserManager.getInstance().get(name);
    if (!inst) return false;
    try { await cast.session.detach(); } catch { /* already dead */ }
    const page = await resolveActivePage(inst);
    await this._attach(cast, page);
    log.info({ name, viewers: cast.subscribers.size }, 'Screencast re-attached after crash-relaunch');
    return true;
  }

  async stop(name: string): Promise<boolean> {
    const c = this.casts.get(name);
    if (!c) return false;
    try { await c.session.send('Page.stopScreencast'); } catch { /* already gone */ }
    try { await c.session.detach(); } catch { /* already detached */ }
    for (const res of c.subscribers) { try { res.end(); } catch { /* closed */ } }
    this.casts.delete(name);
    log.info({ name }, 'Screencast stopped');
    return true;
  }

  /** Register an MJPEG subscriber (an admin <img>). Caller must NOT have sent a body yet. */
  subscribeMJPEG(name: string, res: ServerResponse): boolean {
    const c = this.casts.get(name);
    if (!c) return false;
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store',
      Connection: 'close',
      Pragma: 'no-cache',
    });
    c.subscribers.add(res);
    if (c.latest) this._writeFrame(res, c.latest);
    const drop = () => { c.subscribers.delete(res); };
    res.on('close', drop);
    res.on('error', drop);
    log.info({ name, viewers: c.subscribers.size }, 'MJPEG viewer attached');
    return true;
  }

  // --- takeover lock -------------------------------------------------------
  setTakeover(name: string, on: boolean): boolean {
    const c = this.casts.get(name);
    if (!c) return false;
    c.takeover = on;
    log.info({ name, takeover: on }, on ? 'Owner took over browser' : 'Owner handed browser back');
    return true;
  }
  /** True when the OWNER holds the browser — agent interaction tools must pause. */
  isTakenOver(name: string): boolean { return this.casts.get(name)?.takeover ?? false; }

  private _broadcast(c: Cast, buf: Buffer): void {
    for (const res of c.subscribers) this._writeFrame(res, buf);
  }
  private _writeFrame(res: ServerResponse, buf: Buffer): void {
    try {
      res.write(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    } catch { /* subscriber gone — the close handler removes it */ }
  }
}

export const screencastManager = ScreencastManager.getInstance();
