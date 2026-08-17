/**
 * @file core/perception.ts
 * @description PerceptionService — captures a fused {@link Snapshot} (screenshot
 * + windows + AX elements) for a display, plus zoom-crop and snapshot-diff.
 *
 * Hybrid perception, per the research: the AX tree (cheap, structured) is the
 * primary channel; the screenshot is always present as the universal fallback
 * and for vision grounding. Window geometry (wmctrl) both feeds grounding and
 * lets us intersect the session-global AX tree down to THIS display.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '../../../../shared/logger.js';
import type { Snapshot, UIElement, WindowInfo } from './types.js';
import type { IComputerDriver, DriverPlatform } from './driver.js';
import { createDriver } from './driver.js';

const execFileAsync = promisify(execFile);
const log = createLogger('computer:perception');

export interface PerceptionOptions {
  /** Include the AX channel. Default true. */
  accessibility?: boolean;
  /** Restrict AX elements to those intersecting this display's windows. Default true. */
  intersectWindows?: boolean;
  maxAxElements?: number;
  axTimeoutMs?: number;
  /** Platform driver (capture/axTree/windows). Defaults to the auto-detected driver. */
  driver?: IComputerDriver;
  /** Force a platform when auto-creating the driver. */
  platform?: DriverPlatform;
}

function pngDimensions(buf: Buffer): { width: number; height: number } {
  // PNG: 8-byte sig, then IHDR chunk; width/height are big-endian u32 at 16/20.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export class PerceptionService {
  private seq = 0;
  private cache = new Map<string, { snap: Snapshot; at: number }>();
  private driverPromise?: Promise<IComputerDriver>;

  constructor(private readonly opts: PerceptionOptions = {}) {}

  /** Resolve the platform driver (injected, or lazily auto-created once). */
  private getDriver(): Promise<IComputerDriver> {
    if (this.opts.driver) return Promise.resolve(this.opts.driver);
    if (!this.driverPromise) this.driverPromise = createDriver(this.opts.platform);
    return this.driverPromise;
  }

  /**
   * Return a recent snapshot for the display if one was captured within `ttlMs`,
   * else capture fresh. Speeds up read-only perception when the screen has not
   * been mutated since the last look. Invalidate after any action.
   */
  async captureCached(display: string, ttlMs = 400): Promise<Snapshot> {
    const hit = this.cache.get(display);
    if (hit && Date.now() - hit.at <= ttlMs) return hit.snap;
    const snap = await this.capture(display);
    this.cache.set(display, { snap, at: Date.now() });
    return snap;
  }

  /** Drop any cached snapshot for a display (call after a mutating action). */
  invalidate(display: string): void {
    this.cache.delete(display);
  }

  /** Capture a fused snapshot of the given display (delegates to the platform driver). */
  async capture(display: string): Promise<Snapshot> {
    const ts = Date.now();
    const seq = this.seq++;
    const driver = await this.getDriver();

    const [cap, windows] = await Promise.all([driver.capture(display), driver.windows(display)]);
    const png = cap.png;
    const width = cap.width || pngDimensions(png).width;
    const height = cap.height || pngDimensions(png).height;
    const hash = createHash('sha256').update(png).digest('hex');

    let elements: UIElement[] = [];
    let axAvailable = false;
    if (this.opts.accessibility !== false && driver.capabilities().accessibility) {
      elements = await driver.axTree(display);
      axAvailable = elements.length > 0;
      if (axAvailable && this.opts.intersectWindows !== false && windows.length > 0) {
        elements = this.filterToWindows(elements, windows);
      }
    }

    return { seq, ts, display, screenshot: png.toString('base64'), width, height, hash, elements, windows, axAvailable };
  }

  /** Crop a region [x,y,w,h] out of a snapshot's screenshot, upscaled 2x for legibility. */
  async zoom(snapshot: Snapshot, x: number, y: number, w: number, h: number): Promise<string> {
    const png = Buffer.from(snapshot.screenshot, 'base64');
    const dir = await mkdtemp(join(tmpdir(), 'cu-zoom-'));
    const src = join(dir, 'src.png');
    const out = join(dir, 'zoom.png');
    await writeFile(src, png);
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    const cx = Math.max(0, Math.round(x));
    const cy = Math.max(0, Math.round(y));
    // ImageMagick: crop then 2x resize (sharper reading of small UI regions).
    await execFileAsync('convert', [
      src,
      '-crop',
      `${cw}x${ch}+${cx}+${cy}`,
      '+repage',
      '-resize',
      '200%',
      out,
    ]);
    const zoomed = await readFile(out);
    return zoomed.toString('base64');
  }

  /** Cheap change test: do two snapshots differ visually? */
  static changed(before: Snapshot, after: Snapshot): boolean {
    return before.hash !== after.hash;
  }

  private filterToWindows(elements: UIElement[], windows: WindowInfo[]): UIElement[] {
    const rects = windows
      .filter((w) => w.w && w.h)
      .map((w) => ({ x: w.x ?? 0, y: w.y ?? 0, w: w.w ?? 0, h: w.h ?? 0 }));
    if (rects.length === 0) return elements;
    return elements.filter((e) => e.w > 0 && e.h > 0 && rects.some((r) => rectsIntersect(e, r)));
  }
}
